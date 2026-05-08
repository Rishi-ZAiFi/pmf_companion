/**
 * name-cluster.ts
 *
 * BullMQ worker that generates a human-readable name and 2-sentence summary
 * for a theme cluster using OpenAI Chat Completions.
 *
 * Triggered when a cluster reaches ≥ 5 signals and has no LLM-generated name.
 *
 * For each job:
 * 1. Load the cluster and verify it still needs a name (idempotency guard).
 * 2. Load the top 10 signal texts from the cluster (by ingestion date).
 * 3. Call OpenAI Chat Completions with the signal texts.
 * 4. Parse the response: cluster name (≤ 6 words) and 2-sentence summary.
 * 5. Store the name and summary in theme_clusters.
 *
 * Requirements: 7.3
 */

import { Worker, type Job } from "bullmq";
import OpenAI from "openai";
import { eq, inArray, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { signals } from "@/db/schema/signals";
import { themeClusters, signalClusterMemberships } from "@/db/schema/theme-clusters";
import { redisConnection, type NameClusterJobData } from "@/lib/queues";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/** Maximum number of signal texts to include in the naming prompt. */
const MAX_SIGNALS_FOR_NAMING = 10;

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildNamingPrompt(signalTexts: string[]): string {
  const numbered = signalTexts
    .map((text, i) => `${i + 1}. ${text.trim()}`)
    .join("\n");

  return `You are a market research analyst. Below are ${signalTexts.length} market signals that have been grouped together because they are semantically similar.

Signals:
${numbered}

Based on these signals, provide:
1. A concise cluster name (≤ 6 words) that captures the common theme
2. A 2-sentence summary describing what this cluster represents and why it matters

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "name": "cluster name here",
  "summary": "First sentence. Second sentence."
}`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

interface ClusterNameResult {
  name: string;
  summary: string;
}

function parseNamingResponse(content: string): ClusterNameResult | null {
  try {
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).name !== "string" ||
      typeof (parsed as Record<string, unknown>).summary !== "string"
    ) {
      return null;
    }

    const result = parsed as ClusterNameResult;

    // Enforce ≤ 6 words for the name
    const nameWords = result.name.trim().split(/\s+/);
    const name = nameWords.slice(0, 6).join(" ");

    return {
      name,
      summary: result.summary.trim(),
    };
  } catch {
    return null;
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `name-cluster` jobs.
 *
 * Requirements: 7.3
 */
export const nameClusterWorker = new Worker<NameClusterJobData>(
  "name-cluster",
  async (job: Job<NameClusterJobData>) => {
    const { clusterId, projectId } = job.data;

    console.log(`[name-cluster] Processing job ${job.id} for cluster ${clusterId}`);

    // ── 1. Load cluster and check if it still needs a name ───────────────────
    const [cluster] = await db
      .select({
        id: themeClusters.id,
        name: themeClusters.name,
        signalCount: themeClusters.signalCount,
      })
      .from(themeClusters)
      .where(eq(themeClusters.id, clusterId))
      .limit(1);

    if (!cluster) {
      console.warn(`[name-cluster] Cluster ${clusterId} not found — skipping`);
      return { clusterId, skipped: true, reason: "cluster_not_found" };
    }

    // Idempotency guard: skip if already named
    if (cluster.name !== null) {
      console.log(
        `[name-cluster] Cluster ${clusterId} already has name '${cluster.name}' — skipping`,
      );
      return { clusterId, skipped: true, reason: "already_named" };
    }

    // ── 2. Load top 10 signal texts from the cluster ─────────────────────────
    const memberships = await db
      .select({ signalId: signalClusterMemberships.signalId })
      .from(signalClusterMemberships)
      .where(eq(signalClusterMemberships.clusterId, clusterId));

    if (memberships.length === 0) {
      console.warn(`[name-cluster] Cluster ${clusterId} has no signal memberships — skipping`);
      return { clusterId, skipped: true, reason: "no_signals" };
    }

    const memberSignalIds = memberships.map((m) => m.signalId);

    const clusterSignals = await db
      .select({
        id: signals.id,
        content: signals.content,
        ingestedAt: signals.ingestedAt,
      })
      .from(signals)
      .where(inArray(signals.id, memberSignalIds))
      .orderBy(desc(signals.ingestedAt))
      .limit(MAX_SIGNALS_FOR_NAMING);

    if (clusterSignals.length === 0) {
      console.warn(`[name-cluster] No signal texts found for cluster ${clusterId} — skipping`);
      return { clusterId, skipped: true, reason: "no_signal_texts" };
    }

    const signalTexts = clusterSignals.map((s) => s.content);

    // ── 3. Call OpenAI Chat Completions ───────────────────────────────────────
    const prompt = buildNamingPrompt(signalTexts);

    let result: ClusterNameResult;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 256,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("OpenAI returned an empty response");
      }

      const parsed = parseNamingResponse(content);
      if (!parsed) {
        throw new Error(`Failed to parse OpenAI response: ${content}`);
      }

      result = parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[name-cluster] OpenAI call failed for cluster ${clusterId}: ${message}`,
      );
      throw error; // Re-throw so BullMQ marks the job as failed and retries
    }

    // ── 4. Store name and summary ─────────────────────────────────────────────
    try {
      await db
        .update(themeClusters)
        .set({
          name: result.name,
          summary: result.summary,
          updatedAt: new Date(),
        })
        .where(eq(themeClusters.id, clusterId));

      console.log(
        `[name-cluster] Cluster ${clusterId} named: "${result.name}"`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[name-cluster] DB update failed for cluster ${clusterId}: ${message}`,
      );
      throw error;
    }

    return { clusterId, named: true, name: result.name };
  },
  {
    connection: redisConnection,
    concurrency: 5,
  },
);

nameClusterWorker.on("completed", (job) => {
  console.log(`[name-cluster] Job ${job.id} completed successfully`);
});

nameClusterWorker.on("failed", (job, error) => {
  console.error(
    `[name-cluster] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

nameClusterWorker.on("error", (error) => {
  console.error(`[name-cluster] Worker error: ${error.message}`);
});
