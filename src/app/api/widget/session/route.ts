/**
 * POST /api/widget/session
 *
 * Creates a new widget chat session for a visitor on a founder's website.
 * This is a public endpoint — no authentication required (the widget is
 * embedded on external sites and accessed by anonymous visitors).
 *
 * Request body:
 *   { projectId: string, campaignId: string }
 *
 * Response:
 *   201 { sessionId: string }
 *   400 Validation error
 *   404 Campaign or project not found / campaign not active
 *   500 Unexpected error
 *
 * The session is stored as a conversation record with channel = 'widget'
 * and status = 'in_progress'. A synthetic "anonymous" contact is created
 * for the visitor so the conversation can be linked to a contact record
 * (required by the conversations FK constraint).
 *
 * Requirements: 11.3, 11.4
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { campaigns } from "@/db/schema/campaigns";
import { contacts } from "@/db/schema/contacts";
import { conversations } from "@/db/schema/conversations";

// ── Validation ────────────────────────────────────────────────────────────────

const sessionSchema = z.object({
  projectId: z.string().uuid("projectId must be a valid UUID"),
  campaignId: z.string().uuid("campaignId must be a valid UUID"),
});

// ── POST /api/widget/session ──────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = sessionSchema.safeParse(body);
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

  const { projectId, campaignId } = parsed.data;

  try {
    // 2. Verify the campaign exists, belongs to the project, and is active
    const [campaign] = await db
      .select({
        id: campaigns.id,
        projectId: campaigns.projectId,
        status: campaigns.status,
        channels: campaigns.channels,
      })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.projectId, projectId),
        ),
      )
      .limit(1);

    if (!campaign) {
      return NextResponse.json(
        { error: "Campaign not found" },
        { status: 404 },
      );
    }

    if (campaign.status !== "active" && campaign.status !== "launching") {
      return NextResponse.json(
        { error: "Campaign is not currently active" },
        { status: 404 },
      );
    }

    if (!campaign.channels.includes("widget")) {
      return NextResponse.json(
        { error: "Campaign does not support the widget channel" },
        { status: 400 },
      );
    }

    // 3. Create an anonymous contact for this visitor session.
    //    Widget visitors are anonymous — we create a placeholder contact
    //    that can be enriched later if the visitor provides their details.
    const [contact] = await db
      .insert(contacts)
      .values({
        projectId,
        firstName: "Widget",
        lastName: "Visitor",
        // Use a unique placeholder email so the CHECK constraint is satisfied.
        // Format: widget-<timestamp>-<random>@widget.marketsignal.io
        email: `widget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@widget.marketsignal.io`,
        segmentTags: ["widget_visitor"],
        crmSource: "csv", // closest available source type
      })
      .returning({ id: contacts.id });

    if (!contact) {
      throw new Error("Failed to create anonymous contact");
    }

    // 4. Create the conversation record
    const [conversation] = await db
      .insert(conversations)
      .values({
        campaignId,
        contactId: contact.id,
        projectId,
        channel: "widget",
        status: "in_progress",
        turnCount: 0,
      })
      .returning({ id: conversations.id });

    if (!conversation) {
      throw new Error("Failed to create conversation");
    }

    return NextResponse.json(
      { sessionId: conversation.id },
      { status: 201 },
    );
  } catch (err) {
    console.error("[POST /api/widget/session] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
