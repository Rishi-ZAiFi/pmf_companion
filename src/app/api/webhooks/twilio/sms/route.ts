/**
 * POST /api/webhooks/twilio/sms
 *
 * Twilio webhook handler for inbound SMS replies.
 *
 * Twilio sends a POST with application/x-www-form-urlencoded body when a
 * contact replies to a campaign SMS. Key fields:
 *   - `From`    — sender's phone number (E.164 format)
 *   - `To`      — our Twilio phone number
 *   - `Body`    — the SMS message text
 *   - `MessageSid` — Twilio message SID
 *
 * This handler:
 * 1. Validates the Twilio request signature (security).
 * 2. Identifies the contact by their phone number.
 * 3. Finds the active in_progress SMS conversation for that contact.
 * 4. Detects opt-out phrases ("STOP", "UNSUBSCRIBE") and marks the contact
 *    as opted out if found.
 * 5. Enforces the 8 AI follow-up message limit per contact per session (turn limit = 9,
 *    since the initial outbound message is turn 1 and follow-ups are turns 2–9).
 * 6. Routes the reply to the AI conversation engine (OpenAI Chat Completions).
 * 7. Sends the AI follow-up response via Twilio within 2 minutes.
 * 8. Closes the session when the turn limit is reached and generates a Transcript.
 *
 * Requirements: 11.2, 11.5, 11.6, 11.7
 */

import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
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

// Initialize Twilio client
const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum turn count per SMS session (Requirement 11.5).
 * The send-sms worker sets turnCount = 1 for the initial outbound message.
 * Each inbound reply increments turnCount by 1. Follow-up messages are sent
 * for turns 2–9, giving exactly 8 AI follow-up messages before the session
 * closes. Setting this to 9 ensures newTurnCount > 9 closes without reply,
 * and newTurnCount = 9 sends the 8th follow-up then closes.
 */
const SMS_TURN_LIMIT = 9;

/** Opt-out phrases to detect in SMS replies (Requirement 11.7) */
const SMS_OPT_OUT_PHRASES = ["stop", "unsubscribe", "cancel", "quit", "end", "stopall"];

/** Opt-out instruction appended to every outbound SMS */
const SMS_OPT_OUT_INSTRUCTION = "Reply STOP to opt out.";

/** Maximum SMS body length */
const MAX_SMS_LENGTH = 1500;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check if the SMS body is an opt-out command.
 * Twilio handles STOP/UNSUBSCRIBE natively, but we also handle it ourselves
 * to update our database immediately.
 */
function isSmsOptOut(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  return SMS_OPT_OUT_PHRASES.includes(normalized);
}

/**
 * Validate the Twilio request signature to ensure the request is genuine.
 * Returns true if valid, false otherwise.
 */
function validateTwilioSignature(request: NextRequest, body: string): boolean {
  try {
    const signature = request.headers.get("x-twilio-signature") ?? "";
    const url = `${env.NEXTAUTH_URL}/api/webhooks/twilio/sms`;

    // Parse the form body into a params object for validation
    const params: Record<string, string> = {};
    const urlSearchParams = new URLSearchParams(body);
    for (const [key, value] of urlSearchParams.entries()) {
      params[key] = value;
    }

    return twilio.validateRequest(
      env.TWILIO_AUTH_TOKEN,
      signature,
      url,
      params,
    );
  } catch (error) {
    console.error("[twilio-sms-webhook] Signature validation error:", error);
    return false;
  }
}

/**
 * Generate an AI follow-up response for SMS.
 * Keeps responses concise for SMS format.
 */
async function generateSmsAIResponse(
  campaign: { script: unknown; goal: string; name: string; persona: unknown },
  contactFirstName: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  const script = campaign.script as Record<string, unknown>;
  const persona = campaign.persona as Record<string, unknown>;

  const systemPrompt = `You are ${typeof persona?.name === "string" ? persona.name : "a market researcher"} conducting a ${campaign.goal.replace(/_/g, " ")} interview via SMS.

Campaign: ${campaign.name}
Goal: ${campaign.goal.replace(/_/g, " ")}

${typeof script?.instructions === "string" ? `Instructions: ${script.instructions}` : ""}

You are texting with ${contactFirstName}. Keep your responses:
- Very short (1-2 sentences max, under 160 characters if possible)
- Conversational and friendly
- Ending with a single focused question
- No opt-out instructions (those are added automatically)`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ],
    temperature: 0.7,
    max_tokens: 150,
  });

  return response.choices[0]?.message?.content ?? "Thanks! Could you tell me more about that?";
}

