import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { pmfScoreSnapshots } from "@/db/schema/pmf-score-snapshots";
import { requireAuth } from "@/lib/require-auth";

// ── Constants ────────────────────────────────────────────────────────────────

/** Requirement 15.6: confidence warning threshold */
const CONFIDENCE_WARNING_THRESHOLD = 40;

/** Requirement 15.3: trend chart covers the past 90 days */
const TREND_DAYS = 90;

// ── GET /api/projects/:id/pmf-score ─────────────────────────────────────────

/**
 * Returns the current PMF score and a 90-day trend for a project.
 *
 * Response shape:
 * ```json
 * {
 *   "score": 42.50,
 *   "responseCount": 120,
 *   "segmentScores": { "power_user": 65.00, "trial": 28.00 },
 *   "snapshotDate": "2024-01-15",
 *   "confidenceWarning": false,
 *   "trend": [
 *     { "date": "2023-10-17", "score": 38.00, "responseCount": 95 },
 *     ...
 *   ]
 * }
 * ```
 *
 * When no snapshots exist for the project, returns:
 * ```json
 * {
 *   "score": null,
 *   "responseCount": 0,
 *   "segmentScores": {},
 *   "snapshotDate": null,
 *   "confidenceWarning": true,
 *   "trend": []
 * }
 * ```
 *
 * Responses:
 *   200 — PMF score data with trend array.
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 *
 * Requirements: 15.3, 15.6
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

    // ── 2. Query snapshots for the past 90 days, ordered by date ASC ──────
    // We use a raw SQL query to leverage the date arithmetic cleanly.
    // All user-supplied values are parameterised to prevent injection.
    const snapshots = await db
      .select({
        id: pmfScoreSnapshots.id,
        score: pmfScoreSnapshots.score,
        responseCount: pmfScoreSnapshots.responseCount,
        segmentScores: pmfScoreSnapshots.segmentScores,
        snapshotDate: pmfScoreSnapshots.snapshotDate,
      })
      .from(pmfScoreSnapshots)
      .where(
        sql`${pmfScoreSnapshots.projectId} = ${projectId}
          AND ${pmfScoreSnapshots.snapshotDate} >= (CURRENT_DATE - INTERVAL '${sql.raw(String(TREND_DAYS))} days')`,
      )
      .orderBy(pmfScoreSnapshots.snapshotDate);

    // ── 3. Build the trend array (all snapshots, date ASC) ────────────────
    const trend = snapshots.map((s) => ({
      date: s.snapshotDate,
      score: Number(s.score),
      responseCount: s.responseCount,
    }));

    // ── 4. Extract the most recent snapshot for top-level fields ──────────
    // Snapshots are ordered ASC, so the last element is the most recent.
    const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

    if (!latest) {
      // No snapshots yet — return empty state with confidence warning
      return NextResponse.json({
        score: null,
        responseCount: 0,
        segmentScores: {},
        snapshotDate: null,
        // Requirement 15.6: fewer than 40 responses → confidence warning
        confidenceWarning: true,
        trend: [],
      });
    }

    // ── 5. Build and return the response ──────────────────────────────────
    return NextResponse.json({
      score: Number(latest.score),
      responseCount: latest.responseCount,
      segmentScores: latest.segmentScores ?? {},
      snapshotDate: latest.snapshotDate,
      // Requirement 15.6: warn when sample size is below the threshold
      confidenceWarning: latest.responseCount < CONFIDENCE_WARNING_THRESHOLD,
      trend,
    });
  } catch (err) {
    console.error("[GET /api/projects/:id/pmf-score] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
