/**
 * process-account-deletions.ts
 *
 * BullMQ worker that permanently deletes accounts whose 30-day deletion
 * window has passed.
 *
 * A repeatable job is scheduled daily in index.ts. On each run, the worker
 * queries for accounts where:
 *   - `deletion_scheduled_at` is non-null (deletion has been requested)
 *   - `deletion_scheduled_at` is in the past (30-day window has elapsed)
 *
 * For each such account, the worker:
 *   1. Writes a final audit log entry recording the permanent deletion.
 *   2. Permanently deletes the account row.
 *
 * The database schema uses ON DELETE CASCADE on all tables that reference
 * `accounts.id` (via `projects.account_id`), so deleting the account row
 * cascades to remove all associated data:
 *   accounts → projects → signals, contacts, campaigns, conversations,
 *              transcripts, pmf_score_snapshots, theme_clusters,
 *              notifications, integrations, webhook_endpoints
 *
 * The `audit_log` table references `accounts.id` WITHOUT a cascade delete
 * (intentional — audit records are retained for compliance). The worker
 * writes the final deletion audit entry before deleting the account, so
 * the audit trail is preserved even after the account is gone.
 *
 * Requirements: 22.4
 */

import { Worker, type Job } from "bullmq";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { writeAuditLog } from "@/lib/audit-log";
import { redisConnection } from "@/lib/queues";

// ─── Worker ───────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `process-account-deletions` jobs.
 *
 * Requirements: 22.4
 */
export const processAccountDeletionsWorker = new Worker(
  "process-account-deletions",
  async (job: Job) => {
    const startedAt = Date.now();
    console.log(
      `[process-account-deletions] Job ${job.id} started at ${new Date(startedAt).toISOString()}`,
    );

    const now = new Date();

    // Find all accounts whose deletion window has passed
    const accountsToDelete = await db
      .select({
        id: accounts.id,
        email: accounts.email,
        deletionScheduledAt: accounts.deletionScheduledAt,
      })
      .from(accounts)
      .where(
        and(
          isNotNull(accounts.deletionScheduledAt),
          lt(accounts.deletionScheduledAt, now),
        ),
      );

    if (accountsToDelete.length === 0) {
      console.log(
        "[process-account-deletions] No accounts pending deletion found.",
      );
      return { deletedCount: 0 };
    }

    console.log(
      `[process-account-deletions] Found ${accountsToDelete.length} account(s) pending permanent deletion.`,
    );

    let deletedCount = 0;

    for (const account of accountsToDelete) {
      try {
        // Write the final audit log entry BEFORE deleting the account.
        // The audit_log table does not cascade-delete when the account is
        // removed, so this record is preserved for compliance purposes.
        await writeAuditLog({
          accountId: account.id,
          actorId: account.id,
          action: "account.permanently_deleted",
          resourceType: "account",
          resourceId: account.id,
          metadata: {
            deletionScheduledAt:
              account.deletionScheduledAt?.toISOString() ?? null,
            deletedAt: now.toISOString(),
            // Email is recorded here for audit trail; the account row
            // (and thus the email field) will be gone after deletion.
            email: account.email,
          },
        });

        // Permanently delete the account. ON DELETE CASCADE in the schema
        // removes all associated projects, signals, contacts, campaigns,
        // conversations, transcripts, pmf_score_snapshots, theme_clusters,
        // notifications, integrations, and webhook_endpoints.
        await db.delete(accounts).where(
          and(
            eq(accounts.id, account.id),
            // Re-check conditions inside the delete to guard against races
            isNotNull(accounts.deletionScheduledAt),
            lt(accounts.deletionScheduledAt, now),
          ),
        );

        deletedCount++;

        console.log(
          `[process-account-deletions] Account ${account.id} permanently deleted ` +
            `(deletion was scheduled at ${account.deletionScheduledAt?.toISOString() ?? "unknown"})`,
        );
      } catch (error) {
        console.error(
          `[process-account-deletions] Failed to delete account ${account.id}:`,
          error,
        );
        // Continue processing other accounts — don't let one failure block the rest
      }
    }

    const durationMs = Date.now() - startedAt;
    console.log(
      `[process-account-deletions] Job ${job.id} completed in ${durationMs}ms. ` +
        `Deleted ${deletedCount}/${accountsToDelete.length} account(s).`,
    );

    return {
      deletedCount,
      checkedCount: accountsToDelete.length,
      durationMs,
    };
  },
  {
    connection: redisConnection,
    concurrency: 1,
  },
);

processAccountDeletionsWorker.on("completed", (job, result) => {
  console.log(
    `[process-account-deletions] Job ${job.id} completed: deleted ${(result as { deletedCount: number }).deletedCount} account(s)`,
  );
});

processAccountDeletionsWorker.on("failed", (job, error) => {
  console.error(
    `[process-account-deletions] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

processAccountDeletionsWorker.on("error", (error) => {
  console.error(
    `[process-account-deletions] Worker error: ${error.message}`,
  );
});
