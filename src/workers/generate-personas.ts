/**
 * generate-personas.ts
 *
 * BullMQ worker that computes user personas for a project by clustering
 * contacts based on their associated signal patterns, then generating
 * persona names and descriptions via OpenAI Chat Completions.
 *
 * Algorithm:
 * 1. Load all contacts for the project that have associated signals.
 *    - Active signals: via conversations → transcripts → signals (signal_kind = 'active')
 *    - Passive signals: signals where metadata contains contact attribution
 * 2. Build a signal profile per contact:
 *    - Collect signal types, pain intensities, wtp_signal flags, and segment_tags
 * 3. Cluster contacts by their segment_tags (as a proxy for signal-pattern grouping).
 *    Groups with ≥ 2 contacts are eligible for persona generation.
 * 4. For each eligible group, call OpenAI to generate:
 *    - Persona name and description
 *    - Primary pain points (list)
 *    - PMF likelihood (high / medium / low) based on average wtp_signal rate
 * 5. Store results in Redis under `personas:{projectId}` with a 24-hour TTL.
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4
 */

import { Worker, type Job } from "bullmq";
import OpenAI from "openai";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { contacts } from "@/db/schema/contacts";
import { conversations } from "@/db/schema/conversations";
import { transcripts } from "@/db/schema/transcripts";
import { signals } from "@/db/schema/signals";
import { projects } from "@/db/schema/projects";
import { redisConnection, type GeneratePersonasJobData } from "@/lib/queues";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ── Constants ─────────────────────────────────────────────────────────────────

/** Redis TTL for cached personas: 24 hours in seconds (Requirement 17.4) */
const PERSONAS_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** Minimum contacts per group to generate a persona (Requirement 17.1) */
const MIN_CONTACTS_PER_GROUP = 2;

/** Minimum contacts with signals before persona generation is attempted (Requirement 17.5) */
const MIN_CONTACTS_WITH_SIGNALS = 10;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContactSignalProfile {
  contactId: string;
  firstName: string;
  lastName: string | null;
  segmentTags: string[];
  signalTypes: string[];
  painIntensities: number[];
  wtpSignalCount: number;
  totalSignals: number;
}

export interface Persona {
  name: string;
  description: string;
  primaryPainPoints: string[];
  averagePainIntensity: number;
  pmfLikelihood: "high" | "medium" | "low";
  contactCount: number;
  segmentTags: string[];
}

export interface PersonaGenerationResult {
  projectId: string;
  personas: Persona[];
  contactsWithSignals: number;
  generatedAt: string;
  insufficientData: boolean;
}

// ── Data loading ──────────────────────────────────────────────────────────────

/**
 * Load all contacts for a project that have associated active signals
 * (via conversations → transcripts → signals).
 *
 * Returns a map of contactId → ContactSignalProfile.
 */
