/**
 * GET /api/widget/messages
 *
 * Returns all messages for a widget chat session.
 * Used by the widget for long-polling to check for new messages.
 *
 * This is a public endpoint — authenticated by sessionId (conversation ID).
 *
 * Query parameters:
 *   sessionId: string  — the conversation ID returned by POST /api/widget/session
 *
 * Response:
 *   200 { messages: Array<{ id, role, content, createdAt }>, sessionEnded: boolean }
 *   400 Missing sessionId
 *   404 Session not found
 *   500 Unexpected error
 *
 * Requirements: 11.3, 11.4
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations } from "@/db/schema/conversations";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WidgetMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

interface ConversationMetadata {
  messages?: WidgetMessage[];
  [key: string]: unknown;
}

// ── GET /api/widget/messages ──────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json(
      { error: "sessionId query parameter is required" },
      { status: 400 },
    );
  }

  // Basic UUID format check
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sessionId)) {
    return NextResponse.json(
      { error: "sessionId must be a valid UUID" },
      { status: 400 },
    );
  }

  try {
    const [conversation] = await db
      .select({
        id: conversations.id,
        status: conversations.status,
        metadata: conversations.metadata,
        channel: conversations.channel,
      })
      .from(conversations)
      .where(eq(conversations.id, sessionId))
      .limit(1);

    if (!conversation) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (conversation.channel !== "widget") {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Extract messages from the conversation metadata
    const meta = (conversation.metadata ?? {}) as ConversationMetadata;
    const messages: WidgetMessage[] = Array.isArray(meta.messages)
      ? meta.messages.filter(
          (m) => m.role === "user" || m.role === "assistant",
        )
      : [];

    const sessionEnded =
      conversation.status === "completed" ||
      conversation.status === "opted_out" ||
      conversation.status === "failed";

    return NextResponse.json({
      messages,
      sessionEnded,
      status: conversation.status,
    });
  } catch (err) {
    console.error("[GET /api/widget/messages] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
