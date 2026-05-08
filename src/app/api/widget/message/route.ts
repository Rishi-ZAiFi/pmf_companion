/**
 * POST /api/widget/message
 *
 * Receives a user message from the chat widget, routes it through the
 * AI conversation engine, and returns the AI's reply.
 *
 * This is a public endpoint — authenticated by sessionId (conversation ID).
 *
 * Request body:
 *   {
 *     sessionId: string,   // conversation ID returned by POST /api/widget/session
 *     content: string,     // user's message text
 *     projectId: string,
 *     campaignId: string
 *   }
 *
 * Response:
 *   200 { messageId: string, reply: string }
 *   400 Validation error or session limit reached
 *   404 Session not found
 *   500 Unexpected error
 *
 * The widget channel enforces an 8-message limit per session (Requirement 11.5).
 * Messages are stored in the conversations.metadata JSONB field as a simple
 * message log (no separate messages table exists in the schema).
 *
 * When a session ends, a Transcript record is created and an analyze-transcript
 * job is enqueued to extract insights (Requirement 11.6).
 *
 * Requirements: 11.4, 11.5, 11.6
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import OpenAI from "openai";
import { db } from "@/db/client";
import { conversations } from "@/db/schema/conversations";
import { transcripts } from "@/db/schema/transcripts";
import { campaigns } from "@/db/schema/campaigns";
import { contacts } from "@/db/schema/contacts";
import { projects } from "@/db/schema/projects";
import { analyzeTranscriptQueue, type AnalyzeTranscriptJobData } from "@/lib/queues";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of AI follow-up messages per widget session (Requirement 11.5) */
const MAX_TURNS = 8;

// ── OpenAI client ─────────────────────────────────────────────────────────────

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

// ── Validation ────────────────────────────────────────────────────────────────

const messageSchema = z.object({
  sessionId: z.string().uuid("sessionId must be a valid UUID"),
  content: z.string().min(1, "Message content is required").max(2000, "Message too long"),
  projectId: z.string().uuid("projectId must be a valid UUID"),
  campaignId: z.string().uuid("campaignId must be a valid UUID"),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a simple unique ID for a message.
 */
function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the system prompt for the AI conversation engine based on the
 * campaign configuration and project context.
 */
function buildSystemPrompt(
  campaign: { goal: string; script: unknown; persona: unknown },
  project: { name: string; description: string; icpDescription: string; problemStatement: string },
): string {
  const persona = campaign.persona as Record<string, unknown>;
  const script = campaign.script as Record<string, unknown>;

  const personaName =
    typeof persona?.name === "string" ? persona.name : "Alex";
  const personaDescription =
    typeof persona?.description === "string"
      ? persona.description
      : "a friendly market researcher";

  const scriptInstructions =
    typeof script?.instructions === "string"
      ? script.instructions
      : typeof script?.system_prompt === "string"
        ? script.system_prompt
        : "";

  const goalInstructions: Record<string, string> = {
    pmf_survey:
      "Your goal is to conduct a PMF (Product-Market Fit) survey. Ask the user how they would feel if they could no longer use the product (very disappointed, somewhat disappointed, or not disappointed). Probe their reasoning and gather qualitative context.",
    pain_point_discovery:
      "Your goal is to discover the user's pain points related to the product space. Ask open-ended questions about their challenges, frustrations, and unmet needs. Probe vague answers with follow-up questions.",
    feature_validation:
      "Your goal is to validate specific product features. Ask the user about their experience with the features, what they find valuable, and what could be improved.",
    churn_investigation:
      "Your goal is to understand why the user stopped using or is considering leaving the product. Ask about their experience, what led to their decision, and what would bring them back.",
  };

  const goalInstruction =
    goalInstructions[campaign.goal] ||
    "Your goal is to gather feedback about the product and understand the user's needs.";

  return [
    `You are ${personaName}, ${personaDescription}.`,
    "",
    `Product context:`,
    `- Product: ${project.name}`,
    `- Description: ${project.description}`,
    `- Target customer: ${project.icpDescription}`,
    `- Problem being solved: ${project.problemStatement}`,
    "",
    goalInstruction,
    "",
    scriptInstructions ? `Additional instructions:\n${scriptInstructions}` : "",
    "",
    "Guidelines:",
    "- Keep responses concise and conversational (2-4 sentences max).",
    "- Ask one question at a time.",
    "- If the user's response is fewer than 15 words, ask a probing follow-up question (e.g., 'Can you tell me more about that?' or 'Why is that?').",
    "- Be empathetic and non-judgmental.",
    "- Do not pitch or sell the product.",
    "- If the user wants to end the conversation, thank them and close gracefully.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Format the widget message history into a readable transcript string.
 * Skips system messages; labels user and assistant turns clearly.
 */
function formatTranscriptContent(messages: WidgetMessage[]): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const speaker = m.role === "user" ? "User" : "Assistant";
      return `${speaker}: ${m.content}`;
    })
    .join("\n\n");
}

/**
 * Create a Transcript record and enqueue an analyze-transcript job
 * for a completed widget session. Non-fatal — errors are logged but
 * do not affect the HTTP response.
 */
async function closeWidgetSession(
  conversationId: string,
  projectId: string,
  messages: WidgetMessage[],
): Promise<void> {
  const content = formatTranscriptContent(messages);

  if (!content.trim()) {
    console.warn(
      `[POST /api/widget/message] Session ${conversationId} ended with no messages — skipping transcript creation`,
    );
    return;
  }

  try {
    const [transcript] = await db
      .insert(transcripts)
      .values({
        conversationId,
        projectId,
        content,
      })
      .returning({ id: transcripts.id });

    if (!transcript) {
      console.error(
        `[POST /api/widget/message] Failed to insert transcript for conversation ${conversationId}`,
      );
      return;
    }

    await analyzeTranscriptQueue.add(
      "analyze-transcript",
      {
        transcriptId: transcript.id,
        conversationId,
        projectId,
      } satisfies AnalyzeTranscriptJobData,
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        jobId: `analyze-transcript:${transcript.id}`,
      },
    );

    console.log(
      `[POST /api/widget/message] Created transcript ${transcript.id} and enqueued analyze-transcript job for conversation ${conversationId}`,
    );
  } catch (err) {
    // Non-fatal: log but don't fail the HTTP response
    console.error(
      `[POST /api/widget/message] Error closing widget session ${conversationId}:`,
      err,
    );
  }
}

