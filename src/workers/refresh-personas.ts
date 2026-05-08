/**
 * refresh-personas.ts
 *
 * BullMQ worker that acts as a scheduler for persona generation.
 * When triggered (via a repeatable job every 24 hours), it loads all active
 * projects and enqueues a `generate-personas` job for each one.
 *
 * Deduplication: each enqueued job uses `jobId: generate-personas:{projectId}`
 * so that if a project's persona job is already queued or running, BullMQ
 * will not create a duplicate.
 *
 * Requirements: 17.4
 */

import { Worker } from "bullmq";
import { eq, and, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { redisConnection, generatePersonasQueue } from "@/lib/queues";

/**
 * BullMQ Worker that processes `refresh-personas` trigger jobs.
 *
 * Each run:
 * 1. Loads all active (non-archived, non-deleted) projects from the DB.
 * 2. Enqueues a `generate-personas` job for each project with a stable
 *    jobId for deduplication.
 *
 * Requirements: 17.4
 */
export const refreshPersonasWorker = new Worker(
  "refresh-personas",
  async (job) => {
    console.log(`[refresh-personas] Processing job ${job.id} — loading active projects`);

    // Load all active projects (status = 'active')
    const activeProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          ne(projects.status, "archived"),
          ne(projects.status, "deleted"),
        ),
      );

    console.log(
      `[refresh-personas] Found ${activeProjects.length} active project(s) — enqueuing persona generation`,
    );

    // Enqueue a generate-personas job for each project.
    // Using a stable jobId prevents duplicate jobs if the scheduler fires
    // while a previous run is still in the queue.
    const enqueueResults = await Promise.allSettled(
      activeProjects.map((project) =>
        generatePersonasQueue.add(
          "generate-personas",
          { projectId: project.id },
          { jobId: `generate-personas:${project.id}` },
        ),
      ),
    );

    const succeeded = enqueueResults.filter((r) => r.status === "fulfilled").length;
    const failed = enqueueResults.filter((r) => r.status === "rejected").length;

    if (failed > 0) {
      console.warn(
        `[refresh-personas] ${failed} project(s) failed to enqueue persona generation`,
      );
    }

    console.log(
      `[refresh-personas] Enqueued ${succeeded} generate-personas job(s) (${failed} failed)`,
    );

    return {
      totalProjects: activeProjects.length,
      enqueued: succeeded,
      failed,
    };
  },
  {
    connection: redisConnection,
    concurrency: 1,
  },
);

refreshPersonasWorker.on("completed", (job, result) => {
  console.log(
    `[refresh-personas] Job ${job.id} completed — enqueued ${result.enqueued} persona job(s)`,
  );
});

refreshPersonasWorker.on("failed", (job, error) => {
  console.error(
    `[refresh-personas] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

refreshPersonasWorker.on("error", (error) => {
  console.error(`[refresh-personas] Worker error: ${error.message}`);
});
