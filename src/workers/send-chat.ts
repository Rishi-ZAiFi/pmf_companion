/**
 * send-chat.ts
 *
 * BullMQ worker that activates a widget chat session for a contact as part of
 * a campaign delivery.
 *
 * The widget channel is interactive — unlike email/SMS/voice, the worker does
 * not send a message to an external service. Instead it:
 *
 * 1. Loads the conversation, contact, campaign, and project from PostgreSQL.
 * 2. Verifies the conversation is in `pending` status.
 * 3. Generates an initial AI greeting message using OpenAI, based on the
 *    campaign script and project context.
 * 4. Stores the greeting in the conversation metadata as the first assistant
 *    message, so the widget UI can display it immediately when the contact
 *    opens the chat panel.
 * 5. Updates the conversation status to `in_progress` and sets turn_count to 0
 *    (the greeting does not count as a user turn; the 8-message limit applies
 *    to user-initiated turns tracked by the widget message API).
 *
 * The actual back-and-forth conversation happens via:
 *   POST /api/widget/session  — creates the session (already done by deliver-campaign)
 *   POST /api/widget/message  — routes each user message through the AI engine
 *
 * The 8-message limit per session is enforced by the widget message API
 * (Requirement 11.5). This worker only sets up the initial state.
 *
 * Requirements: 11.4, 11.5
 */

import { Worker, type Job } from "bullmq";
import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations } from "@/db/schema/conversations";
import { contacts } from "@/db/schema/contacts";
import { campaigns } from "@/db/schema/campaigns";
import { projects } from "@/db/schema/projects";
import { redisConnection, type SendConversationJobData } from "@/lib/queues";
import { env } from "@/lib/env";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum number of user-initiated turns per widget session.
 * Enforced by the widget message API; stored here for reference.
 * Requirements: 11.5
 */
export const WIDGET_MAX_TURNS = 8;

// ── OpenAI client ─────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ── Types ─────────────────────────────────────────────────────────────────────

interface WidgetMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

interface ConversationMetadata {
  messages?: WidgetMessage[];
  greetingGenerated?: boolean;
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a simple unique ID for a message.
 */
function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the system prompt for the AI greeting, based on campaign and project context.
 */
function buildGreetingSystemPrompt(
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
      "Your goal is to conduct a PMF (Product-Market Fit) survey. You will ask the user how they would feel if they could no longer use the product.",
    pain_point_discovery:
      "Your goal is to discover the user's pain points related to the product space.",
    feature_validation:
      "Your goal is to validate specific product features with the user.",
    churn_investigation:
      "Your goal is to understand why the user stopped using or is considering leaving the product.",
  };

  const goalInstruction =
    goalInstructions[campaign.goal] ??
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
    "Task: Write a short, friendly opening greeting (2-3 sentences) to start the conversation.",
    "- Introduce yourself briefly.",
    "- State the purpose of the conversation in one sentence.",
    "- End with a single open-ended question to invite the user to engage.",
    "- Keep it conversational and warm, not formal or salesy.",
    "- Do NOT use placeholders like {firstName} — address the user generically.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Generate the initial AI greeting message for the widget session.
 * Returns the greeting text, or a sensible fallback if OpenAI fails.
 */
async function generateGreeting(
  campaign: { goal: string; script: unknown; persona: unknown; name: string },
  project: { name: string; description: string; icpDescription: string; problemStatement: string },
): Promise<string> {
  const systemPrompt = buildGreetingSystemPrompt(campaign, project);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: "Please write the opening greeting for this chat session.",
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
    });

    const greeting = completion.choices[0]?.message?.content?.trim();
    if (greeting) {
      return greeting;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[send-chat] OpenAI greeting generation failed, using fallback: ${message}`,
    );
  }

  // Fallback greeting based on campaign goal
  const fallbacks: Record<string, string> = {
    pmf_survey:
      `Hi! I'm here to get your quick feedback on ${project.name}. It'll only take a few minutes. How are you finding the product so far?`,
    pain_point_discovery:
      `Hi! I'd love to hear about your experience with ${project.name}. What challenges are you trying to solve?`,
    feature_validation:
      `Hi! I'm gathering feedback on ${project.name}'s features. What's been most useful for you?`,
    churn_investigation:
      `Hi! I wanted to check in about your experience with ${project.name}. What's been on your mind lately?`,
  };

  return (
    fallbacks[campaign.goal] ??
    `Hi! I'd love to chat about your experience with ${project.name}. What brings you here today?`
  );
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `send-chat` jobs.
 *
 * Requirements: 11.4, 11.5
 */