async function loadContactSignalProfiles(
  projectId: string,
): Promise<Map<string, ContactSignalProfile>> {
  const profileMap = new Map<string, ContactSignalProfile>();

  // ── Active signals: contact → conversation → transcript → signal ──────────
  // Join path: contacts → conversations → transcripts → signals
  // We collect pain_intensity from transcripts and signal types from signals.
  const activeRows = await db
    .select({
      contactId: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      segmentTags: contacts.segmentTags,
      signalType: signals.signalType,
      painIntensity: transcripts.painIntensity,
      wtpSignal: transcripts.wtpSignal,
    })
    .from(contacts)
    .innerJoin(conversations, eq(conversations.contactId, contacts.id))
    .innerJoin(transcripts, eq(transcripts.conversationId, conversations.id))
    .innerJoin(
      signals,
      and(
        eq(signals.projectId, projectId),
        eq(signals.signalKind, "active"),
        // Link signals to the conversation via source_url pattern or project scope.
        // Since active signals are created from transcripts and linked by project,
        // we join on project_id and filter by signal_kind = 'active'.
        // The transcript's conversation links back to the contact.
        sql`${signals.projectId} = ${projectId}`,
      ),
    )
    .where(
      and(
        eq(contacts.projectId, projectId),
        eq(conversations.projectId, projectId),
        eq(transcripts.projectId, projectId),
        sql`${transcripts.analyzedAt} IS NOT NULL`,
      ),
    );

  for (const row of activeRows) {
    const existing = profileMap.get(row.contactId);
    if (existing) {
      if (row.signalType && !existing.signalTypes.includes(row.signalType)) {
        existing.signalTypes.push(row.signalType);
      }
      if (row.painIntensity !== null && row.painIntensity !== undefined) {
        existing.painIntensities.push(row.painIntensity);
      }
      if (row.wtpSignal) {
        existing.wtpSignalCount += 1;
      }
      existing.totalSignals += 1;
    } else {
      profileMap.set(row.contactId, {
        contactId: row.contactId,
        firstName: row.firstName,
        lastName: row.lastName,
        segmentTags: row.segmentTags ?? [],
        signalTypes: row.signalType ? [row.signalType] : [],
        painIntensities:
          row.painIntensity !== null && row.painIntensity !== undefined
            ? [row.painIntensity]
            : [],
        wtpSignalCount: row.wtpSignal ? 1 : 0,
        totalSignals: 1,
      });
    }
  }

  // ── Passive signals with contact attribution ──────────────────────────────
  // Passive signals may have contact attribution stored in metadata as
  // { "contact_id": "uuid" }. We load these separately.
  const passiveRows = await db
    .select({
      signalId: signals.id,
      signalType: signals.signalType,
      painIntensity: signals.painIntensity,
      metadata: signals.metadata,
    })
    .from(signals)
    .where(
      and(
        eq(signals.projectId, projectId),
        eq(signals.signalKind, "passive"),
        sql`${signals.metadata}->>'contact_id' IS NOT NULL`,
      ),
    );

  for (const row of passiveRows) {
    const meta = row.metadata as Record<string, unknown> | null;
    const contactId = meta?.contact_id as string | undefined;
    if (!contactId) continue;

    const existing = profileMap.get(contactId);
    if (existing) {
      if (row.signalType && !existing.signalTypes.includes(row.signalType)) {
        existing.signalTypes.push(row.signalType);
      }
      if (row.painIntensity !== null && row.painIntensity !== undefined) {
        existing.painIntensities.push(row.painIntensity);
      }
      existing.totalSignals += 1;
    }
    // If the contact isn't already in the map (no active signals), load their
    // basic info and add them.
    else {
      const [contact] = await db
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          segmentTags: contacts.segmentTags,
        })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.projectId, projectId)))
        .limit(1);

      if (contact) {
        profileMap.set(contactId, {
          contactId: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          segmentTags: contact.segmentTags ?? [],
          signalTypes: row.signalType ? [row.signalType] : [],
          painIntensities:
            row.painIntensity !== null && row.painIntensity !== undefined
              ? [row.painIntensity]
              : [],
          wtpSignalCount: 0,
          totalSignals: 1,
        });
      }
    }
  }

  return profileMap;
}

// ── Clustering ────────────────────────────────────────────────────────────────

/**
 * Cluster contacts by their segment_tags.
 *
 * Strategy:
 * - Contacts with no segment tags are grouped under a synthetic "untagged" key.
 * - Contacts with multiple tags are assigned to the group of their first tag
 *   (alphabetically sorted for determinism). This keeps the clustering simple
 *   while still leveraging the segment taxonomy founders have already defined.
 * - Groups with fewer than MIN_CONTACTS_PER_GROUP contacts are merged into
 *   an "other" group (or discarded if the merged group is still too small).
 *
 * Returns a map of groupKey → ContactSignalProfile[].
 */
function clusterContactsBySegment(
  profiles: ContactSignalProfile[],
): Map<string, ContactSignalProfile[]> {
  const groups = new Map<string, ContactSignalProfile[]>();

  for (const profile of profiles) {
    const tags = [...profile.segmentTags].sort();
    const key = tags.length > 0 ? tags[0] : "untagged";
    const existing = groups.get(key) ?? [];
    existing.push(profile);
    groups.set(key, existing);
  }

  // Filter out groups that are too small
  const eligibleGroups = new Map<string, ContactSignalProfile[]>();
  const smallGroupProfiles: ContactSignalProfile[] = [];

  groups.forEach((groupProfiles, key) => {
    if (groupProfiles.length >= MIN_CONTACTS_PER_GROUP) {
      eligibleGroups.set(key, groupProfiles);
    } else {
      smallGroupProfiles.push(...groupProfiles);
    }
  });

  // Merge small groups into "other" if there are enough combined
  if (smallGroupProfiles.length >= MIN_CONTACTS_PER_GROUP) {
    eligibleGroups.set("other", smallGroupProfiles);
  }

  return eligibleGroups;
}

