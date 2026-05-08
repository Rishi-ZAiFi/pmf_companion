/**
 * POST /api/webhooks/vapi
 *
 * Vapi webhook handler for voice call lifecycle events.
 *
 * Vapi sends POST requests with JSON bodies when call state changes.
 * The event type is in the `message.type` field. This handler processes:
 *
 *   - `call-started`  — Update conversation status to `in_progress`
 *   - `transcript`    — Store final transcript chunks (skip partials)
 *   - `call-ended`    — Finalize transcript, enqueue `analyze-transcript` job
 *
 * Conversations are looked up by `externalId` = Vapi call ID, which is
 * stored by the `send-voice` worker when the call is initiated.
 *
 * Requirements: 12.5
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations } from "@/db/schema/conversations";
import { contacts } from "@/db/schema/contacts";
import { transcripts } from "@/db/schema/transcripts";
import { analyzeTranscriptQueue } from "@/lib/queues";
import { uploadRecordingFromUrl } from "@/lib/s3";

// ── Vapi payload types ────────────────────────────────────────────────────────

interface VapiCallStartedMessage {
  type: "call-started";
  call: {
    id: string;
    status: string;
  };
}

interface VapiTranscriptMessage {
  type: "transcript";
  call: { id: string };
  role: "assistant" | "user";
  transcriptType: "partial" | "final";
  transcript: string;
}

interface VapiCallEndedMessage {
  type: "call-ended";
  call: {
    id: string;
    status: string;
    endedReason?: string;
    artifact?: {
      transcript?: string;
      recordingUrl?: string;
    };
  };
}

type VapiMessage =
  | VapiCallStartedMessage
  | VapiTranscriptMessage
  | VapiCallEndedMessage;

interface VapiWebhookPayload {
  message: VapiMessage;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map a Vapi transcript role to a human-readable prefix for the transcript content.
 */
function rolePrefix(role: "assistant" | "user"): string {
  return role === "assistant" ? "Agent" : "Contact";
}

/**
 * Vapi `endedReason` values that indicate the contact ended or declined the call.
 * Requirement 12.8: These reasons trigger opt-out marking.
 */
const OPT_OUT_ENDED_REASONS = new Set([
  "customer-ended-call",
  "customer-declined",
  "customer-did-not-answer",
  "customer-busy",
]);

/**
 * Phrases in the transcript that indicate the contact wants to opt out.
 * Requirement 12.8: Transcript-based opt-out detection.
 */
const OPT_OUT_PHRASES = [
  "stop",
  "unsubscribe",
  "remove me",
  "don't want to talk",
  "end the call",
  "hang up",
  "not interested",
];

/**
 * Returns true if the transcript content contains any opt-out phrase.
 */
function transcriptContainsOptOut(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return OPT_OUT_PHRASES.some((phrase) => lower.includes(phrase));
}

// ── Event handlers ────────────────────────────────────────────────────────────

/**
 * Handle `call-started` event.
 * Finds the conversation by externalId and updates status to `in_progress`
 * if it is still `pending` (guards against duplicate events).
 */
async function handleCallStarted(message: VapiCallStartedMessage): Promise<void> {
  const vapiCallId = message.call.id;

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.externalId, vapiCallId))
    .limit(1);

  if (!conversation) {
    console.warn(`[vapi-webhook] call-started: no conversation found for Vapi call ID ${vapiCallId}`);
    return;
  }

  if (conversation.status !== "pending") {
    console.log(
      `[vapi-webhook] call-started: conversation ${conversation.id} already in status '${conversation.status}', skipping`,
    );
    return;
  }

  await db
    .update(conversations)
    .set({ status: "in_progress", updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id));

  console.log(
    `[vapi-webhook] call-started: conversation ${conversation.id} updated to in_progress (Vapi call ${vapiCallId})`,
  );
}