/**
 * Generate a transcript and extract insights from the SMS conversation.
 * Creates a Transcript record and Active Signal records.
 */
async function closeSmsSession(
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
          content: `You are an expert at analyzing customer interview transcripts. Extract structured insights from the following SMS conversation transcript.

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
          content: `Analyze this SMS conversation transcript:\n\n${transcriptContent}`,
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
    console.error(`[twilio-sms-webhook] Failed to extract insights for conversation ${conversationId}:`, error);
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

  console.log(`[twilio-sms-webhook] Transcript created for conversation ${conversationId}: ${transcript.id}`);

  // Create Active Signal records from signal summaries
  for (const summary of signalSummaries) {
    try {
      const [signal] = await db
        .insert(signals)
        .values({
          projectId,
          source: "sms",
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

      console.log(`[twilio-sms-webhook] Active signal created: ${signal.id}`);
    } catch (error) {
      console.error(`[twilio-sms-webhook] Failed to create signal for conversation ${conversationId}:`, error);
    }
  }
}

/**
 * Build a TwiML response to send an SMS reply.
 * Returns TwiML XML string.
 */
function buildTwimlResponse(message: string): string {
  // Truncate if needed
  const truncated =
    message.length > MAX_SMS_LENGTH
      ? message.substring(0, MAX_SMS_LENGTH - 3) + "..."
      : message;

  const escaped = truncated
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

/**
 * Build an empty TwiML response (no reply).
 */
function buildEmptyTwimlResponse(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
}

// ── Webhook Handler ───────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/twilio/sms
 *
 * Handles inbound SMS replies from Twilio.
 * Requirements: 11.2, 11.5, 11.6, 11.7
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Read the raw body for signature validation
    const rawBody = await request.text();

    // ── Security: Validate Twilio signature ──────────────────────────────────
    // Skip validation in development/test environments
    if (env.NODE_ENV === "production") {
      const isValid = validateTwilioSignature(request, rawBody);
      if (!isValid) {
        console.warn("[twilio-sms-webhook] Invalid Twilio signature, rejecting request");
        return new NextResponse(buildEmptyTwimlResponse(), {
          status: 403,
          headers: { "Content-Type": "text/xml" },
        });
      }
    }

    // Parse the URL-encoded body
    const params = new URLSearchParams(rawBody);
    const fromPhone = params.get("From");
    const smsBody = params.get("Body") ?? "";
    const messageSid = params.get("MessageSid");

    if (!fromPhone) {
      console.warn("[twilio-sms-webhook] Missing 'From' field in Twilio payload");
      return new NextResponse(buildEmptyTwimlResponse(), {
        status: 400,
        headers: { "Content-Type": "text/xml" },
      });
    }

    console.log(`[twilio-sms-webhook] Received SMS from ${fromPhone}: "${smsBody.substring(0, 50)}..."`);

    // ── 1. Find the contact by phone number ──────────────────────────────────
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.phone, fromPhone))
      .limit(1);

    if (!contact) {
      console.warn(`[twilio-sms-webhook] No contact found for phone ${fromPhone}`);
      return new NextResponse(buildEmptyTwimlResponse(), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    // ── 2. Detect opt-out phrases (Requirement 11.7) ─────────────────────────
    if (isSmsOptOut(smsBody)) {
      console.log(`[twilio-sms-webhook] Opt-out detected from contact ${contact.id}`);

      // Mark contact as opted out of SMS
      await db
        .update(contacts)
        .set({ optedOutSms: true, updatedAt: new Date() })
        .where(eq(contacts.id, contact.id));

      // Mark any active SMS conversations as opted_out
      await db
        .update(conversations)
        .set({ status: "opted_out", updatedAt: new Date() })
        .where(
          and(
            eq(conversations.contactId, contact.id),
            eq(conversations.channel, "sms"),
            eq(conversations.status, "in_progress"),
          ),
        );

      console.log(`[twilio-sms-webhook] Contact ${contact.id} marked as opted out of SMS`);

      // Twilio will handle the STOP response automatically, but we return empty TwiML
      return new NextResponse(buildEmptyTwimlResponse(), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    // ── 3. Find the active in_progress SMS conversation ──────────────────────
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.contactId, contact.id),
          eq(conversations.channel, "sms"),
          eq(conversations.status, "in_progress"),
        ),
      )
      .orderBy(conversations.updatedAt)
      .limit(1);

    if (!conversation) {
      console.warn(`[twilio-sms-webhook] No active SMS conversation found for contact ${contact.id}`);
      return new NextResponse(buildEmptyTwimlResponse(), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    // ── 4. Load campaign ─────────────────────────────────────────────────────
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, conversation.campaignId))
      .limit(1);

    if (!campaign) {
      console.warn(`[twilio-sms-webhook] Campaign ${conversation.campaignId} not found`);
      return new NextResponse(buildEmptyTwimlResponse(), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    // ── 5. Enforce turn limit (Requirement 11.5) ─────────────────────────────
    const newTurnCount = conversation.turnCount + 1;

    if (newTurnCount > SMS_TURN_LIMIT) {
      console.log(
        `[twilio-sms-webhook] Turn limit (${SMS_TURN_LIMIT}) reached for conversation ${conversation.id}, closing session`,
      );

      // Close the session
      await db
        .update(conversations)
        .set({ status: "completed", turnCount: newTurnCount, updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));

      // Generate transcript
      const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: smsBody },
      ];

      await closeSmsSession(
        conversation.id,
        conversation.projectId,
        contact.id,
        conversationHistory,
      );

      // Send a closing message
      const closingMessage = "Thank you for your time! Your feedback is very valuable to us.";
      return new NextResponse(buildTwimlResponse(closingMessage), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    // ── 6. Generate AI follow-up response ────────────────────────────────────
    const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: smsBody },
    ];

    let aiResponse: string;
    try {
      aiResponse = await generateSmsAIResponse(campaign, contact.firstName, conversationHistory);
    } catch (error) {
      console.error(`[twilio-sms-webhook] AI response generation failed for conversation ${conversation.id}:`, error);
      // Return empty response on AI failure
      return new NextResponse(buildEmptyTwimlResponse(), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Append opt-out instruction to the AI response
    const fullResponse = `${aiResponse}\n\n${SMS_OPT_OUT_INSTRUCTION}`;

    // ── 7. Update conversation turn count ────────────────────────────────────
    await db
      .update(conversations)
      .set({ turnCount: newTurnCount, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));

    // ── 8. Close session if this was the last allowed turn ───────────────────
    if (newTurnCount >= SMS_TURN_LIMIT) {
      console.log(
        `[twilio-sms-webhook] Reached turn limit for conversation ${conversation.id}, closing session`,
      );

      await db
        .update(conversations)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));

      // Generate transcript with the full conversation
      const fullHistory: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: smsBody },
        { role: "assistant", content: aiResponse },
      ];

      await closeSmsSession(
        conversation.id,
        conversation.projectId,
        contact.id,
        fullHistory,
      );
    }

    console.log(
      `[twilio-sms-webhook] AI response sent for conversation ${conversation.id} (turn ${newTurnCount})`,
    );

    // ── 9. Return TwiML response with AI reply ───────────────────────────────
    return new NextResponse(buildTwimlResponse(fullResponse), {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error("[twilio-sms-webhook] Unexpected error:", error);
    // Return empty TwiML to prevent Twilio from retrying
    return new NextResponse(buildEmptyTwimlResponse(), {
      status: 500,
      headers: { "Content-Type": "text/xml" },
    });
  }
}
