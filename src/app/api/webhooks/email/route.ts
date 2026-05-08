/**
 * POST /api/webhooks/email
 *
 * SendGrid Inbound Parse webhook handler.
 *
 * SendGrid sends a multipart/form-data POST to this endpoint whenever a
 * contact replies to a campaign email. The payload includes:
 *   - `from`       — sender email address
 *   - `to`         — recipient email address
 *   - `subject`    — email subject
 *   - `text`       — plain-text body
 *   - `html`       — HTML body
 *   - `headers`    — raw email headers (used to extract In-Reply-To / References)
 *   - `envelope`   — JSON string with `{from, to}` fields
 *
 * This handler:
 * 1. Identifies the contact by their email address.
 * 2. Finds the active in_progress conversation for that contact.
 * 3. Detects opt-out phrases and marks the contact as opted out if found.
 * 4. Enforces the 5-message turn limit per contact per campaign.
 * 5. Routes the reply to the AI conversation engine (OpenAI Chat Completions).
 * 6. Sends the AI follow-up response via SendGrid within 5 minutes.
 * 7. Closes the thread when the turn limit is reached and generates a Transcript.
 *
 * Requirements: 10.3, 10.4, 10.5, 10.6
 */

import { NextRequest, NextResponse } from "next/server";
import sgMail from "@sendgrid/mail";
import OpenAI from "openai";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations } from "@/db/schema/conversations";
import { contacts } from "@/db/schema/contacts";
import { campaigns } from "@/db/schema/campaigns";
import { transcripts } from "@/db/schema/transcripts";
import { signals } from "@/db/schema/signals";
import { env } from "@/lib/env";
import { embedSignalQueue } from "@/lib/queues";

// Configure external clients
sgMail.setApiKey(env.SENDGRID_API_KEY);
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum turn count before closing the thread (Requirement 10.4).
 *
 * The send-email worker sets turnCount = 1 after the initial outbound email.
 * Each inbound reply increments turnCount by 1 before sending the AI follow-up.
 * Req 10.4 allows "up to 5 follow-up messages", meaning turns 2–6 are follow-ups.
 *
 * - newTurnCount <= 6: send AI follow-up, then close if newTurnCount === 6
 * - newTurnCount > 6: turn limit already exceeded, close without replying
 *
 * Setting EMAIL_TURN_LIMIT = 6 correctly allows exactly 5 AI follow-up replies.
 */
const EMAIL_TURN_LIMIT = 6;

/** Opt-out phrases to detect in email replies (Requirement 10.6) */
const OPT_OUT_PHRASES = ["unsubscribe", "stop", "remove me", "opt out", "opt-out"];

/** Default sender email for replies */
const DEFAULT_SENDER_EMAIL = "noreply@marketsignal.io";
const DEFAULT_SENDER_NAME = "Market Signal Platform";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check if the message body contains an opt-out phrase.
 */
function containsOptOutPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return OPT_OUT_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Build the opt-out link for a contact.
 * Token is a base64url encoding of the contact ID only — consistent with
 * the format used in the send-email worker (src/workers/send-email.ts).
 * Format: base64url(contactId)
 */
function buildOptOutLink(contactId: string): string {
  const token = Buffer.from(contactId).toString("base64url");
  return `${env.NEXTAUTH_URL}/optout?token=${token}`;
}

/**
 * Generate an AI follow-up response using OpenAI Chat Completions.
 * Uses the campaign script as context and the conversation history.
 */