/**
 * Handle `transcript` event.
 * Only processes `transcriptType === "final"` chunks to avoid noise from partials.
 * Finds or creates a `transcripts` record for the conversation and appends the chunk.
 */
async function handleTranscript(message: VapiTranscriptMessage): Promise<void> {
  // Skip partial transcript chunks — only persist final chunks
  if (message.transcriptType !== "final") {
    return;
  }

  const vapiCallId = message.call.id;
  const chunk = `${rolePrefix(message.role)}: ${message.transcript}`;

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.externalId, vapiCallId))
    .limit(1);

  if (!conversation) {
    console.warn(`[vapi-webhook] transcript: no conversation found for Vapi call ID ${vapiCallId}`);
    return;
  }

  // Find existing transcript record for this conversation
  const [existing] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.conversationId, conversation.id))
    .limit(1);

  if (existing) {
    // Append the new chunk to the existing content
    const updatedContent = existing.content
      ? `${existing.content}\n${chunk}`
      : chunk;

    await db
      .update(transcripts)
      .set({ content: updatedContent })
      .where(eq(transcripts.id, existing.id));

    console.log(
      `[vapi-webhook] transcript: appended chunk to transcript ${existing.id} for conversation ${conversation.id}`,
    );
  } else {
    // Create a new transcript record with the first chunk
    const [created] = await db
      .insert(transcripts)
      .values({
        conversationId: conversation.id,
        projectId: conversation.projectId,
        content: chunk,
      })
      .returning();

    console.log(
      `[vapi-webhook] transcript: created transcript ${created.id} for conversation ${conversation.id}`,
    );
  }
}

/**
 * Handle `call-ended` event.
 * Updates conversation status to `completed` (or `opted_out` if the contact
 * declined or requested to end the call), upserts the full transcript
 * (if provided in the artifact), stores the recording URL, and enqueues
 * an `analyze-transcript` job.
 *
 * Requirement 12.5: transcript must be available within 5 minutes of call end.
 * Requirement 12.8: If the contact declines or opts out, mark them as opted_out_voice.
 */