// ── OpenAI prompt ─────────────────────────────────────────────────────────────

interface PersonaLlmResult {
  name: string;
  description: string;
  primaryPainPoints: string[];
}

function buildPersonaPrompt(
  groupKey: string,
  profiles: ContactSignalProfile[],
  avgPainIntensity: number,
  pmfLikelihood: "high" | "medium" | "low",
): string {
  const signalTypeSummary = Array.from(
    new Set(profiles.flatMap((p) => p.signalTypes)),
  ).join(", ") || "general feedback";

  const allTags = Array.from(
    new Set(profiles.flatMap((p) => p.segmentTags)),
  ).join(", ") || groupKey;

  return `You are a product researcher helping a startup founder understand their user personas.

You have a group of ${profiles.length} contacts with the following characteristics:
- Segment tags: ${allTags}
- Signal types observed: ${signalTypeSummary}
- Average pain intensity: ${avgPainIntensity.toFixed(1)} / 10
- PMF likelihood: ${pmfLikelihood}

Based on this data, generate a realistic user persona for this group.

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "name": "Persona name (2-4 words, e.g. 'The Overwhelmed Founder')",
  "description": "2-3 sentence description of who this persona is, their role, and their context",
  "primaryPainPoints": ["pain point 1", "pain point 2", "pain point 3"]
}`;
}

