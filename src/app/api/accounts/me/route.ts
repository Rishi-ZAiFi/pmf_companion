/**
 * GET    /api/accounts/me  — return current account info
 * DELETE /api/accounts/me  — schedule account for permanent deletion
 *
 * The DELETE endpoint initiates the 30-day deletion window. It:
 *   1. Validates the confirmation body (`{ confirm: true, reason?: string }`).
 *   2. Sets `deletion_scheduled_at = now() + 30 days` on the account row.
 *   3. Writes an audit log entry.
 *   4. Returns 200 with a message describing the 30-day window.
 *
 * Actual data deletion is performed by the `process-account-deletions`
 * BullMQ worker (src/workers/process-account-deletions.ts), which runs
 * daily and permanently deletes accounts past their deletion date.
 *
 * Requirements: 22.4
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { requireAuth } from "@/lib/require-auth";
import { writeAuditLog } from "@/lib/audit-log";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Number of days after a deletion request before data is permanently removed. */
const DELETION_WINDOW_DAYS = 30;

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Schema for the DELETE request body.
 * Requires explicit `confirm: true` to prevent accidental deletions.
 */
const deleteSchema = z.object({
  confirm: z.literal(true, {
    errorMap: () => ({
      message: 'You must set "confirm" to true to delete your account',
    }),
  }),
  reason: z.string().max(500).optional(),
});

// ── GET /api/accounts/me ──────────────────────────────────────────────────────

/**
 * Returns the current account's public profile information.
 *
 * Response body:
 * ```json
 * {
 *   "id": "uuid",
 *   "email": "founder@example.com",
 *   "name": "Jane Doe",
 *   "planTier": "starter",
 *   "timezone": "America/New_York",
 *   "deletionScheduledAt": null,
 *   "createdAt": "2024-01-01T00:00:00.000Z"
 * }
 * ```
 *
 * Responses:
 *   200 — Account info object.
 *   401 — Not authenticated.
 *   404 — Account not found.
 *   500 — Unexpected server error.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  try {
    const [account] = await db
      .select({
        id: accounts.id,
        email: accounts.email,
        name: accounts.name,
        planTier: accounts.planTier,
        timezone: accounts.timezone,
        deletionScheduledAt: accounts.deletionScheduledAt,
        createdAt: accounts.createdAt,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    return NextResponse.json(account);
  } catch (err) {
    console.error("[GET /api/accounts/me] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}

// ── DELETE /api/accounts/me ───────────────────────────────────────────────────

/**
 * Schedules the authenticated account for permanent deletion.
 *
 * The account and all associated data will be permanently deleted after
 * 30 days. This is handled by the `process-account-deletions` BullMQ worker.
 *
 * Request body:
 * ```json
 * { "confirm": true, "reason": "optional reason string" }
 * ```
 *
 * Response body (200):
 * ```json
 * {
 *   "message": "Your account has been scheduled for deletion...",
 *   "deletionScheduledAt": "2024-02-01T00:00:00.000Z"
 * }
 * ```
 *
 * Responses:
 *   200 — Deletion scheduled. Includes `deletionScheduledAt` timestamp.
 *   400 — Invalid or missing confirmation body.
 *   401 — Not authenticated.
 *   409 — Account is already scheduled for deletion.
 *   500 — Unexpected server error.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  // ── Parse and validate request body ────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { reason } = parsed.data;

  try {
    // ── Check if deletion is already scheduled ──────────────────────────────
    const [existing] = await db
      .select({ deletionScheduledAt: accounts.deletionScheduledAt })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    if (existing.deletionScheduledAt !== null) {
      return NextResponse.json(
        {
          error: "Account is already scheduled for deletion",
          deletionScheduledAt: existing.deletionScheduledAt,
        },
        { status: 409 },
      );
    }

    // ── Schedule deletion: set deletion_scheduled_at = now() + 30 days ─────
    const deletionScheduledAt = new Date(
      Date.now() + DELETION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    await db
      .update(accounts)
      .set({
        deletionScheduledAt,
        updatedAt: sql`now()`,
      })
      .where(eq(accounts.id, accountId));

    // ── Write audit log entry ───────────────────────────────────────────────
    void writeAuditLog({
      accountId,
      actorId: accountId,
      action: "account.deletion_requested",
      resourceType: "account",
      resourceId: accountId,
      metadata: {
        deletionScheduledAt: deletionScheduledAt.toISOString(),
        reason: reason ?? null,
        windowDays: DELETION_WINDOW_DAYS,
      },
    });

    console.log(
      `[DELETE /api/accounts/me] Account ${accountId} scheduled for deletion at ${deletionScheduledAt.toISOString()}`,
    );

    return NextResponse.json({
      message: `Your account has been scheduled for permanent deletion. All data associated with your account will be permanently deleted on ${deletionScheduledAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}. This action cannot be undone after the 30-day window has passed.`,
      deletionScheduledAt: deletionScheduledAt.toISOString(),
    });
  } catch (err) {
    console.error("[DELETE /api/accounts/me] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
