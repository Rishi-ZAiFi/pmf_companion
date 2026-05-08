import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { themeClusters } from "@/db/schema/theme-clusters";
import { requireAuth } from "@/lib/require-auth";

// ── Constants ────────────────────────────────────────────────────────────────

/** Number of representative quotes to return per cluster (Requirement 16.2) */
const MAX_REPRESENTATIVE_QUOTES = 3;

// ── GET /api/projects/:id/clusters ──────────────────────────────────────────

/**
 * Returns all non-dismissed Theme Clusters for a project, sorted by
 * signal_count descending. For each cluster, includes up to 3 representative
 * quotes (signal content strings) ordered by relevance_score DESC.
 *
 * Also recalculates and persists `trend_direction` for each cluster based on
 * signal ingestion rate:
 *   - last 7 days > prior 7 days  → "growing"
 *   - last 7 days = prior 7 days  → "stable"
 *   - last 7 days < prior 7 days  → "declining"
 *
 * Response shape:
 * ```json
 * {
 *   "data": [
 *     {
 *       "id": "uuid",
 *       "name": "Onboarding friction",
 *       "summary": "Users struggle with...",
 *       "signal_count": 42,
 *       "trend_direction": "growing",
 *       "is_dismissed": false,
 *       "created_at": "2024-01-15T10:00:00Z",
 *       "representative_quotes": ["quote 1", "quote 2", "quote 3"]
 *     }
 *   ]
 * }
 * ```
 *
 * Responses:
 *   200 — Array of cluster objects.
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 *
 * Requirements: 16.1, 16.2
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

    // ── 2. Load all non-dismissed clusters for the project ────────────────
    const clusters = await db
      .select()
      .from(themeClusters)
      .where(
        sql`${themeClusters.projectId} = ${projectId}
          AND ${themeClusters.isDismissed} = false`,
      )
      .orderBy(sql`${themeClusters.signalCount} DESC`);

    if (clusters.length === 0) {
      return NextResponse.json({ data: [] });
    }

    // ── 3. Calculate trend_direction for each cluster ─────────────────────
    // Compare signal ingestion rate in the last 7 days vs the 7 days before.
    // We do this in a single batch query to avoid N+1 queries.
    //
    // Result shape per row: { cluster_id, recent_count, prior_count }
    const clusterIds = clusters.map((c) => c.id);

    const trendRows = await db.execute<{
      cluster_id: string;
      recent_count: string;
      prior_count: string;
    }>(
      sql`
        SELECT
          scm.cluster_id,
          COUNT(*) FILTER (
            WHERE s.ingested_at >= now() - INTERVAL '7 days'
          )::int AS recent_count,
          COUNT(*) FILTER (
            WHERE s.ingested_at >= now() - INTERVAL '14 days'
              AND s.ingested_at < now() - INTERVAL '7 days'
          )::int AS prior_count
        FROM signal_cluster_memberships scm
        JOIN signals s ON s.id = scm.signal_id
        WHERE scm.cluster_id = ANY(${clusterIds}::uuid[])
        GROUP BY scm.cluster_id
      `,
    );

    // Build a lookup map: cluster_id → trend_direction
    const trendMap = new Map<string, "growing" | "stable" | "declining">();
    for (const row of trendRows) {
      const recent = Number(row.recent_count);
      const prior = Number(row.prior_count);
      let direction: "growing" | "stable" | "declining";
      if (recent > prior) {
        direction = "growing";
      } else if (recent < prior) {
        direction = "declining";
      } else {
        direction = "stable";
      }
      trendMap.set(row.cluster_id, direction);
    }

    // ── 4. Persist updated trend_direction values ─────────────────────────
    // Only update clusters whose trend_direction has changed to avoid
    // unnecessary writes.
    const updatePromises: Promise<unknown>[] = [];
    for (const cluster of clusters) {
      const newDirection = trendMap.get(cluster.id) ?? "stable";
      if (newDirection !== cluster.trendDirection) {
        updatePromises.push(
          db
            .update(themeClusters)
            .set({ trendDirection: newDirection, updatedAt: new Date() })
            .where(eq(themeClusters.id, cluster.id)),
        );
      }
    }
    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
    }

    // ── 5. Fetch representative quotes for all clusters in one query ───────
    // For each cluster, return up to MAX_REPRESENTATIVE_QUOTES signal content
    // strings ordered by relevance_score DESC.
    //
    // We use a LATERAL join with LIMIT to efficiently fetch the top N quotes
    // per cluster in a single round-trip.
    const quotesRows = await db.execute<{
      cluster_id: string;
      content: string;
    }>(
      sql`
        SELECT
          scm.cluster_id,
          s.content
        FROM signal_cluster_memberships scm
        JOIN signals s ON s.id = scm.signal_id
        WHERE scm.cluster_id = ANY(${clusterIds}::uuid[])
          AND s.status != 'excluded'
        ORDER BY scm.cluster_id, s.relevance_score DESC
      `,
    );

    // Group quotes by cluster_id, keeping only the top N per cluster
    const quotesMap = new Map<string, string[]>();
    for (const row of quotesRows) {
      const existing = quotesMap.get(row.cluster_id) ?? [];
      if (existing.length < MAX_REPRESENTATIVE_QUOTES) {
        existing.push(row.content);
        quotesMap.set(row.cluster_id, existing);
      }
    }

    // ── 6. Assemble the response ──────────────────────────────────────────
    const data = clusters.map((cluster) => ({
      id: cluster.id,
      name: cluster.name,
      summary: cluster.summary,
      signal_count: cluster.signalCount,
      trend_direction: trendMap.get(cluster.id) ?? cluster.trendDirection,
      is_dismissed: cluster.isDismissed,
      created_at: cluster.createdAt,
      representative_quotes: quotesMap.get(cluster.id) ?? [],
    }));

    return NextResponse.json({ data });
  } catch (err) {
    console.error("[GET /api/projects/:id/clusters] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
