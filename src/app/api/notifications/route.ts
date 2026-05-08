import { NextRequest, NextResponse } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { notifications } from "@/db/schema/notifications";
import { requireAuth } from "@/lib/require-auth";

// ── GET /api/notifications ───────────────────────────────────────────────────

/**
 * Lists all notifications for the authenticated account, ordered by most
 * recent first.
 *
 * Query parameters:
 *   unread_only=true  — return only unread notifications (optional)
 *   limit=N           — max number of results (default 50, max 100)
 *
 * Responses:
 *   200 — Array of notification objects.
 *   401 — Not authenticated.
 *   500 — Unexpected server error.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  const { searchParams } = new URL(request.url);
  const unreadOnly = searchParams.get("unread_only") === "true";
  const limitParam = parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 50 : limitParam), 100);

  try {
    const conditions = [eq(notifications.accountId, accountId)];
    if (unreadOnly) {
      conditions.push(eq(notifications.isRead, false));
    }

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return NextResponse.json(rows);
  } catch (err) {
    console.error("[GET /api/notifications] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