// ── POST /api/widget/message ──────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = messageSchema.safeParse(body);
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

  const { sessionId, content, projectId, campaignId } = parsed.data;

  try {
    // 2. Load the conversation (session)
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, sessionId))
      .limit(1);

    if (!conversation) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Verify the conversation belongs to the correct project and campaign
    if (
      conversation.projectId !== projectId ||
      conversation.campaignId !== campaignId
    ) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (conversation.channel !== "widget") {
      return NextResponse.json({ error: "Invalid session channel" }, { status: 400 });
    }

    if (conversation.status === "completed" || conversation.status === "opted_out") {
      return NextResponse.json(
        { error: "This session has ended" },
        { status: 400 },
      );
    }

    // 3. Enforce 8-message limit (Requirement 11.5)
    //    turnCount tracks the number of user messages sent.
    if (conversation.turnCount >= MAX_TURNS) {
      // Mark session as completed
      await db
        .update(conversations)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(conversations.id, sessionId));

      // Create transcript and enqueue analysis for the already-completed session
      const meta = (conversation.metadata ?? {}) as ConversationMetadata;
      const existingMessages: WidgetMessage[] = Array.isArray(meta.messages)
        ? meta.messages
        : [];
      await closeWidgetSession(sessionId, projectId, existingMessages);

      return NextResponse.json(
        {
          error: "Session message limit reached",
          sessionEnded: true,
        },
        { status: 400 },
      );
    }

    // 4. Load campaign and project for AI context
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!campaign) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }

    const [project] = await db
      .select({
        name: projects.name,
        description: projects.description,
        icpDescription: projects.icpDescription,
        problemStatement: projects.problemStatement,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // 5. Retrieve existing message history from conversation metadata
    const meta = (conversation.metadata ?? {}) as ConversationMetadata;
    const existingMessages: WidgetMessage[] = Array.isArray(meta.messages)
      ? meta.messages
      : [];

    // 6. Append the new user message
    const userMessage: WidgetMessage = {
      id: generateMessageId(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const updatedMessages = [...existingMessages, userMessage];

    // 7. Build the OpenAI messages array
    const systemPrompt = buildSystemPrompt(campaign, project);
    const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...updatedMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
    ];

    // 8. Call OpenAI for the AI reply
    let replyContent: string;
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: openAiMessages,
        temperature: 0.7,
        max_tokens: 256,
      });

      replyContent =
        completion.choices[0]?.message?.content?.trim() ??
        "Thank you for your message. Could you tell me more?";
    } catch (aiError) {
      const message = aiError instanceof Error ? aiError.message : String(aiError);
      console.error("[POST /api/widget/message] OpenAI error:", message);
      return NextResponse.json(
        { error: "Failed to generate reply. Please try again." },
        { status: 500 },
      );
    }

    // 9. Append the assistant reply to the message history
    const assistantMessage: WidgetMessage = {
      id: generateMessageId(),
      role: "assistant",
      content: replyContent,
      createdAt: new Date().toISOString(),
    };
    const finalMessages = [...updatedMessages, assistantMessage];

    // 10. Determine if the session should be closed after this turn
    const newTurnCount = conversation.turnCount + 1;
    const sessionEnded = newTurnCount >= MAX_TURNS;
    const newStatus = sessionEnded ? "completed" : "in_progress";

    // 11. Persist the updated message history and turn count
    await db
      .update(conversations)
      .set({
        status: newStatus,
        turnCount: newTurnCount,
        metadata: { ...meta, messages: finalMessages },
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, sessionId));

    // 12. If the session just ended, create a Transcript and enqueue analysis (Requirement 11.6)
    if (sessionEnded) {
      await closeWidgetSession(sessionId, projectId, finalMessages);
    }

    return NextResponse.json({
      messageId: assistantMessage.id,
      reply: replyContent,
      sessionEnded,
      turnsRemaining: Math.max(0, MAX_TURNS - newTurnCount),
    });
  } catch (err) {
    console.error("[POST /api/widget/message] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
