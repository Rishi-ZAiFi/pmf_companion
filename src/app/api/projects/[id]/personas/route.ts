import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { requireAuth } from "@/lib/require-auth";
import { redisConnection, generatePersonasQueue } from "@/lib/queues";
import type { PersonaGenerationResult } from "@/workers/generate-personas";

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum contacts with signals before persona generation is attempted (Requirement 17.5) */
const MIN_CONTACTS_WITH_SIGNALS = 10;

// ── GET /api/projects/:id/personas ──────────────────────────────────────────

/**
 * Returns the current personas for a project.
 *
 * Behaviour:
 * 1. If cached personas exist in Redis (`personas:{projectId}`), return them immediately.
 * 2. If not cached, trigger persona generation synchronously by enqueuing a
 *    `generate-personas` job and returning a `{ generating: true }` response.
 *    The client should poll again after a few seconds.
 * 3. If fewer than 10 contacts have contributed signals, return a notice
 *    that persona data is insufficient (Requirement 17.5).
 *
 * Response shape (cached personas available):
 * ```json
 * {
 *   "personas": [
 *     {
 *       "name": "The Overwhelmed Founder",
 *       "description": "...",
 *       "primaryPainPoints": ["pain 1", "pain 2"],
 *       "averagePainIntensity": 7.2,
 *       "pmfLikelihood": "high",
 *       "contactCount": 14,
 *       "segmentTags": ["power_user"]
 *     }
 *   ],
 *   "contactsWithSignals": 42,
 *   "generatedAt": "2024-01-15T10:00:00.000Z",
 *   "insufficientData": false
 * }
 * ```
 *
 * Response shape (insufficient data):
 * ```json
 * {
 *   "personas": [],
 *   "contactsWithSignals": 3,
 *   "generatedAt": "2024-01-15T10:00:00.000Z",
 *   "insufficientData": true,
 *   "notice": "Persona data is insufficient. At least 10 contacts with signals are required."
 * }
 * ```
 *
 * Response shape (generation in progress):
 * ```json
 * {
 *   "generating": true,
 *   "message": "Persona generation has been triggered. Please check back in a few seconds."
 * }
 * ```
 *
 * Responses:
 *   200 — Persona data (may include insufficientData flag or generating flag).
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 *
 * Requirements: 17.1, 17.2, 17.5
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id: projectId } = await params;

  try {
    // ── 1. Verify project exists and belongs to the authenticated account ──
    const [project] = await db
      .select({
        id: projects.id,
        accountId: projects.accountId,
        status: projects.status,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (
      !project ||
      project.accountId !== accountId ||
      project.status === "deleted"
    ) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // ── 2. Check Redis cache ───────────────────────────────────────────────
    const cacheKey = `personas:${projectId}`;
    const cached = await redisConnection.get(cacheKey);

    if (cached) {
      const result = JSON.parse(cached) as PersonaGenerationResult;

      if (result.insufficientData) {
        return NextResponse.json({
          personas: [],
          contactsWithSignals: result.contactsWithSignals,
          generatedAt: result.generatedAt,
          insufficientData: true,
          notice: `Persona data is insufficient. At least ${MIN_CONTACTS_WITH_SIGNALS} contacts with signals are required.`,
        });
      }

      return NextResponse.json({
        personas: result.personas,
        contactsWithSignals: result.contactsWithSignals,
        generatedAt: result.generatedAt,
        insufficientData: false,
      });
    }

    // ── 3. No cache — trigger generation and return "generating" response ──
    // Use jobId deduplication so only one pending job exists per project.
    await generatePersonasQueue.add(
      "generate-personas",
      { projectId },
      {
        jobId: `generate-personas:${projectId}`,
        // Remove any existing job with the same ID before adding a new one
        // to avoid stale deduplication blocking re-generation.
      },
    );

    console.log(
      `[GET /api/projects/:id/personas] Triggered persona generation for project ${projectId}`,
    );

    return NextResponse.json(
      {
        generating: true,
        message:
          "Persona generation has been triggered. Please check back in a few seconds.",
      },
      { status: 200 },
    );
  } catch (err) {
    console.error("[GET /api/projects/:id/personas] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
