import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { themeClusters } from "@/db/schema/theme-clusters";
import { requireAuth } from "@/lib/require-auth";

// ── Validation schema ────────────────────────────────────────────────────────

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ── GET /api/projects/:id/clusters/:cid/signals ──────────────────────────────

/**
 * Returns a paginated list of all Signals belonging to a specific Theme Cluster.
 *
 * Signals are joined from `signal_cluster_memberships` and ordered by
 * `relevance_score DESC` (composite_score is not stored directly on the
 * signals table; the materialized view is not used here since we are
 * filtering by cluster membership rather than the full feed).
 *
 * Query parameters:
 *   page  — Page number (default: 1)
 *   limit — Results per page (default: 50, max: 100)
 *
 * Responses:
 *   200 — { data: Signal[], pagination: { page, limit, total } }
 *   400 — Validation error.
 *   401 — Not authenticated.
 *   404 — Project not found, or cluster not found / does not belong to project.
 *   500 — Unexpected server error.
 *
 * Requirements: 16.3
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; cid: string }> },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id: projectId, cid: clusterId } = await params;

  // ── 1. Parse and validate query parameters ───────────────────────────────
  const searchParams = request.nextUrl.searchParams;
  const rawParams: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    rawParams[key] = value;
  });

  const parsed = querySchema.safeParse(rawParams);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const { page, limit } = parsed.data;

  try {
    // ── 2. Verify project exists and belongs to the authenticated account ──
    const [project] = await db
      .select({ id: projects.id, accountId: projects.accountId, status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project || project.accountId !== accountId || project.status === "deleted") {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // ── 3. Verify the cluster exists and belongs to this project ──────────
    const [cluster] = await db
      .select({ id: themeClusters.id, projectId: themeClusters.projectId })
      .from(themeClusters)
      .where(eq(themeClusters.id, clusterId))
      .limit(1);

    if (!cluster || cluster.projectId !== projectId) {
      return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
    }

    const offset = (page - 1) * limit;

    // ── 4. Count total signals in the cluster ─────────────────────────────
    const countResult = await db.execute<{ total: string }>(
      sql`
        SELECT COUNT(*)::int AS total
        FROM signal_cluster_memberships scm
        JOIN signals s ON s.id = scm.signal_id
        WHERE scm.cluster_id = ${clusterId}
          AND s.project_id = ${projectId}
      `,
    );
    const total = Number(countResult[0]?.total ?? 0);

    // ── 5. Fetch paginated signals for the cluster ────────────────────────
    // Returns the signal fields specified in the task requirements,
    // ordered by relevance_score DESC.
    const dataResult = await db.execute(
      sql`
        SELECT
          s.id,
          s.source,
          s.signal_type,
          s.signal_kind,
          s.content,
          s.source_url,
          s.author,
          s.relevance_score,
          s.sentiment,
          s.pain_intensity,
          s.is_opportunity,
          s.is_bookmarked,
          s.custom_label,
          s.is_dismissed,
          s.status,
          s.ingested_at
        FROM signal_cluster_memberships scm
        JOIN signals s ON s.id = scm.signal_id
        WHERE scm.cluster_id = ${clusterId}
          AND s.project_id = ${projectId}
        ORDER BY s.relevance_score DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `,
    );

    return NextResponse.json({
      data: dataResult,
      pagination: {
        page,
        limit,
        total,
      },
    });
  } catch (err) {
    console.error(
      "[GET /api/projects/:id/clusters/:cid/signals] Unexpected error:",
      err,
    );
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
