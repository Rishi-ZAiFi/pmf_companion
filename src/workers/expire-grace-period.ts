/**
 * expire-grace-period.ts
 *
 * BullMQ worker that checks for accounts whose 7-day payment grace period
 * has expired and downgrades them to the free tier.
 *
 * A repeatable job is scheduled every hour in index.ts. On each run, the
 * worker queries for accounts where:
 *   - `grace_period_ends_at` is non-null (payment has failed)
 *   - `grace_period_ends_at` is in the past (grace period has expired)
 *   - `plan_tier` is not already 'free' (downgrade is still needed)
 *
 * For each such account, the worker:
 *   1. Downgrades `plan_tier` to 'free'
 *   2. Clears `grace_period_ends_at` and `payment_failed_at`
 *
 * Requirements: 21.6
 */

import { Worker, type Job } from "bullmq";
import { and, isNotNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { redisConnection } from "@/lib/queues";

// ─── Worker ───────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `expire-grace-period` jobs.
 *
 * Requirements: 21.6
 */
export const expireGracePeriodWorker = new Worker(
  "expire-grace-period",
  async (job: Job) => {
    const startedAt = Date.now();
    console.log(
      `[expire-grace-period] Job ${job.id} started at ${new Date(startedAt).toISOString()}`,
    );

    const now = new Date();

    // Find all accounts whose grace period has expired and are not yet on free tier
    const expiredAccounts = await db
      .select({
        id: accounts.id,
        planTier: accounts.planTier,
        gracePeriodEndsAt: accounts.gracePeriodEndsAt,
      })
      .from(accounts)
      .where(
        and(
          isNotNull(accounts.gracePeriodEndsAt),
          lt(accounts.gracePeriodEndsAt, now),
          ne(accounts.planTier, "free"),
        ),
      );

    if (expiredAccounts.length === 0) {
      console.log("[expire-grace-period] No expired grace periods found.");
      return { downgradedCount: 0 };
    }

    console.log(
      `[expire-grace-period] Found ${expiredAccounts.length} account(s) with expired grace periods.`,
    );

    let downgradedCount = 0;

    for (const account of expiredAccounts) {
      try {
        await db
          .update(accounts)
          .set({
            planTier: "free",
            gracePeriodEndsAt: null,
            paymentFailedAt: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              // Re-check conditions inside the update to guard against races
              isNotNull(accounts.gracePeriodEndsAt),
              lt(accounts.gracePeriodEndsAt, now),
              ne(accounts.planTier, "free"),
            ),
          );

        downgradedCount++;

        console.log(
          `[expire-grace-period] Account ${account.id} downgraded from '${account.planTier}' to 'free' ` +
            `(grace period ended at ${account.gracePeriodEndsAt?.toISOString() ?? "unknown"})`,
        );
      } catch (error) {
        console.error(
          `[expire-grace-period] Failed to downgrade account ${account.id}:`,
          error,
        );
        // Continue processing other accounts — don't let one failure block the rest
      }
    }

    const durationMs = Date.now() - startedAt;
    console.log(
      `[expire-grace-period] Job ${job.id} completed in ${durationMs}ms. ` +
        `Downgraded ${downgradedCount}/${expiredAccounts.length} account(s).`,
    );

    return { downgradedCount, checkedCount: expiredAccounts.length, durationMs };
  },
  {
    connection: redisConnection,
    concurrency: 1,
  },
);

expireGracePeriodWorker.on("completed", (job, result) => {
  console.log(
    `[expire-grace-period] Job ${job.id} completed: downgraded ${(result as { downgradedCount: number }).downgradedCount} account(s)`,
  );
});

expireGracePeriodWorker.on("failed", (job, error) => {
  console.error(
    `[expire-grace-period] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

expireGracePeriodWorker.on("error", (error) => {
  console.error(`[expire-grace-period] Worker error: ${error.message}`);
});
