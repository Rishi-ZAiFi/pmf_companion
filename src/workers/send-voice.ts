/**
 * send-voice.ts
 *
 * BullMQ worker that places outbound voice calls to campaign contacts
 * via the Vapi API.
 *
 * For each job:
 * 1. Load the conversation, contact, and campaign from PostgreSQL.
 * 2. Skip if the contact has opted out of voice.
 * 3. Build an inline Vapi assistant config with:
 *    - The campaign script as the system prompt.
 *    - A probing instruction: ask "why" (or equivalent) when the contact's
 *      response is fewer than 15 words (Requirement 12.3).
 *    - A verbal consent disclosure at the start of the call (Requirement 12.4).
 * 4. Call POST https://api.vapi.ai/call/phone with the assistant config.
 * 5. Store the Vapi call ID in conversations.external_id.
 * 6. Update conversations.status to `in_progress`.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4
 */

import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations } from "@/db/schema/conversations";
import { contacts } from "@/db/schema/contacts";
import { campaigns } from "@/db/schema/campaigns";
import { redisConnection, type SendConversationJobData } from "@/lib/queues";
import { env } from "@/lib/env";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Vapi API base URL */
const VAPI_API_BASE = "https://api.vapi.ai";

/**
 * Verbal consent disclosure prepended to every call's system prompt.
 * Requirement 12.4: The Platform SHALL record all voice calls with the
 * Contact's consent, obtained via a verbal disclosure at the start of each call.
 */
const CONSENT_DISCLOSURE =
  "At the very start of the call, before anything else, say exactly: " +
  '"This call may be recorded for research purposes. By continuing, you consent to this recording." ' +
  "Wait for the contact to acknowledge before proceeding.";

/**
 * Probing instruction injected into every assistant system prompt.
 * Requirement 12.3: The Voice Agent SHALL ask "why" or an equivalent probing
 * question at least once per conversation turn where the Contact's response
 * is fewer than 15 words.
 */
const PROBING_INSTRUCTION =
  "If the contact's response to any question is fewer than 15 words, " +
  'ask a follow-up probing question such as "Why is that?" or "Can you tell me more about why?" ' +
  "before moving on to the next topic. Do this for every short response.";

/**
 * Opt-out handling instruction injected into every assistant system prompt.
 * Requirement 12.8: The Voice Agent SHALL end the call immediately and mark
 * the Contact as opted out if they decline to participate or request to end the call.
 */
const OPT_OUT_INSTRUCTION =
  'If the contact says anything indicating they do not want to participate, want to stop, want to be removed, or want to end the call (for example: "stop", "unsubscribe", "remove me", "I don\'t want to talk", "end the call", "hang up", "not interested", "please stop calling"), you MUST:\n' +
  '1. Acknowledge their request politely (e.g., "Of course, I\'ll remove you from our list right away. Have a great day!")\n' +
  "2. End the call immediately.\n" +
  "Do NOT continue the conversation after an opt-out request.";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the campaign script text to use as the voice assistant's system prompt.
 * Handles both structured JSON scripts and plain-text scripts.
 */
function buildSystemPrompt(
  campaign: { script: unknown; goal: string; name: string },
  contact: { firstName: string },
): string {
  const script = campaign.script as Record<string, unknown>;
  let scriptText = "";

  if (script && typeof script === "object") {
    // Try structured script formats
    if (typeof script.voice_prompt === "string") {
      scriptText = script.voice_prompt;
    } else if (typeof script.system_prompt === "string") {
      scriptText = script.system_prompt;
    } else if (typeof script.opening === "string") {
      // Build a prompt from the opening and any turns
      const turns = script.turns as Array<{ prompt?: string; question?: string }> | undefined;
      const turnText = Array.isArray(turns)
        ? turns
            .map((t, i) => `Turn ${i + 1}: ${t.prompt ?? t.question ?? ""}`)
            .filter((t) => t.trim().length > 0)
            .join("\n")
        : "";
      scriptText = [script.opening, turnText].filter(Boolean).join("\n\n");
    } else if (typeof script.message === "string") {
      scriptText = script.message;
    } else {
      // Serialize the whole script as context
      scriptText = JSON.stringify(script, null, 2);
    }
  } else if (typeof script === "string") {
    scriptText = script as string;
  }

  // Fallback
  if (!scriptText) {
    scriptText =
      `You are conducting a research interview for the "${campaign.name}" campaign. ` +
      `Your goal is: ${campaign.goal}. ` +
      `Ask open-ended questions to understand the contact's pain points and needs.`;
  }

  // Personalize with contact's first name
  scriptText = scriptText.replace(/\{firstName\}/gi, contact.firstName);

  // Compose the full system prompt: consent disclosure + script + probing instruction + opt-out handling
  return [
    CONSENT_DISCLOSURE,
    "",
    "--- Campaign Script ---",
    scriptText,
    "",
    "--- Conversation Guidelines ---",
    PROBING_INSTRUCTION,
    "",
    "--- Opt-Out Handling ---",
    OPT_OUT_INSTRUCTION,
    "",
    `The contact's name is ${contact.firstName}. Address them by name naturally during the conversation.`,
    "Conduct the conversation as a natural, open-ended dialogue. Ask follow-up questions, probe vague answers, and explore pain points rather than reading a rigid script.",
  ].join("\n");
}

