/**
 * analyze-transcript.ts
 *
 * BullMQ worker that processes completed voice call transcripts.
 *
 * For each job:
 * 1. Load the transcript from the `transcripts` table.
 * 2. Load the conversation to get the `contactId`.
 * 3. Call OpenAI Chat Completions with a structured extraction prompt.
 * 4. Parse the JSON response: sentiment, pain_intensity, willingness_to_pay,
 *    competitor_mentions, top_quotes, signal_summaries.
 * 5. Update the `transcripts` record with the extracted insights.
 * 6. Insert Active Signal records in `signals` for each signal_summary.
 * 7. Enqueue `embed-signal` jobs for all newly created signal IDs.
 *
 * Requirements: 12.5, 12.6, 23.3
 */

import { Worker, type Job } from "bullmq";
import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { transcripts } from "@/db/schema/transcripts";
import { conversations } from "@/db/schema/conversations";
import { campaigns } from "@/db/schema/campaigns";
import { signals } from "@/db/schema/signals";
import {
  redisConnection,
  embedSignalQueue,
  calculatePmfScoreQueue,
  type AnalyzeTranscriptJobData,
  type EmbedSignalJobData,
  type CalculatePmfScoreJobData,
} from "@/lib/queues";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface SignalSummary {
  type: string;
  text: string;
}

interface TranscriptInsights {
  sentiment: "positive" | "neutral" | "negative";
  pain_intensity: number;
  willingness_to_pay: boolean;
  competitor_mentions: string[];
  top_quotes: string[];
  signal_summaries: SignalSummary[];
}

// ── Extraction prompt ─────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are an expert market research analyst. You will be given a transcript of a voice call between an AI agent and a potential customer. Your task is to extract structured insights from the conversation.

Return ONLY a valid JSON object with the following structure (no markdown, no explanation):
{
  "sentiment": "positive" | "neutral" | "negative",
  "pain_intensity": <integer 1-10>,
  "willingness_to_pay": <boolean>,
  "competitor_mentions": [<string>, ...],
  "top_quotes": [<string>, <string>, <string>],
  "signal_summaries": [
    { "type": "pain_point" | "feature_request" | "competitor_mention" | "market_trend" | "positive_sentiment" | "negative_sentiment", "text": <string> },
    ...
  ]
}

Guidelines:
- sentiment: overall emotional tone of the contact (not the agent)
- pain_intensity: how strongly the contact expressed pain or frustration (1 = mild, 10 = severe)
- willingness_to_pay: true if the contact expressed interest in paying for a solution
- competitor_mentions: names of any competing products or companies mentioned
- top_quotes: the 3 most insightful verbatim quotes from the contact (use empty strings if fewer than 3 exist)
- signal_summaries: 1–5 key market signals extracted from the conversation, each with a type and concise description`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Call OpenAI Chat Completions to extract structured insights from a transcript.
 * Returns parsed insights or null if the response cannot be parsed.
 */
async function extractInsights(transcriptContent: string): Promise<TranscriptInsights | null> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Here is the call transcript:\n\n${transcriptContent}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 1024,
    response_format: { type: "json_object" },
  });

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) {
    console.warn("[analyze-transcript] OpenAI returned empty content");
    return null;
  }

  try {
    const parsed = JSON.parse(rawContent) as TranscriptInsights;
    return parsed;
  } catch (err) {
    console.error(
      `[analyze-transcript] Failed to parse OpenAI JSON response: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(`[analyze-transcript] Raw response: ${rawContent}`);
    return null;
  }
}

/**
 * Clamp a value to the range [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Validate and normalise the sentiment value from the LLM response.
 */