async function generatePersonaWithOpenAI(
  groupKey: string,
  profiles: ContactSignalProfile[],
  avgPainIntensity: number,
  pmfLikelihood: "high" | "medium" | "low",
): Promise<PersonaLlmResult | null> {
  const prompt = buildPersonaPrompt(groupKey, profiles, avgPainIntensity, pmfLikelihood);

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 512,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI returned an empty response");
    }

    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).name !== "string" ||
      typeof (parsed as Record<string, unknown>).description !== "string" ||
      !Array.isArray((parsed as Record<string, unknown>).primaryPainPoints)
    ) {
      console.warn(`[generate-personas] Unexpected OpenAI response shape for group '${groupKey}'`);
      return null;
    }

    const result = parsed as PersonaLlmResult;
    return {
      name: result.name.trim(),
      description: result.description.trim(),
      primaryPainPoints: (result.primaryPainPoints as unknown[])
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim()),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[generate-personas] OpenAI call failed for group '${groupKey}': ${message}`,
    );
    return null;
  }
}

// ── PMF likelihood calculation ────────────────────────────────────────────────

/**
 * Derive PMF likelihood from the average wtp_signal rate across contacts in a group.
 *
 * Thresholds (aligned with Sean Ellis methodology):
 *   - high:   ≥ 40% of contacts showed wtp_signal
 *   - medium: 20–39%
 *   - low:    < 20%
 */
function derivePmfLikelihood(
  profiles: ContactSignalProfile[],
): "high" | "medium" | "low" {
  const contactsWithSignals = profiles.filter((p) => p.totalSignals > 0);
  if (contactsWithSignals.length === 0) return "low";

  const totalWtp = contactsWithSignals.reduce((sum, p) => sum + p.wtpSignalCount, 0);
  const totalSignals = contactsWithSignals.reduce((sum, p) => sum + p.totalSignals, 0);

  if (totalSignals === 0) return "low";

  const wtpRate = totalWtp / totalSignals;

  if (wtpRate >= 0.4) return "high";
  if (wtpRate >= 0.2) return "medium";
  return "low";
}

/**
 * Calculate the average pain intensity across all contacts in a group.
 * Returns 0 if no pain intensity data is available.
 */
function calculateAveragePainIntensity(profiles: ContactSignalProfile[]): number {
  const allIntensities = profiles.flatMap((p) => p.painIntensities);
  if (allIntensities.length === 0) return 0;
  return allIntensities.reduce((sum, v) => sum + v, 0) / allIntensities.length;
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `generate-personas` jobs.
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4
 */
export const generatePersonasWorker = new Worker<GeneratePersonasJobData>(
  "generate-personas",
  async (job: Job<GeneratePersonasJobData>) => {
    const { projectId } = job.data;

    console.log(`[generate-personas] Processing job ${job.id} for project ${projectId}`);

    // ── 1. Verify project exists ──────────────────────────────────────────────
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), sql`${projects.status} != 'deleted'`))
      .limit(1);

    if (!project) {
      console.warn(`[generate-personas] Project ${projectId} not found — skipping`);
      return { projectId, skipped: true, reason: "project_not_found" };
    }

    // ── 2. Load contact signal profiles ──────────────────────────────────────
    const profileMap = await loadContactSignalProfiles(projectId);
    const profiles = Array.from(profileMap.values());

    console.log(
      `[generate-personas] Found ${profiles.length} contacts with signals for project ${projectId}`,
    );

    // ── 3. Insufficient-data guard (Requirement 17.5) ─────────────────────────
    const result: PersonaGenerationResult = {
      projectId,
      personas: [],
      contactsWithSignals: profiles.length,
      generatedAt: new Date().toISOString(),
      insufficientData: profiles.length < MIN_CONTACTS_WITH_SIGNALS,
    };

    if (result.insufficientData) {
      console.log(
        `[generate-personas] Insufficient data for project ${projectId}: ` +
          `${profiles.length} contacts with signals (minimum: ${MIN_CONTACTS_WITH_SIGNALS})`,
      );
      // Cache the insufficient-data result so the API can return it immediately
      await redisConnection.set(
        `personas:${projectId}`,
        JSON.stringify(result),
        "EX",
        PERSONAS_CACHE_TTL_SECONDS,
      );
      return result;
    }

    // ── 4. Cluster contacts by segment tags ───────────────────────────────────
    const groups = clusterContactsBySegment(profiles);

    console.log(
      `[generate-personas] Formed ${groups.size} eligible persona groups for project ${projectId}`,
    );

    // ── 5. Generate personas for each group ───────────────────────────────────
    const personas: Persona[] = [];

    const groupEntries = Array.from(groups.entries());
    for (const [groupKey, groupProfiles] of groupEntries) {
      const avgPainIntensity = calculateAveragePainIntensity(groupProfiles);
      const pmfLikelihood = derivePmfLikelihood(groupProfiles);
      const allSegmentTags: string[] = Array.from(
        new Set(groupProfiles.flatMap((p: ContactSignalProfile) => p.segmentTags)),
      );

      console.log(
        `[generate-personas] Generating persona for group '${groupKey}' ` +
          `(${groupProfiles.length} contacts, avgPain=${avgPainIntensity.toFixed(1)}, pmf=${pmfLikelihood})`,
      );

      const llmResult = await generatePersonaWithOpenAI(
        groupKey,
        groupProfiles,
        avgPainIntensity,
        pmfLikelihood,
      );

      if (!llmResult) {
        console.warn(
          `[generate-personas] Skipping group '${groupKey}' — OpenAI generation failed`,
        );
        continue;
      }

      personas.push({
        name: llmResult.name,
        description: llmResult.description,
        primaryPainPoints: llmResult.primaryPainPoints,
        averagePainIntensity: Math.round(avgPainIntensity * 10) / 10,
        pmfLikelihood,
        contactCount: groupProfiles.length,
        segmentTags: allSegmentTags,
      });
    }

    result.personas = personas;

    console.log(
      `[generate-personas] Generated ${personas.length} personas for project ${projectId}`,
    );

    // ── 6. Cache results in Redis with 24-hour TTL ────────────────────────────
    await redisConnection.set(
      `personas:${projectId}`,
      JSON.stringify(result),
      "EX",
      PERSONAS_CACHE_TTL_SECONDS,
    );

    console.log(
      `[generate-personas] Cached personas for project ${projectId} (TTL: ${PERSONAS_CACHE_TTL_SECONDS}s)`,
    );

    return result;
  },
  {
    connection: redisConnection,
    concurrency: 2,
  },
);

generatePersonasWorker.on("completed", (job) => {
  console.log(`[generate-personas] Job ${job.id} completed successfully`);
});

generatePersonasWorker.on("failed", (job, error) => {
  console.error(
    `[generate-personas] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

generatePersonasWorker.on("error", (error) => {
  console.error(`[generate-personas] Worker error: ${error.message}`);
});
