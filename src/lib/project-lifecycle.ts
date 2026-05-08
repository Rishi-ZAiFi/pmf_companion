import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { campaigns } from "@/db/schema/campaigns";
import { allScraperQueues, redisConnection } from "@/lib/queues";

/**
 * Redis key used to mark a project as suspended.
 * Scraper workers check this flag before processing jobs so that
 * any jobs that slip through a paused queue are also skipped.
 */
function suspendedKey(projectId: string): string {
  return `project:${projectId}:suspended`;
}

/**
 * Campaign statuses that represent active/in-flight work.
 * These are the statuses that should be paused when a project is archived.
 */
const ACTIVE_CAMPAIGN_STATUSES = ["active", "launching"] as const;

/**
 * suspendProjectJobs
 *
 * Called when a project is archived (Requirement 1.6).
 * - Sets a Redis flag so scraper workers skip this project.
 * - Removes all repeatable scraper jobs for the project from every scraper queue.
 * - Pauses all active/launching campaigns for the project in the database.
 *
 * Historical signal data is NOT touched — only job scheduling is affected.
 */
export async function suspendProjectJobs(projectId: string): Promise<void> {
  // 1. Set the suspended flag in Redis so workers can check it cheaply.
  await redisConnection.set(suspendedKey(projectId), "1");

  // 2. Remove repeatable scraper jobs for this project from every scraper queue.
  //    Repeatable jobs are keyed by a repeat key that includes the projectId.
  //    We iterate all repeatable jobs and remove those whose key contains the projectId.
  await Promise.all(
    allScraperQueues.map(async (queue) => {
      try {
        const repeatableJobs = await queue.getRepeatableJobs();
        await Promise.all(
          repeatableJobs
            .filter((job) => job.key.includes(projectId))
            .map((job) => queue.removeRepeatableByKey(job.key)),
        );
      } catch (err) {
        // Log but don't throw — a missing queue or Redis hiccup should not
        // block the archive operation. The suspended flag above is the safety net.
        console.error(
          `[suspendProjectJobs] Failed to remove repeatable jobs from queue "${queue.name}" for project ${projectId}:`,
          err,
        );
      }
    }),
  );

  // 3. Pause active/launching campaigns in the database.
  //    We retain the campaign records and their historical data — only the status changes.
  await db
    .update(campaigns)
    .set({ status: "paused", updatedAt: new Date() })
    .where(
      and(
        eq(campaigns.projectId, projectId),
        inArray(campaigns.status, [...ACTIVE_CAMPAIGN_STATUSES]),
      ),
    );
}

/**
 * resumeProjectJobs
 *
 * Called when an archived project is restored (Requirement 1.6).
 * - Clears the Redis suspended flag so scraper workers will process this project again.
 * - Note: repeatable scraper jobs are NOT automatically re-enqueued here because
 *   the scraper workers (implemented in tasks 5.x / 6.x) are responsible for
 *   scheduling their own repeatable jobs when they start up or when a project
 *   becomes active. This function only lifts the suspension gate.
 * - Campaigns that were paused by archiving are NOT automatically resumed because
 *   the founder should explicitly choose to re-launch them after restoring.
 */
export async function resumeProjectJobs(projectId: string): Promise<void> {
  // Remove the suspended flag so scraper workers will process this project again.
  await redisConnection.del(suspendedKey(projectId));
}

/**
 * isProjectSuspended
 *
 * Utility for scraper workers to check whether a project is currently suspended
 * before processing a job. Returns true if the project is archived/suspended.
 */
export async function isProjectSuspended(projectId: string): Promise<boolean> {
  const value = await redisConnection.get(suspendedKey(projectId));
  return value === "1";
}
