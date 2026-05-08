/**
 * embed-signal.ts
 *
 * BullMQ worker that generates vector embeddings for signals.
 *
 * For each job:
 * 1. Load the signal text from PostgreSQL by signalId.
 * 2. Call OpenAI text-embedding-3-small (1536 dimensions) to generate the embedding.
 * 3. Write the embedding to signals.embedding and update signals.status to 'embedded'.
 * 4. Enqueue a debounced cluster-signals job for the project (one pending per project
 *    at a time, using BullMQ jobId deduplication: `cluster-signals:{projectId}`).
 *
 * Requirements: 7.1
 */

import { Worker, type Job } from "bullmq";
import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { signals } from "@/db/schema/signals";
import {
  redisConnection,
  clusterSignalsQueue,
  type EmbedSignalJobData,
  type ClusterSignalsJobData,
} from "@/lib/queues";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Generate a 1536-dimensional embedding vector for the given text using
 * OpenAI's text-embedding-3-small model.
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    dimensions: 1536,
  });

  const embedding = response.data[0]?.embedding;
  if (!embedding || embedding.length !== 1536) {
    throw new Error(
      `Unexpected embedding dimensions: expected 1536, got ${embedding?.length ?? 0}`,
    );
  }

  return embedding;
}

/**
 * Enqueue a debounced cluster-signals job for the given project.
 *
 * Uses BullMQ's jobId deduplication: if a job with the same jobId already
 * exists in the queue (waiting or delayed), BullMQ will not add a duplicate.
 * This ensures at most one pending cluster job per project at a time.
 */
async function enqueueDebouncedClusterJob(projectId: string): Promise<void> {
  const jobId = `cluster-signals:${projectId}`;

  await clusterSignalsQueue.add(
    "cluster-signals",
    { projectId } satisfies ClusterSignalsJobData,
    {
      jobId,
      // Add a small delay so that multiple signals ingested in quick succession
      // are batched into a single clustering run.
      delay: 5_000,
    },
  );
}

/**
 * BullMQ Worker that processes `embed-signal` jobs.
 *
 * Requirements: 7.1
 */
export const embedSignalWorker = new Worker<EmbedSignalJobData>(
  "embed-signal",
  async (job: Job<EmbedSignalJobData>) => {
    const { signalId, projectId } = job.data;

    console.log(`[embed-signal] Processing job ${job.id} for signal ${signalId}`);

    // ── 1. Load signal text ──────────────────────────────────────────────────
    const [signal] = await db
      .select({
        id: signals.id,
        content: signals.content,
        status: signals.status,
        relevanceScore: signals.relevanceScore,
      })
      .from(signals)
      .where(eq(signals.id, signalId))
      .limit(1);

    if (!signal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    // Skip signals that are already embedded or excluded
    if (signal.status === "embedded" || signal.status === "excluded") {
      console.log(
        `[embed-signal] Signal ${signalId} already has status '${signal.status}' — skipping`,
      );
      return { signalId, skipped: true };
    }

    // ── 2. Apply relevance score filtering (Requirement 7.5) ─────────────────
    // Signals with relevance score < 20 are excluded from the feed but retained
    // in storage. We set their status to 'excluded' and skip embedding.
    if (signal.relevanceScore < 20) {
      await db
        .update(signals)
        .set({ status: "excluded" })
        .where(eq(signals.id, signalId));

      console.log(
        `[embed-signal] Signal ${signalId} has relevance score ${signal.relevanceScore} < 20 — marked as excluded`,
      );
      return { signalId, excluded: true };
    }

    // ── 3. Generate embedding ────────────────────────────────────────────────
    let embedding: number[];
    try {
      embedding = await generateEmbedding(signal.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[embed-signal] OpenAI embedding call failed for signal ${signalId}: ${message}`,
      );
      throw error; // Re-throw so BullMQ marks the job as failed and retries
    }

    // ── 4. Write embedding and update status ─────────────────────────────────
    try {
      await db
        .update(signals)
        .set({
          embedding,
          status: "embedded",
        })
        .where(eq(signals.id, signalId));

      console.log(`[embed-signal] Embedding written for signal ${signalId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[embed-signal] DB update failed for signal ${signalId}: ${message}`,
      );
      throw error;
    }

    // ── 5. Enqueue debounced cluster-signals job ──────────────────────────────
    try {
      await enqueueDebouncedClusterJob(projectId);
      console.log(
        `[embed-signal] Enqueued debounced cluster-signals job for project ${projectId}`,
      );
    } catch (error) {
      // Non-fatal: log but don't fail the job. The clustering can be triggered
      // by the next embed job or a scheduled run.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[embed-signal] Failed to enqueue cluster-signals job for project ${projectId}: ${message}`,
      );
    }

    return { signalId, embedded: true };
  },
  {
    connection: redisConnection,
    concurrency: 10,
  },
);

embedSignalWorker.on("completed", (job) => {
  console.log(`[embed-signal] Job ${job.id} completed successfully`);
});

embedSignalWorker.on("failed", (job, error) => {
  console.error(
    `[embed-signal] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

embedSignalWorker.on("error", (error) => {
  console.error(`[embed-signal] Worker error: ${error.message}`);
});
