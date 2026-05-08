/**
 * refresh-signal-feed.ts
 *
 * BullMQ worker that refreshes the `signal_feed_mv` materialized view.
 *
 * The view is refreshed concurrently so that reads are not blocked during
 * the refresh. A repeatable job is scheduled every 5 minutes in index.ts.
 *
 * Requirements: 14.3, 23.2
 */

import { Worker, type Job } from "bullmq";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { redisConnection } from "@/lib/queues";

// ─── Worker ───────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `refresh-signal-feed` jobs.
 *
 * Requirements: 14.3, 23.2
 */
export const refreshSignalFeedWorker = new Worker(
  "refresh-signal-feed",
  async (job: Job) => {
    const startedAt = Date.now();
    console.log(`[refresh-signal-feed] Job ${job.id} started at ${new Date(startedAt).toISOString()}`);

    await db.execute(
      sql`REFRESH MATERIALIZED VIEW CONCURRENTLY signal_feed_mv`,
    );

    const durationMs = Date.now() - startedAt;
    console.log(
      `[refresh-signal-feed] Job ${job.id} completed in ${durationMs}ms`,
    );

    return { durationMs };
  },
  {
    connection: redisConnection,
    concurrency: 1,
  },
);

refreshSignalFeedWorker.on("completed", (job) => {
  console.log(`[refresh-signal-feed] Job ${job.id} completed successfully`);
});

refreshSignalFeedWorker.on("failed", (job, error) => {
  console.error(
    `[refresh-signal-feed] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

refreshSignalFeedWorker.on("error", (error) => {
  console.error(`[refresh-signal-feed] Worker error: ${error.message}`);
});
