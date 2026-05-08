/**
 * send-email.ts
 *
 * BullMQ worker that sends the initial outbound campaign email to a contact
 * via the SendGrid API.
 *
 * For each job:
 * 1. Load the conversation, contact, campaign, and project from PostgreSQL.
 * 2. Skip if the contact has opted out of email.
 * 3. Build a personalized email body using the contact's first name and
 *    segment context from the campaign script.
 * 4. Include an opt-out link in every outbound email (Requirement 22.5).
 * 5. Send via SendGrid and store the returned message_id in conversations.external_id.
 * 6. Update conversation status to `in_progress` and increment turn_count.
 *
 * Requirements: 10.1, 10.2, 22.5
 */

import { Worker, type Job } from "bullmq";
import sgMail from "@sendgrid/mail";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations } from "@/db/schema/conversations";
import { contacts } from "@/db/schema/contacts";
import { campaigns } from "@/db/schema/campaigns";
import { redisConnection, type SendConversationJobData } from "@/lib/queues";
import { env } from "@/lib/env";
import { buildOptOutUrl } from "@/lib/optout-token";

// Configure SendGrid API key
sgMail.setApiKey(env.SENDGRID_API_KEY);

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default sender name used when the campaign persona doesn't specify one. */
const DEFAULT_SENDER_NAME = "Market Signal Platform";

/** Default sender email — should be a verified SendGrid sender. */
const DEFAULT_SENDER_EMAIL = "noreply@marketsignal.io";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a personalized email body from the campaign script and contact info.
 *
 * The campaign script is a JSON object with turn-by-turn prompts.
 * We use the first turn's prompt as the opening message, personalized with
 * the contact's first name and segment context.
 */
function buildEmailBody(
  contact: { firstName: string; segmentTags: string[] },
  campaign: { script: unknown; goal: string; name: string },
  optOutLink: string,
): { subject: string; html: string; text: string } {
  // Extract the opening message from the campaign script
  const script = campaign.script as Record<string, unknown>;
  let openingMessage = "";
  let subject = `Quick question about ${campaign.name}`;

  if (script && typeof script === "object") {
    // Try to get the opening message from the script
    const turns = script.turns as Array<{ prompt?: string; message?: string }> | undefined;
    if (Array.isArray(turns) && turns.length > 0) {
      openingMessage = turns[0]?.prompt ?? turns[0]?.message ?? "";
    } else if (typeof script.opening === "string") {
      openingMessage = script.opening;
    } else if (typeof script.message === "string") {
      openingMessage = script.message;
    }

    if (typeof script.subject === "string") {
      subject = script.subject;
    }
  }

  // Personalize with contact's first name
  const greeting = `Hi ${contact.firstName},`;

  // Add segment context if available
  const segmentContext =
    contact.segmentTags.length > 0
      ? `\n\nAs a ${contact.segmentTags.join(", ")} user, your perspective is especially valuable to us.`
      : "";

  // Fallback opening message based on campaign goal
  if (!openingMessage) {
    openingMessage = `I'd love to get your feedback on our product. It will only take a few minutes.`;
  }

  // Replace {firstName} placeholder if present in the script
  openingMessage = openingMessage.replace(/\{firstName\}/gi, contact.firstName);

  const textBody = [
    greeting,
    "",
    openingMessage,
    segmentContext,
    "",
    "Please reply directly to this email to share your thoughts.",
    "",
    "---",
    `To opt out of future emails, click here: ${optOutLink}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <p>${greeting}</p>
  <p>${openingMessage.replace(/\n/g, "<br>")}</p>
  ${segmentContext ? `<p>${segmentContext.trim()}</p>` : ""}
  <p>Please reply directly to this email to share your thoughts.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  <p style="font-size: 12px; color: #999;">
    To opt out of future emails, <a href="${optOutLink}" style="color: #999;">click here</a>.
  </p>
</body>
</html>`.trim();

  return { subject, html: htmlBody, text: textBody };
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `send-email` jobs.
 *
 * Requirements: 10.1, 10.2, 22.5
 */
export const sendEmailWorker = new Worker<SendConversationJobData>(
  "send-email",
  async (job: Job<SendConversationJobData>) => {
    const { conversationId, campaignId, contactId, projectId } = job.data;

    console.log(
      `[send-email] Processing job ${job.id} for conversation ${conversationId}`,
    );

    // ── 1. Load conversation ─────────────────────────────────────────────────
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conversation) {
      console.warn(`[send-email] Conversation ${conversationId} not found, skipping`);
      return { skipped: true, reason: "conversation_not_found" };
    }

    if (conversation.status !== "pending") {
      console.warn(
        `[send-email] Conversation ${conversationId} is in status '${conversation.status}', expected 'pending'. Skipping.`,
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
      console.warn(`[send-email] Contact ${contactId} not found, skipping`);
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "contact_not_found" };
    }

    // Check opt-out status
    if (contact.optedOutEmail) {
      console.log(
        `[send-email] Contact ${contactId} has opted out of email, skipping`,
      );
      await db
        .update(conversations)
        .set({ status: "opted_out", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "opted_out" };
    }

    if (!contact.email) {
      console.warn(`[send-email] Contact ${contactId} has no email address, skipping`);
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "no_email" };
    }

    // ── 3. Load campaign ─────────────────────────────────────────────────────
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!campaign) {
      console.warn(`[send-email] Campaign ${campaignId} not found, skipping`);
      await db
        .update(conversations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return { skipped: true, reason: "campaign_not_found" };
    }

    // ── 4. Build personalized email ──────────────────────────────────────────
    const optOutLink = buildOptOutUrl(contactId, projectId, "email", env.NEXTAUTH_URL);
    const { subject, html, text } = buildEmailBody(contact, campaign, optOutLink);

    // Extract sender info from campaign persona
    const persona = campaign.persona as Record<string, unknown>;
    const senderName =
      typeof persona?.name === "string" ? persona.name : DEFAULT_SENDER_NAME;
    const senderEmail =
      typeof persona?.email === "string" ? persona.email : DEFAULT_SENDER_EMAIL;

    // ── 5. Send via SendGrid ─────────────────────────────────────────────────
    let messageId: string | undefined;

    try {
      const [response] = await sgMail.send({
        to: contact.email,
        from: {
          email: senderEmail,
          name: senderName,
        },
        subject,
        text,
        html,
        // Custom args for reply tracking
        customArgs: {
          conversation_id: conversationId,
          contact_id: contactId,
          campaign_id: campaignId,
          project_id: projectId,
        },
        // Reply-To header so replies come back to our inbound parse webhook
        replyTo: senderEmail,
      });

      // SendGrid returns the message ID in the x-message-id header
      messageId = response.headers["x-message-id"] as string | undefined;

      console.log(
        `[send-email] Email sent to ${contact.email} for conversation ${conversationId}, messageId: ${messageId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[send-email] SendGrid send failed for conversation ${conversationId}: ${message}`,
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
        externalId: messageId ?? null,
        turnCount: 1,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    console.log(
      `[send-email] Conversation ${conversationId} updated to in_progress, turn 1`,
    );

    return {
      conversationId,
      messageId,
      sent: true,
    };
  },
  {
    connection: redisConnection,
    concurrency: 10,
    lockDuration: 30_000,
  },
);

sendEmailWorker.on("completed", (job, result) => {
  console.log(
    `[send-email] Job ${job.id} completed:`,
    JSON.stringify(result),
  );
});

sendEmailWorker.on("failed", (job, error) => {
  console.error(
    `[send-email] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

sendEmailWorker.on("error", (error) => {
  console.error(`[send-email] Worker error: ${error.message}`);
});
