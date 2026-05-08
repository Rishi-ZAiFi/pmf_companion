/**
 * GET /api/projects/:id/transcripts/:tid
 *
 * Returns a single transcript with its analysis results and, if a recording
 * exists, a pre-signed S3 URL for playback (valid for 1 hour).
 *
 * The transcript must belong to the specified project (validated via the
 * conversations join). The project must belong to the authenticated account.
 *
 * Responses:
 *   200 — Transcript object with optional `recordingPresignedUrl`.
 *   401 — Not authenticated.
 *   403 — Project does not belong to the authenticated account.
 *   404 — Transcript not found or does not belong to the project.
 *   500 — Unexpected server error.
 *
 * Requirements: 12.7
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { transcripts } from "@/db/schema/transcripts";
import { conversations } from "@/db/schema/conversations";
import { projects } from "@/db/schema/projects";
import { requireAuth } from "@/lib/require-auth";
import { getPresignedUrl } from "@/lib/s3";
import { writeAuditLog } from "@/lib/audit-log";

// ── Helper: extract S3 key from a stored S3 URL ───────────────────────────────

/**
 * Extracts the S3 object key from a stored S3 HTTPS URL.
 *
 * Expected format: `https://<bucket>.s3.<region>.amazonaws.com/<key>`
 *
 * Returns `null` if the URL cannot be parsed (e.g. it's a legacy Vapi URL).
 */
function extractS3Key(s3Url: string): string | null {
  try {
    const url = new URL(s3Url);
    // pathname starts with '/', strip the leading slash
    const key = url.pathname.replace(/^\//, "");
    return key || null;
  } catch {
    return null;
  }
}

// ── GET /api/projects/:id/transcripts/:tid ────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tid: string }> },
): Promise<NextResponse> {
  // 1. Authenticate
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id: projectId, tid: transcriptId } = await params;

  try {
    // 2. Verify the project exists and belongs to the authenticated account
    const [project] = await db
      .select({ id: projects.id, accountId: projects.accountId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (project.accountId !== accountId) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403 },
      );
    }

    // 3. Load the transcript, verifying it belongs to this project via the
    //    conversations join (transcripts.projectId is denormalized but we
    //    also confirm via the conversations table for integrity).
    const [transcript] = await db
      .select({
        id: transcripts.id,
        conversationId: transcripts.conversationId,
        projectId: transcripts.projectId,
        content: transcripts.content,
        sentiment: transcripts.sentiment,
        painIntensity: transcripts.painIntensity,
        wtpSignal: transcripts.wtpSignal,
        competitorMentions: transcripts.competitorMentions,
        topQuotes: transcripts.topQuotes,
        recordingUrl: transcripts.recordingUrl,
        analyzedAt: transcripts.analyzedAt,
        createdAt: transcripts.createdAt,
      })
      .from(transcripts)
      .innerJoin(conversations, eq(transcripts.conversationId, conversations.id))
      .where(
        and(
          eq(transcripts.id, transcriptId),
          eq(transcripts.projectId, projectId),
          eq(conversations.projectId, projectId),
        ),
      )
      .limit(1);

    if (!transcript) {
      return NextResponse.json(
        { error: "Transcript not found" },
        { status: 404 },
      );
    }

    // 4. Generate a pre-signed URL for recording playback if a recording exists
    let recordingPresignedUrl: string | null = null;

    if (transcript.recordingUrl) {
      const s3Key = extractS3Key(transcript.recordingUrl);
      if (s3Key) {
        try {
          recordingPresignedUrl = await getPresignedUrl(s3Key, 3600);
        } catch (presignError) {
          // Log but don't fail the request — the transcript data is still useful
          console.error(
            `[GET /api/projects/:id/transcripts/:tid] Failed to generate pre-signed URL for transcript ${transcriptId}:`,
            presignError,
          );
        }
      }
    }

    // 5. Return the transcript with the pre-signed URL
    // Write audit log (non-blocking)
    void writeAuditLog({
      accountId,
      actorId: accountId,
      action: "transcript.read",
      resourceType: "transcript",
      resourceId: transcriptId,
      metadata: {
        projectId,
        transcriptId,
        hasRecording: !!transcript.recordingUrl,
      },
    });

    return NextResponse.json({
      id: transcript.id,
      conversationId: transcript.conversationId,
      projectId: transcript.projectId,
      content: transcript.content,
      sentiment: transcript.sentiment,
      painIntensity: transcript.painIntensity,
      wtpSignal: transcript.wtpSignal,
      competitorMentions: transcript.competitorMentions,
      topQuotes: transcript.topQuotes,
      analyzedAt: transcript.analyzedAt,
      createdAt: transcript.createdAt,
      recordingPresignedUrl,
    });
  } catch (err) {
    console.error("[GET /api/projects/:id/transcripts/:tid] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
