/**
 * GET  /api/accounts/notifications  — retrieve notification preferences
 * PATCH /api/accounts/notifications — update notification preferences
 *
 * Allows founders to view and configure which notification types they
 * want to receive. Setting a type to `false` disables it; `true` enables it.
 *
 * Supported notification types:
 *   pmf-alert, cluster-alert, quota-warning, quota-exceeded,
 *   payment-failed, weekly-digest
 *
 * Requirements: 19.4
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { requireAuth } from "@/lib/require-auth";

// ── Constants ─────────────────────────────────────────────────────────────────

/** All valid notification type keys. */
export const NOTIFICATION_TYPES = [
  "pmf-alert",
  "cluster-alert",
  "quota-warning",
  "quota-exceeded",
  "payment-failed",
  "weekly-digest",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Default preferences — all types enabled. */
export const DEFAULT_PREFERENCES: Record<NotificationType, boolean> =
  Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, true])) as Record<
    NotificationType,
    boolean
  >;

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Schema for the PATCH request body.
 * Accepts a partial map of notification type → boolean.
 * Unknown keys are stripped; at least one key must be present.
 */
const patchSchema = z
  .object({
    "pmf-alert": z.boolean().optional(),
    "cluster-alert": z.boolean().optional(),
    "quota-warning": z.boolean().optional(),
    "quota-exceeded": z.boolean().optional(),
    "payment-failed": z.boolean().optional(),
    "weekly-digest": z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "At least one notification preference must be provided",
  });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch the current notification preferences for an account.
 * Falls back to DEFAULT_PREFERENCES if the column is null or malformed.
 */
async function fetchPreferences(
  accountId: string,
): Promise<Record<NotificationType, boolean>> {
  const [row] = await db
    .select({ notificationPreferences: accounts.notificationPreferences })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!row) return { ...DEFAULT_PREFERENCES };

  const raw = row.notificationPreferences as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFERENCES };

  // Merge stored values over defaults so any newly added types default to true
  const merged: Record<NotificationType, boolean> = { ...DEFAULT_PREFERENCES };
  for (const type of NOTIFICATION_TYPES) {
    if (typeof raw[type] === "boolean") {
      merged[type] = raw[type] as boolean;
    }
  }
  return merged;
}

// ── GET /api/accounts/notifications ──────────────────────────────────────────

/**
 * Returns the current notification preferences for the authenticated account.
 *
 * Response body:
 * ```json
 * {
 *   "pmf-alert": true,
 *   "cluster-alert": true,
 *   "quota-warning": true,
 *   "quota-exceeded": true,
 *   "payment-failed": true,
 *   "weekly-digest": false
 * }
 * ```
 *
 * Responses:
 *   200 — Preferences object.
 *   401 — Not authenticated.
 *   500 — Unexpected server error.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  try {
    const preferences = await fetchPreferences(accountId);
    return NextResponse.json(preferences);
  } catch (err) {
    console.error("[GET /api/accounts/notifications] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}

// ── PATCH /api/accounts/notifications ────────────────────────────────────────

/**
 * Updates notification preferences for the authenticated account.
 * Only the keys provided in the request body are updated; all other
 * preferences retain their current values.
 *
 * Request body (partial — only include keys you want to change):
 * ```json
 * { "weekly-digest": false, "pmf-alert": true }
 * ```
 *
 * Response body: the full updated preferences object.
 *
 * Responses:
 *   200 — Updated preferences object.
 *   400 — Invalid request body.
 *   401 — Not authenticated.
 *   500 — Unexpected server error.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const updates = parsed.data;

  try {
    // ── Fetch current preferences and merge updates ─────────────────────────
    const current = await fetchPreferences(accountId);
    const merged: Record<NotificationType, boolean> = { ...current };

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        merged[key as NotificationType] = value;
      }
    }

    // ── Persist merged preferences ──────────────────────────────────────────
    await db
      .update(accounts)
      .set({
        notificationPreferences: merged,
        updatedAt: sql`now()`,
      })
      .where(eq(accounts.id, accountId));

    return NextResponse.json(merged);
  } catch (err) {
    console.error("[PATCH /api/accounts/notifications] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
