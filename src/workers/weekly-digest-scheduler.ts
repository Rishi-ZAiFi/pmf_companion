/**
 * weekly-digest-scheduler.ts
 *
 * BullMQ worker that runs every minute and checks which accounts need their
 * weekly digest sent. Because BullMQ cron jobs run in UTC, timezone-aware
 * scheduling is handled in the worker itself:
 *
 *   1. Load all accounts with their configured timezone (default UTC).
 *   2. For each account, convert the current UTC time to the account's local time.
 *   3. If it is currently Monday between 09:00 and 09:59 in that timezone AND
 *      a digest has not already been sent today for that account, enqueue a
 *      `weekly-digest` notification job for each of the account's active projects.
 *   4. Use a Redis key `weekly-digest-sent:{accountId}:{YYYY-MM-DD}` (TTL 25 hours)
 *      to prevent duplicate sends within the same day.
 *
 * The scheduler itself is registered as a repeatable job (every minute) in
 * src/workers/index.ts.
 *
 * Requirements: 19.3, 19.5
 */

import { Worker } from "bullmq";
import { eq, and, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { projects } from "@/db/schema/projects";
import { redisConnection, notificationQueue } from "@/lib/queues";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Day-of-week index for Monday in JavaScript's getDay() (0 = Sunday). */
const MONDAY = 1;

/** The hour at which the digest should be sent (09:00 local time). */
const DIGEST_HOUR = 9;

/** TTL for the deduplication key: 25 hours to safely cover the 1-hour window. */
const DEDUP_TTL_SECONDS = 25 * 60 * 60;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the current date/time in the given IANA timezone as a plain object
 * with { dayOfWeek, hour, localDateString }.
 *
 * Falls back to UTC if the timezone string is invalid.
 */
function getLocalTime(timezone: string): {
  dayOfWeek: number;
  hour: number;
  localDateString: string; // YYYY-MM-DD in the local timezone
} {
  const safeTimezone = isValidTimezone(timezone) ? timezone : "UTC";

  const now = new Date();

  // Use Intl.DateTimeFormat to extract local date parts
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = formatter.formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hourStr = get("hour");
  const weekday = get("weekday"); // e.g. "Mon", "Tue", ...

  const localDateString = `${year}-${month}-${day}`;
  const hour = parseInt(hourStr, 10);

  // Map abbreviated weekday to JS day-of-week index (0 = Sun)
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = weekdayMap[weekday] ?? new Date().getDay();

  return { dayOfWeek, hour, localDateString };
}

/**
 * Returns true if the given string is a valid IANA timezone identifier.
 */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the Redis deduplication key for a given account and local date.
 */
function dedupKey(accountId: string, localDate: string): string {
  return `weekly-digest-sent:${accountId}:${localDate}`;
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `weekly-digest-scheduler` trigger jobs.
 *
 * Each run (every minute):
 * 1. Loads all accounts with their timezone.
 * 2. For each account, checks if it is currently Monday 09:xx in their timezone.
 * 3. Checks the Redis dedup key to avoid sending twice on the same day.
 * 4. Enqueues a `weekly-digest` notification job for each active project.
 *
 * Requirements: 19.3, 19.5
 */
export const weeklyDigestSchedulerWorker = new Worker(
  "weekly-digest-scheduler",
  async (job) => {
    console.log(
      `[weekly-digest-scheduler] Processing job ${job.id} — checking accounts for digest`,
    );

    // Load all accounts with their timezone
    const allAccounts = await db
      .select({
        id: accounts.id,
        timezone: accounts.timezone,
      })
      .from(accounts);

    console.log(
      `[weekly-digest-scheduler] Checking ${allAccounts.length} account(s)`,
    );

    let totalEnqueued = 0;
    let totalSkipped = 0;

    for (const account of allAccounts) {
      const { dayOfWeek, hour, localDateString } = getLocalTime(
        account.timezone ?? "UTC",
      );

      // Only proceed if it is Monday at 09:xx in the account's timezone
      if (dayOfWeek !== MONDAY || hour !== DIGEST_HOUR) {
        continue;
      }

      // Check deduplication key in Redis
      const key = dedupKey(account.id, localDateString);
      const alreadySent = await redisConnection.get(key);

      if (alreadySent) {
        console.log(
          `[weekly-digest-scheduler] Digest already sent for account ${account.id} on ${localDateString}, skipping`,
        );
        totalSkipped++;
        continue;
      }

      // Load all active projects for this account
      const activeProjects = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.accountId, account.id),
            ne(projects.status, "archived"),
            ne(projects.status, "deleted"),
          ),
        );

      if (activeProjects.length === 0) {
        console.log(
          `[weekly-digest-scheduler] No active projects for account ${account.id}, skipping`,
        );
        // Still mark as sent so we don't re-check every minute for the rest of the hour
        await redisConnection.set(key, "1", "EX", DEDUP_TTL_SECONDS);
        totalSkipped++;
        continue;
      }

      // Enqueue a weekly-digest job for each active project
      const enqueueResults = await Promise.allSettled(
        activeProjects.map((project) =>
          notificationQueue.add(
            "weekly-digest",
            {
              type: "weekly-digest",
              accountId: account.id,
              projectId: project.id,
            },
            {
              // Stable jobId prevents duplicates if the scheduler fires multiple
              // times within the same minute window
              jobId: `weekly-digest:${account.id}:${project.id}:${localDateString}`,
            },
          ),
        ),
      );

      const succeeded = enqueueResults.filter(
        (r) => r.status === "fulfilled",
      ).length;
      const failed = enqueueResults.filter(
        (r) => r.status === "rejected",
      ).length;

      if (failed > 0) {
        console.warn(
          `[weekly-digest-scheduler] ${failed} project(s) failed to enqueue for account ${account.id}`,
        );
      }

      // Mark this account as having had its digest enqueued today
      await redisConnection.set(key, "1", "EX", DEDUP_TTL_SECONDS);

      console.log(
        `[weekly-digest-scheduler] Enqueued ${succeeded} weekly-digest job(s) for account ${account.id} (${account.timezone})`,
      );

      totalEnqueued += succeeded;
    }

    console.log(
      `[weekly-digest-scheduler] Done — enqueued ${totalEnqueued} digest job(s), skipped ${totalSkipped} account(s)`,
    );

    return { totalEnqueued, totalSkipped };
  },
  {
    connection: redisConnection,
    concurrency: 1,
  },
);

weeklyDigestSchedulerWorker.on("completed", (job, result) => {
  if (result.totalEnqueued > 0) {
    console.log(
      `[weekly-digest-scheduler] Job ${job.id} completed — enqueued ${result.totalEnqueued} digest job(s)`,
    );
  }
});

weeklyDigestSchedulerWorker.on("failed", (job, error) => {
  console.error(
    `[weekly-digest-scheduler] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

weeklyDigestSchedulerWorker.on("error", (error) => {
  console.error(`[weekly-digest-scheduler] Worker error: ${error.message}`);
});