export const sendChatWorker = new Worker<SendConversationJobData>(
  "send-chat",
  async (job: Job<SendConversationJobData>) => {
    const { conversationId, campaignId, contactId, projectId } = job.data;

    console.log(
      `[send-chat] Processing job ${job.id} for conversation ${conversationId}`,
    );

    // ── 1. Load conversation ─────────────────────────────────────────────────
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conversation) {
      console.warn(
        `[send-chat] Conversation ${conversationId} not found, skipping`,
      );
      return { skipped: true, reason: "conversation_not_found" };
    }

    if (conversation.status !== "pending") {
      console.warn(
        `[send-chat] Conversation ${conversationId} is in status '${conversation.status}', expected 'pending'. Skipping.`,
      );
      return {
        skipped: true,
        reason: `unexpected_status_${conversation.status}`,
      };
    }

    if (conversation.channel !== "widget") {
      console.warn(
        `[send-chat] Conversation ${conversationId} has channel '${conversation.channel}', expected 'widget'. Skipping.`,
      );
      return { skipped: true, reason: "wrong_channel" };
    }

    // ── 2. Load contact ──────────────────────────────────────────────────────
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);

    if (!contact) {
      console.warn(`[send-chat] Contact ${contactId} not found, skipping`);
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "contact_not_found" };
    }

    // ── 3. Load campaign ─────────────────────────────────────────────────────
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!campaign) {
      console.warn(`[send-chat] Campaign ${campaignId} not found, skipping`);
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "campaign_not_found" };
    }

    // Verify the campaign supports the widget channel
    if (!campaign.channels.includes("widget")) {
      console.warn(
        `[send-chat] Campaign ${campaignId} does not include widget channel, skipping`,
      );
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "campaign_channel_mismatch" };
    }

    // ── 4. Load project ──────────────────────────────────────────────────────
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
      console.warn(`[send-chat] Project ${projectId} not found, skipping`);
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "project_not_found" };
    }

    // ── 5. Generate initial AI greeting ─────────────────────────────────────
    //
    // The greeting is stored in the conversation metadata so the widget UI
    // can display it immediately when the contact opens the chat panel.
    // The 8-message limit (Requirement 11.5) applies to user-initiated turns
    // and is enforced by POST /api/widget/message — the greeting does not
    // count against this limit.
    const greetingText = await generateGreeting(campaign, project);

    const greetingMessage: WidgetMessage = {
      id: generateMessageId(),
      role: "assistant",
      content: greetingText,
      createdAt: new Date().toISOString(),
    };

    const existingMeta = (conversation.metadata ?? {}) as ConversationMetadata;
    const updatedMetadata: ConversationMetadata = {
      ...existingMeta,
      messages: [greetingMessage],
      greetingGenerated: true,
    };

    // ── 6. Activate the widget session ───────────────────────────────────────
    //
    // Set status to `in_progress` so the widget API knows the session is ready.
    // turnCount stays at 0 — it increments when the user sends their first message.
    await db
      .update(conversations)
      .set({
        status: "in_progress",
        turnCount: 0,
        metadata: updatedMetadata,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    console.log(
      `[send-chat] Widget session activated for conversation ${conversationId}. ` +
        `Greeting stored (${greetingText.length} chars). ` +
        `Max turns: ${WIDGET_MAX_TURNS}.`,
    );

    return {
      conversationId,
      greetingMessageId: greetingMessage.id,
      activated: true,
    };
  },
  {
    connection: redisConnection,
    concurrency: 20,
    lockDuration: 30_000,
  },
);

sendChatWorker.on("completed", (job, result) => {
  console.log(
    `[send-chat] Job ${job.id} completed:`,
    JSON.stringify(result),
  );
});

sendChatWorker.on("failed", (job, error) => {
  console.error(
    `[send-chat] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

sendChatWorker.on("error", (error) => {
  console.error(`[send-chat] Worker error: ${error.message}`);
});
