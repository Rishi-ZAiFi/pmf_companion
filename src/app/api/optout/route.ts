/**
 * GET /api/optout?token=...
 *
 * Public endpoint — no authentication required.
 *
 * Verifies the opt-out token and marks the contact as opted out of the
 * specified channel. This endpoint is called by the opt-out confirmation
 * page (GET /optout?token=...) when the contact confirms their opt-out.
 *
 * Token payload: { contactId, projectId, channel, exp }
 *
 * Responses:
 *   200 — Contact successfully opted out. JSON: { success: true, channel }
 *   400 — Missing or invalid token. JSON: { success: false, error: string }
 *   404 — Contact not found. JSON: { success: false, error: string }
 *   500 — Unexpected server error.
 *
 * Requirements: 22.5
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { contacts } from "@/db/schema/contacts";
import { verifyOptOutToken } from "@/lib/optout-token";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const token = searchParams.get("token");

  // ── 1. Validate token presence ───────────────────────────────────────────
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Missing opt-out token." },
      { status: 400 },
    );
  }

  // ── 2. Verify token signature and expiry ─────────────────────────────────
  const payload = verifyOptOutToken(token);

  if (!payload) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid or expired opt-out link. Please contact support if you need assistance.",
      },
      { status: 400 },
    );
  }

  const { contactId, projectId, channel } = payload;

  try {
    // ── 3. Load contact ────────────────────────────────────────────────────
    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.projectId, projectId)))
      .limit(1);

    if (!contact) {
      return NextResponse.json(
        { success: false, error: "Contact not found." },
        { status: 404 },
      );
    }

    // ── 4. Build opt-out update ────────────────────────────────────────────
    const updateValues: Partial<typeof contacts.$inferInsert> = {
      updatedAt: new Date(),
    };

    switch (channel) {
      case "email":
        updateValues.optedOutEmail = true;
        break;
      case "sms":
        updateValues.optedOutSms = true;
        break;
      case "all":
        updateValues.optedOutEmail = true;
        updateValues.optedOutSms = true;
        updateValues.optedOutVoice = true;
        break;
    }

    // ── 5. Persist opt-out ─────────────────────────────────────────────────
    await db
      .update(contacts)
      .set(updateValues)
      .where(and(eq(contacts.id, contactId), eq(contacts.projectId, projectId)));

    const channelLabel =
      channel === "all" ? "all outreach channels" : `${channel} outreach`;

    console.log(
      `[GET /api/optout] Contact ${contactId} opted out of ${channelLabel} for project ${projectId}`,
    );

    return NextResponse.json({
      success: true,
      channel,
      message: `You have been successfully opted out of ${channelLabel}.`,
    });
  } catch (err) {
    console.error("[GET /api/optout] Unexpected error:", err);
    return NextResponse.json(
      { success: false, error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