/**
 * Build the Vapi call request body.
 */
function buildVapiCallPayload(
  contact: { phone: string; firstName: string },
  campaign: { script: unknown; goal: string; name: string },
): Record<string, unknown> {
  const systemPrompt = buildSystemPrompt(campaign, contact);

  return {
    phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
    customer: {
      number: contact.phone,
      name: contact.firstName,
    },
    assistant: {
      model: {
        provider: "openai",
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
        ],
      },
      recordingEnabled: true,
      // End the call gracefully when the conversation is complete
      endCallMessage:
        "Thank you so much for your time and insights. Have a great day!",
      // Transcription settings
      transcriber: {
        provider: "deepgram",
        model: "nova-2",
        language: "en",
      },
    },
  };
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `send-voice` jobs.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4
 */
export const sendVoiceWorker = new Worker<SendConversationJobData>(
  "send-voice",
  async (job: Job<SendConversationJobData>) => {
    const { conversationId, campaignId, contactId, projectId } = job.data;

    console.log(
      `[send-voice] Processing job ${job.id} for conversation ${conversationId}`,
    );

    // ── 1. Load conversation ─────────────────────────────────────────────────
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conversation) {
      console.warn(
        `[send-voice] Conversation ${conversationId} not found, skipping`,
      );
      return { skipped: true, reason: "conversation_not_found" };
    }

    if (conversation.status !== "pending") {
      console.warn(
        `[send-voice] Conversation ${conversationId} is in status '${conversation.status}', expected 'pending'. Skipping.`,
      );
      return { skipped: true, reason: `unexpected_status_${conversation.status}` };
    }

    // ── 2. Load contact ──────────────────────────────────────────────────────
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);

    if (!contact) {
      console.warn(`[send-voice] Contact ${contactId} not found, skipping`);
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "contact_not_found" };
    }

    // Check opt-out status (Requirement 12.1)
    if (contact.optedOutVoice) {
      console.log(
        `[send-voice] Contact ${contactId} has opted out of voice calls, skipping`,
      );
      await db
        .update(conversations)
        .set({ status: "opted_out", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "opted_out" };
    }

    if (!contact.phone) {
      console.warn(
        `[send-voice] Contact ${contactId} has no phone number, skipping`,
      );
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "no_phone" };
    }

    // ── 3. Load campaign ─────────────────────────────────────────────────────
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!campaign) {
      console.warn(`[send-voice] Campaign ${campaignId} not found, skipping`);
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "campaign_not_found" };
    }

    // ── 4. Build Vapi call payload ───────────────────────────────────────────
    const payload = buildVapiCallPayload(
      { phone: contact.phone, firstName: contact.firstName },
      campaign,
    );

    // ── 5. Call Vapi API ─────────────────────────────────────────────────────
    let vapiCallId: string | undefined;

    try {
      const response = await fetch(`${VAPI_API_BASE}/call/phone`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.VAPI_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Vapi API error ${response.status}: ${errorBody}`,
        );
      }

      const responseData = (await response.json()) as { id?: string };
      vapiCallId = responseData.id;

      if (!vapiCallId) {
        throw new Error("Vapi API response did not include a call ID");
      }

      console.log(
        `[send-voice] Call initiated to ${contact.phone} for conversation ${conversationId}, Vapi call ID: ${vapiCallId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[send-voice] Vapi call failed for conversation ${conversationId}: ${message}`,
      );

      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));

      throw error; // Re-throw so BullMQ retries
    }

    // ── 6. Update conversation record ────────────────────────────────────────
    await db
      .update(conversations)
      .set({
        status: "in_progress",
        externalId: vapiCallId,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    console.log(
      `[send-voice] Conversation ${conversationId} updated to in_progress, Vapi call ID: ${vapiCallId}`,
    );

    return {
      conversationId,
      vapiCallId,
      sent: true,
    };
  },
  {
    connection: redisConnection,
    concurrency: 5, // Voice calls are heavier — lower concurrency than email/SMS
    lockDuration: 60_000,
  },
);

sendVoiceWorker.on("completed", (job, result) => {
  console.log(
    `[send-voice] Job ${job.id} completed:`,
    JSON.stringify(result),
  );
});

sendVoiceWorker.on("failed", (job, error) => {
  console.error(
    `[send-voice] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

sendVoiceWorker.on("error", (error) => {
  console.error(`[send-voice] Worker error: ${error.message}`);
});
