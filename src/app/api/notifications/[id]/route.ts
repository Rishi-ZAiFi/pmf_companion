import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { notifications } from "@/db/schema/notifications";
import { requireAuth } from "@/lib/require-auth";

// ── Validation schema ────────────────────────────────────────────────────────

const patchNotificationSchema = z.object({
  is_read: z.boolean(),
});

// ── PATCH /api/notifications/:id ─────────────────────────────────────────────

/**
 * Updates a notification for the authenticated account.
 * Currently supports marking a notification as read or unread.
 *
 * Request body (JSON):
 *   { is_read: boolean }
 *
 * Responses:
 *   200 — Updated notification object.
 *   400 — Validation error.
 *   401 — Not authenticated.
 *   404 — Notification not found or does not belong to this account.
 *   500 — Unexpected server error.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id } = params;

  // ── 1. Parse and validate request body ──────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = patchNotificationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    // ── 2. Update the notification, scoped to the authenticated account ──
    const [updated] = await db
      .update(notifications)
      .set({ isRead: parsed.data.is_read })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.accountId, accountId),
        ),
      )
      .returning();

    if (!updated) {
      return NextResponse.json(
        { error: "Notification not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(updated);
  } catch (err) {
    console.error("[PATCH /api/notifications/:id] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