function normaliseSentiment(
  value: unknown,
): "positive" | "neutral" | "negative" {
  if (value === "positive" || value === "neutral" || value === "negative") {
    return value;
  }
  return "neutral";
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `analyze-transcript` jobs.
 *
 * Requirements: 12.5, 12.6, 23.3
 */
export const analyzeTranscriptWorker = new Worker<AnalyzeTranscriptJobData>(
  "analyze-transcript",
  async (job: Job<AnalyzeTranscriptJobData>) => {
    const { transcriptId, conversationId, projectId } = job.data;

    console.log(
      `[analyze-transcript] Processing job ${job.id} for transcript ${transcriptId}`,
    );

    // ── 1. Load the transcript ────────────────────────────────────────────────
    const [transcript] = await db
      .select()
      .from(transcripts)
      .where(eq(transcripts.id, transcriptId))
      .limit(1);

    if (!transcript) {
      throw new Error(`Transcript ${transcriptId} not found`);
    }

    if (!transcript.content || transcript.content.trim().length === 0) {
      console.warn(
        `[analyze-transcript] Transcript ${transcriptId} has empty content — skipping analysis`,
      );
      return { transcriptId, skipped: true, reason: "empty_content" };
    }

    // Skip if already analyzed (idempotency guard)
    if (transcript.analyzedAt) {
      console.log(
        `[analyze-transcript] Transcript ${transcriptId} already analyzed at ${transcript.analyzedAt.toISOString()} — skipping`,
      );
      return { transcriptId, skipped: true, reason: "already_analyzed" };
    }

    // ── 2. Load the conversation to get contactId ─────────────────────────────
    const [conversation] = await db
      .select({
        contactId: conversations.contactId,
        campaignId: conversations.campaignId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const { contactId } = conversation;

    // ── 2a. Load the campaign to get the goal ─────────────────────────────────
    const [campaign] = await db
      .select({ goal: campaigns.goal })
      .from(campaigns)
      .where(eq(campaigns.id, conversation.campaignId))
      .limit(1);

    const campaignGoal = campaign?.goal ?? null;

    // ── 3. Call OpenAI to extract insights ────────────────────────────────────
    let insights: TranscriptInsights | null;
    try {
      insights = await extractInsights(transcript.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[analyze-transcript] OpenAI call failed for transcript ${transcriptId}: ${message}`,
      );
      throw error; // Re-throw so BullMQ retries the job
    }

    if (!insights) {
      // Malformed JSON from OpenAI — record the attempt with a timestamp so we
      // don't retry indefinitely, but don't create signals.
      await db
        .update(transcripts)
        .set({ analyzedAt: new Date() })
        .where(eq(transcripts.id, transcriptId));

      console.warn(
        `[analyze-transcript] Could not parse insights for transcript ${transcriptId} — marked as analyzed without data`,
      );
      return { transcriptId, skipped: false, signalsCreated: 0, parseError: true };
    }

    // ── 4. Validate / normalise the extracted values ──────────────────────────
    const sentiment = normaliseSentiment(insights.sentiment);
    const painIntensity = clamp(Math.round(insights.pain_intensity ?? 5), 1, 10);
    const wtpSignal = Boolean(insights.willingness_to_pay);
    const competitorMentions = Array.isArray(insights.competitor_mentions)
      ? insights.competitor_mentions.filter((m) => typeof m === "string")
      : [];
    const topQuotes = Array.isArray(insights.top_quotes)
      ? insights.top_quotes.filter((q) => typeof q === "string").slice(0, 3)
      : [];
    const signalSummaries: SignalSummary[] = Array.isArray(insights.signal_summaries)
      ? insights.signal_summaries.filter(
          (s) => s && typeof s.type === "string" && typeof s.text === "string",
        )
      : [];

    // ── 5. Update the transcript record with extracted insights ───────────────
    await db
      .update(transcripts)
      .set({
        sentiment,
        painIntensity,
        wtpSignal,
        competitorMentions,
        topQuotes,
        analyzedAt: new Date(),
      })
      .where(eq(transcripts.id, transcriptId));

    console.log(
      `[analyze-transcript] Updated transcript ${transcriptId} with insights ` +
        `(sentiment=${sentiment}, painIntensity=${painIntensity}, wtp=${wtpSignal})`,
    );

    // ── 6. Create Active Signal records for each signal_summary ───────────────
    const createdSignalIds: string[] = [];

    for (const summary of signalSummaries) {
      try {
        const [created] = await db
          .insert(signals)
          .values({
            projectId,
            source: "voice",
            signalKind: "active",
            signalType: summary.type,
            content: summary.text,
            sentiment,
            painIntensity,
            relevanceScore: 80, // Active signals are high relevance by default
            metadata: {
              transcriptId,
              conversationId,
              contactId,
            },
          })
          .returning({ id: signals.id });

        if (created) {
          createdSignalIds.push(created.id);
          console.log(
            `[analyze-transcript] Created signal ${created.id} (type=${summary.type}) for transcript ${transcriptId}`,
          );
        }
      } catch (error) {
        // Log but continue — a single signal insert failure should not abort the job
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[analyze-transcript] Failed to insert signal for transcript ${transcriptId}: ${message}`,
        );
      }
    }

    // ── 7. Enqueue embed-signal jobs for all newly created signals ────────────
    for (const signalId of createdSignalIds) {
      try {
        await embedSignalQueue.add(
          "embed-signal",
          { signalId, projectId } satisfies EmbedSignalJobData,
          {
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
            jobId: `embed-signal:${signalId}`,
          },
        );
      } catch (error) {
        // Non-fatal: log but don't fail the job
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[analyze-transcript] Failed to enqueue embed-signal job for signal ${signalId}: ${message}`,
        );
      }
    }

    if (createdSignalIds.length > 0) {
      console.log(
        `[analyze-transcript] Enqueued ${createdSignalIds.length} embed-signal jobs for transcript ${transcriptId}`,
      );
    }

    // ── 8. Enqueue calculate-pmf-score job if this is a PMF survey campaign ──
    if (campaignGoal === "pmf_survey") {
      try {
        await calculatePmfScoreQueue.add(
          "calculate-pmf-score",
          { projectId } satisfies CalculatePmfScoreJobData,
          {
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
            // Deduplicate: only one pending PMF score job per project at a time.
            // Using a delay-based deduplication window of 1 hour (3600s) ensures
            // the score is recalculated within 1 hour of each new PMF survey
            // transcript being analyzed (Requirement 15.2).
            jobId: `calculate-pmf-score:${projectId}:${Math.floor(Date.now() / (60 * 60 * 1000))}`,
          },
        );
        console.log(
          `[analyze-transcript] Enqueued calculate-pmf-score job for project ${projectId} (PMF survey campaign)`,
        );
      } catch (error) {
        // Non-fatal: log but don't fail the job
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[analyze-transcript] Failed to enqueue calculate-pmf-score job for project ${projectId}: ${message}`,
        );
      }
    }

    console.log(
      `[analyze-transcript] Completed job ${job.id}: transcript ${transcriptId} analyzed, ` +
        `${createdSignalIds.length} signals created`,
    );

    return {
      transcriptId,
      signalsCreated: createdSignalIds.length,
      sentiment,
      painIntensity,
    };
  },
  {
    connection: redisConnection,
    concurrency: 5,
  },
);

analyzeTranscriptWorker.on("completed", (job) => {
  console.log(`[analyze-transcript] Job ${job.id} completed successfully`);
});

analyzeTranscriptWorker.on("failed", (job, error) => {
  console.error(
    `[analyze-transcript] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

analyzeTranscriptWorker.on("error", (error) => {
  console.error(`[analyze-transcript] Worker error: ${error.message}`);
});
