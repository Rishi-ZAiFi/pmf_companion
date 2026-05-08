/**
 * audit-log.ts
 *
 * Reusable helper for writing records to the `audit_log` table.
 *
 * Audit logging is non-blocking — failures are logged to stderr but never
 * propagate to the caller. This ensures that a transient DB error or
 * misconfiguration never causes a user-facing request to fail.
 *
 * Retention: audit log records are retained for a minimum of 90 days.
 * A PostgreSQL policy (migration 0008_audit_log_retention.sql) enforces
 * automatic deletion of records older than 90 days via a scheduled job or
 * pg_cron extension.
 *
 * Requirements: 22.6
 */

import { db } from "@/db/client";
import { auditLog } from "@/db/schema/audit-log";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Parameters for a single audit log entry.
 */
export interface AuditLogParams {
  /** UUID of the account that owns the resource being accessed. */
  accountId: string;
  /**
   * UUID of the user who performed the action.
   * Typically the same as the account owner; may differ for team accounts.
   */
  actorId?: string;
  /**
   * The action being performed.
   * Convention: `<resource>.<verb>`, e.g. `signal.read`, `contact.export`,
   * `transcript.read`, `notion.export_signals`, `notion.export_clusters`,
   * `account.delete`.
   */
  action: string;
  /**
   * The type of resource being accessed.
   * e.g. `signal`, `contact`, `transcript`, `project`, `account`.
   */
  resourceType: string;
  /**
   * UUID of the specific resource being accessed, if applicable.
   * May be omitted for bulk/list operations.
   */
  resourceId?: string;
  /**
   * Additional context to store alongside the log entry.
   * Useful for recording IP address, user agent, query parameters, etc.
   */
  metadata?: Record<string, unknown>;
}

// ── Core helper ───────────────────────────────────────────────────────────────

/**
 * Writes a single record to the `audit_log` table.
 *
 * This function is **fire-and-forget**: it returns a Promise that resolves
 * once the insert completes (or rejects silently on error). Callers should
 * `void` the return value or `await` it — either way, errors are swallowed
 * and logged to stderr so they never propagate to the request handler.
 *
 * **Usage:**
 * ```ts
 * // Fire-and-forget (non-blocking)
 * void writeAuditLog({
 *   accountId,
 *   actorId: accountId,
 *   action: "signal.read",
 *   resourceType: "signal",
 *   resourceId: projectId,
 *   metadata: { projectId, page, limit },
 * });
 *
 * // Or awaited (still non-failing)
 * await writeAuditLog({ ... });
 * ```
 *
 * @param params - The audit log entry parameters.
 */
export async function writeAuditLog(params: AuditLogParams): Promise<void> {
  try {
    await db.insert(auditLog).values({
      accountId: params.accountId,
      actorId: params.actorId ?? null,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId ?? null,
      metadata: params.metadata ?? {},
    });
  } catch (err) {
    // Audit log failures must never break the request — log and continue.
    console.error("[audit-log] Failed to write audit log entry:", {
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      accountId: params.accountId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
