import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { signals } from "@/db/schema/signals";
import { requireAuth } from "@/lib/require-auth";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Sources considered for competitor gap analysis.
 * Requirement 18.1: review sites and social sources.
 */
const COMPETITOR_GAP_SOURCES = ["review", "twitter", "reddit", "linkedin", "hn"] as const;

/**
 * Signal types that indicate a competitor weakness / unmet need.
 * Requirement 18.1: competitor weakness signals.
 */
const COMPETITOR_WEAKNESS_TYPES = [
  "competitor_mention",
  "negative_sentiment",
] as const;

/**
 * Number of characters used as a proxy grouping key for semantic similarity.
 * Full embedding-based grouping would require the clustering worker.
 */
const GROUP_KEY_CONTENT_LENGTH = 100;

// ── Types ────────────────────────────────────────────────────────────────────

interface GapGroup {
  /** The content of the most relevant signal in the group (highest relevance_score). */
  need_description: string;
  /** Total number of signals supporting this gap. */
  signal_count: number;
  /** Deduplicated list of competitor names associated with this gap. */
  competitors: string[];
  /** Internal: best relevance score seen in this group (for picking representative signal). */
  _best_relevance: number;
}

// ── GET /api/projects/:id/competitor-gaps ────────────────────────────────────

/**
 * Returns the competitor gap map for a project.
 *
 * Aggregates competitor weakness signals (is_opportunity = true OR
 * signal_type IN ('competitor_mention', 'negative_sentiment')) from review
 * sites and social sources, groups them by signal_type + first 100 chars of
 * content as a proxy for semantic similarity, and returns each group with:
 *   - need_description: content of the most relevant signal in the group
 *   - signal_count: number of supporting signals
 *   - competitors: list of competitor names extracted from signal metadata
 *     or inferred from project.competitor_names appearing in signal content
 *
 * Results are sorted by signal_count DESC.
 *
 * Response shape:
 * ```json
 * {
 *   "data": [
 *     {
 *       "need_description": "Users complain about slow onboarding...",
 *       "signal_count": 12,
 *       "competitors": ["Acme", "Globex"]
 *     }
 *   ]
 * }
 * ```
 *
 * Responses:
 *   200 — Array of gap objects sorted by signal_count DESC.
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 *
 * Requirements: 18.1, 18.2
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
        competitorNames: projects.competitorNames,
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

    const competitorNames: string[] = project.competitorNames ?? [];

    // ── 2. Fetch competitor weakness signals from relevant sources ─────────
    // A signal qualifies if:
    //   - it belongs to this project
    //   - it comes from a competitor-gap-relevant source
    //   - it is either flagged as an opportunity OR has a weakness signal type
    //   - it has not been dismissed or excluded
    const rawSignals = await db
      .select({
        id: signals.id,
        content: signals.content,
        signalType: signals.signalType,
        relevanceScore: signals.relevanceScore,
        metadata: signals.metadata,
      })
      .from(signals)
      .where(
        sql`
          ${signals.projectId} = ${projectId}
          AND ${signals.source} = ANY(${COMPETITOR_GAP_SOURCES}::text[])
          AND (
            ${signals.isOpportunity} = true
            OR ${signals.signalType} = ANY(${COMPETITOR_WEAKNESS_TYPES}::text[])
          )
          AND ${signals.isDismissed} = false
          AND ${signals.status} != 'excluded'
        `,
      );

    if (rawSignals.length === 0) {
      return NextResponse.json({ data: [] });
    }

    // ── 3. Group signals by (signal_type + first 100 chars of content) ─────
    // This is a lightweight proxy for semantic grouping. Full embedding-based
    // grouping would require the clustering worker.
    const gapMap = new Map<string, GapGroup>();

    for (const signal of rawSignals) {
      // Build the grouping key
      const contentPrefix = signal.content.slice(0, GROUP_KEY_CONTENT_LENGTH).trim();
      const groupKey = `${signal.signalType}::${contentPrefix}`;

      // Extract competitor name from metadata if present
      const metadata = (signal.metadata ?? {}) as Record<string, unknown>;
      const metadataCompetitor =
        typeof metadata["competitor"] === "string" ? metadata["competitor"] : null;

      // Infer competitors from project.competitor_names appearing in signal content
      const contentLower = signal.content.toLowerCase();
      const inferredCompetitors = competitorNames.filter((name) =>
        contentLower.includes(name.toLowerCase()),
      );

      // Combine: metadata competitor + inferred competitors (deduplicated)
      const signalCompetitors = new Set<string>();
      if (metadataCompetitor) {
        signalCompetitors.add(metadataCompetitor);
      }
      for (const name of inferredCompetitors) {
        signalCompetitors.add(name);
      }

      const existing = gapMap.get(groupKey);
      if (!existing) {
        gapMap.set(groupKey, {
          need_description: signal.content,
          signal_count: 1,
          competitors: Array.from(signalCompetitors),
          _best_relevance: signal.relevanceScore,
        });
      } else {
        // Increment count
        existing.signal_count += 1;

        // Update representative signal if this one has a higher relevance score
        if (signal.relevanceScore > existing._best_relevance) {
          existing.need_description = signal.content;
          existing._best_relevance = signal.relevanceScore;
        }

        // Merge competitor names (deduplicated)
        const competitorSet = new Set(existing.competitors);
        signalCompetitors.forEach((name) => competitorSet.add(name));
        existing.competitors = Array.from(competitorSet);
      }
    }

    // ── 4. Sort by signal_count DESC and strip internal fields ────────────
    const data = Array.from(gapMap.values())
      .sort((a, b) => b.signal_count - a.signal_count)
      .map(({ need_description, signal_count, competitors }) => ({
        need_description,
        signal_count,
        competitors,
      }));

    return NextResponse.json({ data });
  } catch (err) {
    console.error(
      "[GET /api/projects/:id/competitor-gaps] Unexpected error:",
      err,
    );
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