async function generateAIResponse(
  campaign: { script: unknown; goal: string; name: string; persona: unknown },
  contactFirstName: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  const script = campaign.script as Record<string, unknown>;
  const persona = campaign.persona as Record<string, unknown>;

  const systemPrompt = `You are ${typeof persona?.name === "string" ? persona.name : "a market researcher"} conducting a ${campaign.goal.replace(/_/g, " ")} interview via email.

Campaign: ${campaign.name}
Goal: ${campaign.goal.replace(/_/g, " ")}

${typeof script?.instructions === "string" ? `Instructions: ${script.instructions}` : ""}
${typeof script?.context === "string" ? `Context: ${script.context}` : ""}

You are having an email conversation with ${contactFirstName}. Keep your responses:
- Concise and conversational (2-4 sentences max)
- Focused on gathering insights about their pain points and experiences
- Empathetic and non-pushy
- Ending with a single follow-up question to keep the conversation going

Do NOT include any opt-out instructions or email headers in your response — those are added automatically.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ],
    temperature: 0.7,
    max_tokens: 300,
  });

  return response.choices[0]?.message?.content ?? "Thank you for your response. Could you tell me more about that?";
}

/**
 * Generate a transcript and extract insights from the conversation history.
 * Creates a Transcript record and Active Signal records.
 */
async function closeEmailThread(
  conversationId: string,
  projectId: string,
  contactId: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<void> {
  // Build transcript content
  const transcriptContent = conversationHistory
    .map((msg) => `${msg.role === "user" ? "Contact" : "AI"}: ${msg.content}`)
    .join("\n\n");

  // Extract insights via OpenAI
  let sentiment: string | null = null;
  let painIntensity: number | null = null;
  let competitorMentions: string[] = [];
  let topQuotes: string[] = [];
  let signalSummaries: Array<{ type: string; text: string }> = [];

  try {
    const analysisResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an expert at analyzing customer interview transcripts. Extract structured insights from the following email conversation transcript.

Return ONLY a valid JSON object with this exact structure:
{
  "sentiment": "positive | neutral | negative",
  "pain_intensity": 1-10,
  "willingness_to_pay": true | false,
  "competitor_mentions": ["string"],
  "top_quotes": ["string", "string", "string"],
  "signal_summaries": [
    { "type": "pain_point | feature_request | competitor_mention | market_trend | positive_sentiment | negative_sentiment", "text": "string" }
  ]
}`,
        },
        {
          role: "user",
          content: `Analyze this email conversation transcript:\n\n${transcriptContent}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 1024,
      response_format: { type: "json_object" },
    });

    const content = analysisResponse.choices[0]?.message?.content;
    if (content) {
      const parsed = JSON.parse(content) as {
        sentiment?: string;
        pain_intensity?: number;
        willingness_to_pay?: boolean;
        competitor_mentions?: string[];
        top_quotes?: string[];
        signal_summaries?: Array<{ type: string; text: string }>;
      };

      sentiment = parsed.sentiment ?? null;
      painIntensity = parsed.pain_intensity ?? null;
      competitorMentions = parsed.competitor_mentions ?? [];
      topQuotes = parsed.top_quotes ?? [];
      signalSummaries = parsed.signal_summaries ?? [];
    }
  } catch (error) {
    console.error(`[email-webhook] Failed to extract insights for conversation ${conversationId}:`, error);
  }

  // Create transcript record
  const [transcript] = await db
    .insert(transcripts)
    .values({
      conversationId,
      projectId,
      content: transcriptContent,
      sentiment,
      painIntensity,
      competitorMentions,
      topQuotes,
      analyzedAt: new Date(),
    })
    .returning();

  console.log(`[email-webhook] Transcript created for conversation ${conversationId}: ${transcript.id}`);

  // Create Active Signal records from signal summaries
  for (const summary of signalSummaries) {
    try {
      const [signal] = await db
        .insert(signals)
        .values({
          projectId,
          source: "email",
          signalType: summary.type,
          signalKind: "active",
          content: summary.text,
          author: contactId,
          relevanceScore: 75, // Default relevance for active signals
          sentiment,
          painIntensity,
          status: "pending_embedding",
          metadata: {
            conversationId,
            transcriptId: transcript.id,
            contactId,
          },
        })
        .returning();

      // Enqueue embedding job for the new signal
      await embedSignalQueue.add(
        "embed-signal",
        { signalId: signal.id, projectId },
        { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
      );

      console.log(`[email-webhook] Active signal created: ${signal.id}`);
    } catch (error) {
      console.error(`[email-webhook] Failed to create signal for conversation ${conversationId}:`, error);
    }
  }
}

// ── Webhook Handler ───────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/email
 *
 * Handles inbound email replies from SendGrid Inbound Parse.
 * Requirements: 10.3, 10.4, 10.5, 10.6
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Parse multipart form data from SendGrid
    const formData = await request.formData();

    const fromRaw = formData.get("from") as string | null;
    const textBody = (formData.get("text") as string | null) ?? "";
    const htmlBody = (formData.get("html") as string | null) ?? "";

    if (!fromRaw) {
      console.warn("[email-webhook] Missing 'from' field in SendGrid payload");
      return NextResponse.json({ error: "Missing from field" }, { status: 400 });
    }

    // Extract email address from "Name <email@example.com>" format
    const emailMatch = fromRaw.match(/<([^>]+)>/) ?? fromRaw.match(/([^\s]+@[^\s]+)/);
    const senderEmail = emailMatch?.[1] ?? fromRaw.trim();

    console.log(`[email-webhook] Received reply from ${senderEmail}`);

    // ── 1. Find the contact by email ─────────────────────────────────────────
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, senderEmail))
      .limit(1);

    if (!contact) {
      console.warn(`[email-webhook] No contact found for email ${senderEmail}`);
      // Return 200 to prevent SendGrid from retrying
      return NextResponse.json({ received: true });
    }

    // ── 2. Find the active in_progress conversation ──────────────────────────
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.contactId, contact.id),
          eq(conversations.channel, "email"),
          eq(conversations.status, "in_progress"),
        ),
      )
      .orderBy(conversations.updatedAt)
      .limit(1);

    if (!conversation) {
      console.warn(`[email-webhook] No active email conversation found for contact ${contact.id}`);
      return NextResponse.json({ received: true });
    }

    // ── 3. Detect opt-out phrases (Requirement 10.6) ─────────────────────────
    const replyText = textBody || htmlBody.replace(/<[^>]+>/g, " ").trim();

    if (containsOptOutPhrase(replyText)) {
      console.log(`[email-webhook] Opt-out phrase detected for contact ${contact.id}`);

      // Mark contact as opted out of email
      await db
        .update(contacts)
        .set({ optedOutEmail: true, updatedAt: new Date() })
        .where(eq(contacts.id, contact.id));

      // Mark conversation as opted_out
      await db
        .update(conversations)
        .set({ status: "opted_out", updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));

      console.log(`[email-webhook] Contact ${contact.id} marked as opted out of email`);
      return NextResponse.json({ received: true, opted_out: true });
    }

    // ── 4. Load campaign ─────────────────────────────────────────────────────
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, conversation.campaignId))
      .limit(1);

    if (!campaign) {
      console.warn(`[email-webhook] Campaign ${conversation.campaignId} not found`);
      return NextResponse.json({ received: true });
    }

    // ── 5. Enforce turn limit (Requirement 10.4) ─────────────────────────────
    // turnCount tracks total messages sent (including the initial outbound).
    // We allow up to EMAIL_TURN_LIMIT total turns (5 follow-ups after initial).
    const newTurnCount = conversation.turnCount + 1;

    if (newTurnCount > EMAIL_TURN_LIMIT) {
      console.log(
        `[email-webhook] Turn limit (${EMAIL_TURN_LIMIT}) reached for conversation ${conversation.id}, closing thread`,
      );

      // Close the thread
      await db
        .update(conversations)
        .set({ status: "completed", turnCount: newTurnCount, updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));

      // Build conversation history for transcript generation.
      // NOTE: We only have the current inbound message here because individual
      // messages are not stored in the database. See step 6 for full explanation.
      const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: replyText },
      ];

      await closeEmailThread(
        conversation.id,
        conversation.projectId,
        contact.id,
        conversationHistory,
      );

      return NextResponse.json({ received: true, thread_closed: true });
    }

    // ── 6. Generate AI follow-up response ────────────────────────────────────
    // Build conversation history from the current reply.
    // NOTE: We only pass the current inbound message as conversation history because
    // individual messages are not stored in the database — only the conversation
    // record (with turnCount) is persisted. A full multi-turn history would require
    // a separate messages table. The AI system prompt provides campaign context to
    // compensate for the lack of prior turn history.
    const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: replyText },
    ];

    let aiResponse: string;
    try {
      aiResponse = await generateAIResponse(campaign, contact.firstName, conversationHistory);
    } catch (error) {
      console.error(`[email-webhook] AI response generation failed for conversation ${conversation.id}:`, error);
      // Don't fail the webhook — just skip the AI response
      return NextResponse.json({ received: true, ai_error: true });
    }

    // ── 7. Send AI follow-up via SendGrid ────────────────────────────────────
    const optOutLink = buildOptOutLink(contact.id);
    const persona = campaign.persona as Record<string, unknown>;
    const senderName =
      typeof persona?.name === "string" ? persona.name : DEFAULT_SENDER_NAME;
    const senderEmailAddr =
      typeof persona?.email === "string" ? persona.email : DEFAULT_SENDER_EMAIL;

    const emailSubject = formData.get("subject") as string | null;
    const replySubject = emailSubject
      ? (emailSubject.startsWith("Re:") ? emailSubject : `Re: ${emailSubject}`)
      : `Re: ${campaign.name}`;

    const textReply = `${aiResponse}\n\n---\nTo opt out of future emails, visit: ${optOutLink}`;
    const htmlReply = `
<p>${aiResponse.replace(/\n/g, "<br>")}</p>
<hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
<p style="font-size: 12px; color: #999;">
  To opt out of future emails, <a href="${optOutLink}" style="color: #999;">click here</a>.
</p>`.trim();

    try {
      await sgMail.send({
        to: contact.email!,
        from: { email: senderEmailAddr, name: senderName },
        subject: replySubject,
        text: textReply,
        html: htmlReply,
        customArgs: {
          conversation_id: conversation.id,
          contact_id: contact.id,
          campaign_id: campaign.id,
          project_id: conversation.projectId,
        },
      });

      console.log(
        `[email-webhook] AI follow-up sent to ${contact.email} for conversation ${conversation.id} (turn ${newTurnCount})`,
      );
    } catch (error) {
      console.error(`[email-webhook] Failed to send AI follow-up for conversation ${conversation.id}:`, error);
      // Don't fail the webhook — update turn count anyway
    }

    // ── 8. Update conversation turn count ────────────────────────────────────
    await db
      .update(conversations)
      .set({ turnCount: newTurnCount, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));

    // ── 9. Close thread if this was the last allowed turn ────────────────────
    if (newTurnCount >= EMAIL_TURN_LIMIT) {
      console.log(
        `[email-webhook] Reached turn limit for conversation ${conversation.id}, closing thread`,
      );

      await db
        .update(conversations)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));

      // Generate transcript with the full conversation
      const fullHistory: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: replyText },
        { role: "assistant", content: aiResponse },
      ];

      await closeEmailThread(
        conversation.id,
        conversation.projectId,
        contact.id,
        fullHistory,
      );
    }

    return NextResponse.json({ received: true, turn: newTurnCount });
  } catch (error) {
    console.error("[email-webhook] Unexpected error:", error);
    // Return 200 to prevent SendGrid from retrying on server errors
    return NextResponse.json({ received: true, error: "internal_error" });
  }
}
