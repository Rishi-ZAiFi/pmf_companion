/**
 * send-sms.ts
 *
 * BullMQ worker that sends the initial outbound campaign SMS to a contact
 * via the Twilio Messages API.
 *
 * For each job:
 * 1. Load the conversation, contact, campaign, and project from PostgreSQL.
 * 2. Skip if the contact has opted out of SMS.
 * 3. Build a personalized SMS body using the contact's first name and
 *    segment context from the campaign script.
 * 4. Include opt-out instruction in every outbound SMS (Requirement 22.5).
 * 5. Send via Twilio and store the returned SID in conversations.external_id.
 * 6. Update conversation status to `in_progress` and set turn_count to 1.
 *
 * Requirements: 11.1, 22.5
 */

import { Worker, type Job } from "bullmq";
import twilio from "twilio";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations } from "@/db/schema/conversations";
import { contacts } from "@/db/schema/contacts";
import { campaigns } from "@/db/schema/campaigns";
import { redisConnection, type SendConversationJobData } from "@/lib/queues";
import { env } from "@/lib/env";
import { buildOptOutUrl } from "@/lib/optout-token";

// Initialize Twilio client
const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum SMS body length (Twilio supports up to 1600 chars for concatenated SMS) */
const MAX_SMS_LENGTH = 1500;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a personalized SMS body from the campaign script and contact info.
 * Appends the opt-out link and STOP instruction to every message (Requirement 22.5).
 *
 * @param contact     - Contact record with firstName and segmentTags.
 * @param campaign    - Campaign record with script, goal, and name.
 * @param optOutUrl   - Signed opt-out URL for this contact.
 */
function buildSmsBody(
  contact: { firstName: string; segmentTags: string[] },
  campaign: { script: unknown; goal: string; name: string },
  optOutUrl: string,
): string {
  const script = campaign.script as Record<string, unknown>;
  let openingMessage = "";

  if (script && typeof script === "object") {
    const turns = script.turns as Array<{ prompt?: string; message?: string }> | undefined;
    if (Array.isArray(turns) && turns.length > 0) {
      openingMessage = turns[0]?.prompt ?? turns[0]?.message ?? "";
    } else if (typeof script.opening === "string") {
      openingMessage = script.opening;
    } else if (typeof script.sms_opening === "string") {
      openingMessage = script.sms_opening;
    } else if (typeof script.message === "string") {
      openingMessage = script.message;
    }
  }

  // Fallback message
  if (!openingMessage) {
    openingMessage = `Hi ${contact.firstName}, I'd love to get your quick feedback on our product. Do you have 2 minutes?`;
  } else {
    // Personalize with contact's first name
    openingMessage = openingMessage.replace(/\{firstName\}/gi, contact.firstName);
    if (!openingMessage.toLowerCase().includes(contact.firstName.toLowerCase())) {
      openingMessage = `Hi ${contact.firstName}, ${openingMessage}`;
    }
  }

  // Opt-out footer: include both the link and the STOP keyword for carrier compliance
  const optOutFooter = `To opt out: ${optOutUrl}\nReply STOP to unsubscribe.`;

  // Truncate opening message if needed to leave room for opt-out footer
  const maxBodyLength = MAX_SMS_LENGTH - optOutFooter.length - 2; // 2 for "\n\n"
  if (openingMessage.length > maxBodyLength) {
    openingMessage = openingMessage.substring(0, maxBodyLength - 3) + "...";
  }

  return `${openingMessage}\n\n${optOutFooter}`;
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `send-sms` jobs.
 *
 * Requirements: 11.1, 22.5
 */
export const sendSmsWorker = new Worker<SendConversationJobData>(
  "send-sms",
  async (job: Job<SendConversationJobData>) => {
    const { conversationId, campaignId, contactId, projectId } = job.data;

    console.log(
      `[send-sms] Processing job ${job.id} for conversation ${conversationId}`,
    );

    // ── 1. Load conversation ─────────────────────────────────────────────────
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conversation) {
      console.warn(`[send-sms] Conversation ${conversationId} not found, skipping`);
      return { skipped: true, reason: "conversation_not_found" };
    }

    if (conversation.status !== "pending") {
      console.warn(
        `[send-sms] Conversation ${conversationId} is in status '${conversation.status}', expected 'pending'. Skipping.`,
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
      console.warn(`[send-sms] Contact ${contactId} not found, skipping`);
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "contact_not_found" };
    }

    // Check opt-out status
    if (contact.optedOutSms) {
      console.log(
        `[send-sms] Contact ${contactId} has opted out of SMS, skipping`,
      );
      await db
        .update(conversations)
        .set({ status: "opted_out", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "opted_out" };
    }

    if (!contact.phone) {
      console.warn(`[send-sms] Contact ${contactId} has no phone number, skipping`);
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
      console.warn(`[send-sms] Campaign ${campaignId} not found, skipping`);
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "campaign_not_found" };
    }

    // ── 4. Build personalized SMS body ───────────────────────────────────────
    const optOutUrl = buildOptOutUrl(contactId, projectId, "sms", env.NEXTAUTH_URL);
    const smsBody = buildSmsBody(contact, campaign, optOutUrl);

    // ── 5. Send via Twilio ───────────────────────────────────────────────────
    let twilioSid: string | undefined;

    try {
      const message = await twilioClient.messages.create({
        body: smsBody,
        from: env.TWILIO_PHONE_NUMBER,
        to: contact.phone,
        // StatusCallback can be configured to track delivery status
      });

      twilioSid = message.sid;

      console.log(
        `[send-sms] SMS sent to ${contact.phone} for conversation ${conversationId}, SID: ${twilioSid}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[send-sms] Twilio send failed for conversation ${conversationId}: ${message}`,
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
        externalId: twilioSid ?? null,
        turnCount: 1,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    console.log(
      `[send-sms] Conversation ${conversationId} updated to in_progress, turn 1, SID: ${twilioSid}`,
    );

    return {
      conversationId,
      twilioSid,
      sent: true,
    };
  },
  {
    connection: redisConnection,
    concurrency: 10,
    lockDuration: 30_000,
  },
);

sendSmsWorker.on("completed", (job, result) => {
  console.log(
    `[send-sms] Job ${job.id} completed:`,
    JSON.stringify(result),
  );
});

sendSmsWorker.on("failed", (job, error) => {
  console.error(
    `[send-sms] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

sendSmsWorker.on("error", (error) => {
  console.error(`[send-sms] Worker error: ${error.message}`);
});