async function handleCallEnded(message: VapiCallEndedMessage): Promise<void> {
  const vapiCallId = message.call.id;
  const endedReason = message.call.endedReason;

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.externalId, vapiCallId))
    .limit(1);

  if (!conversation) {
    console.warn(`[vapi-webhook] call-ended: no conversation found for Vapi call ID ${vapiCallId}`);
    return;
  }

  const artifactTranscript = message.call.artifact?.transcript;
  const recordingUrl = message.call.artifact?.recordingUrl;

  // ── Opt-out detection (Requirement 12.8) ────────────────────────────────
  // Check endedReason or transcript content for opt-out signals.
  const endedReasonOptOut = endedReason != null && OPT_OUT_ENDED_REASONS.has(endedReason);
  const transcriptOptOut =
    artifactTranscript != null && transcriptContainsOptOut(artifactTranscript);
  const isOptOut = endedReasonOptOut || transcriptOptOut;

  const finalStatus = isOptOut ? "opted_out" : "completed";

  // Mark conversation with the appropriate final status
  await db
    .update(conversations)
    .set({ status: finalStatus, updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id));

  console.log(
    `[vapi-webhook] call-ended: conversation ${conversation.id} marked as ${finalStatus} (reason: ${endedReason ?? "unknown"})`,
  );

  // If opted out, mark the contact as opted_out_voice (Requirement 12.8)
  if (isOptOut) {
    await db
      .update(contacts)
      .set({ optedOutVoice: true, updatedAt: new Date() })
      .where(eq(contacts.id, conversation.contactId));

    console.log(
      `[vapi-webhook] call-ended: contact ${conversation.contactId} marked as opted_out_voice` +
        (endedReasonOptOut ? ` (endedReason: ${endedReason})` : "") +
        (transcriptOptOut ? " (opt-out phrase detected in transcript)" : ""),
    );
  }

  // Find existing transcript record (may have been built up from incremental chunks)
  const [existing] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.conversationId, conversation.id))
    .limit(1);

  let transcriptId: string;

  if (existing) {
    // Update the existing record with the full transcript (recording URL added below)
    const updates: Partial<typeof transcripts.$inferInsert> = {};

    if (artifactTranscript) {
      // The artifact transcript is the authoritative full transcript from Vapi —
      // replace the incrementally-built content with the complete version.
      updates.content = artifactTranscript;
    }

    if (Object.keys(updates).length > 0) {
      await db
        .update(transcripts)
        .set(updates)
        .where(eq(transcripts.id, existing.id));
    }

    transcriptId = existing.id;

    console.log(
      `[vapi-webhook] call-ended: updated transcript ${transcriptId} for conversation ${conversation.id}`,
    );
  } else {
    // No incremental transcript was built — create a new record now.
    // Use the artifact transcript if available, otherwise use a placeholder.
    const content = artifactTranscript ?? "";

    const [created] = await db
      .insert(transcripts)
      .values({
        conversationId: conversation.id,
        projectId: conversation.projectId,
        content,
      })
      .returning();

    transcriptId = created.id;

    console.log(
      `[vapi-webhook] call-ended: created transcript ${transcriptId} for conversation ${conversation.id}`,
    );
  }

  // Upload recording to S3 and store the permanent S3 URL (Requirement 12.7)
  // Errors are caught and logged — we never fail the webhook due to S3 issues.
  if (recordingUrl) {
    try {
      const s3Key = `recordings/${conversation.projectId}/${transcriptId}.mp3`;
      const s3Url = await uploadRecordingFromUrl(recordingUrl, s3Key);

      await db
        .update(transcripts)
        .set({ recordingUrl: s3Url })
        .where(eq(transcripts.id, transcriptId));

      console.log(
        `[vapi-webhook] call-ended: recording uploaded to S3 for transcript ${transcriptId} (key: ${s3Key})`,
      );
    } catch (s3Error) {
      console.error(
        `[vapi-webhook] call-ended: failed to upload recording to S3 for transcript ${transcriptId}:`,
        s3Error,
      );
      // Do not rethrow — S3 failure must not fail the webhook response
    }
  }

  // Enqueue the analyze-transcript job (Requirement 12.5)
  // The worker will call OpenAI to extract insights and create Active Signal records.
  await analyzeTranscriptQueue.add(
    "analyze-transcript",
    {
      transcriptId,
      conversationId: conversation.id,
      projectId: conversation.projectId,
    },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      // Deduplicate: only one pending analysis job per transcript
      jobId: `analyze-transcript:${transcriptId}`,
    },
  );

  console.log(
    `[vapi-webhook] call-ended: enqueued analyze-transcript job for transcript ${transcriptId}`,
  );
}

// ── Webhook Handler ───────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/vapi
 *
 * Handles Vapi voice call lifecycle webhook events.
 * Requirements: 12.5
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as VapiWebhookPayload;

    if (!body?.message?.type) {
      console.warn("[vapi-webhook] Missing message.type in payload");
      return NextResponse.json({ error: "Missing message.type" }, { status: 400 });
    }

    const { message } = body;

    switch (message.type) {
      case "call-started":
        await handleCallStarted(message);
        return NextResponse.json({ received: true, event: "call-started" });

      case "transcript":
        await handleTranscript(message);
        return NextResponse.json({ received: true, event: "transcript" });

      case "call-ended":
        await handleCallEnded(message);
        return NextResponse.json({ received: true, event: "call-ended" });

      default: {
        // Narrow the type to access `.type` safely on the unknown variant
        const unknownType = (message as { type: string }).type;
        console.warn(`[vapi-webhook] Unknown event type: ${unknownType}`);
        return NextResponse.json(
          { error: `Unknown event type: ${unknownType}` },
          { status: 400 },
        );
      }
    }
  } catch (error) {
    console.error("[vapi-webhook] Unexpected error:", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
