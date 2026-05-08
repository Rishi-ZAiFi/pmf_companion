import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { requireAuth } from "@/lib/require-auth";
import { writeAuditLog } from "@/lib/audit-log";

// ── Validation schema ────────────────────────────────────────────────────────

const VALID_SOURCES = [
  "reddit",
  "twitter",
  "hn",
  "linkedin",
  "review",
  "email",
  "sms",
  "voice",
  "widget",
] as const;

const VALID_TYPES = [
  "pain_point",
  "feature_request",
  "competitor_mention",
  "market_trend",
  "positive_sentiment",
  "negative_sentiment",
] as const;

const VALID_SENTIMENTS = ["positive", "neutral", "negative"] as const;

const VALID_SORTS = ["composite_score", "recency", "relevance"] as const;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  source: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((s) => s.trim())
            .filter((s) => (VALID_SOURCES as readonly string[]).includes(s))
        : undefined,
    ),
  type: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((s) => s.trim())
            .filter((s) => (VALID_TYPES as readonly string[]).includes(s))
        : undefined,
    ),
  sentiment: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((s) => s.trim())
            .filter((s) => (VALID_SENTIMENTS as readonly string[]).includes(s))
        : undefined,
    ),
  min_relevance: z.coerce.number().int().min(0).max(100).optional(),
  date_from: z.string().datetime({ offset: true }).optional(),
  date_to: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(VALID_SORTS).default("composite_score"),
});

// ── Sort column mapping ──────────────────────────────────────────────────────

const SORT_COLUMN: Record<(typeof VALID_SORTS)[number], string> = {
  composite_score: "composite_score DESC",
  recency: "ingested_at DESC",
  relevance: "relevance_score DESC",
};

// ── GET /api/projects/:id/signals ────────────────────────────────────────────

/**
 * Returns a paginated, filtered, and sorted list of signals for a project
 * from the `signal_feed_mv` materialized view.
 *
 * Query parameters:
 *   page          — Page number (default: 1)
 *   limit         — Results per page (default: 50, max: 100)
 *   source        — Comma-separated list of sources to filter by
 *   type          — Comma-separated list of signal types to filter by
 *   sentiment     — Comma-separated list of sentiments to filter by
 *   min_relevance — Minimum relevance score (0–100)
 *   date_from     — ISO8601 date string (lower bound on ingested_at)
 *   date_to       — ISO8601 date string (upper bound on ingested_at)
 *   sort          — Sort order: composite_score | recency | relevance
 *
 * Responses:
 *   200 — { data: Signal[], pagination: { page, limit, total } }
 *   400 — Validation error.
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id: projectId } = await params;

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

  const { page, limit, source, type, sentiment, min_relevance, date_from, date_to, sort } =
    parsed.data;

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

    // ── 3. Build parameterized WHERE clauses ─────────────────────────────
    // We use db.execute(sql`...`) because Drizzle does not natively support
    // querying materialized views. All user-supplied values are passed as
    // bound parameters to prevent SQL injection.

    const conditions: ReturnType<typeof sql>[] = [
      sql`project_id = ${projectId}`,
    ];

    if (source && source.length > 0) {
      // Cast to text[] for the ANY operator
      conditions.push(sql`source = ANY(${source}::text[])`);
    }

    if (type && type.length > 0) {
      conditions.push(sql`signal_type = ANY(${type}::text[])`);
    }

    if (sentiment && sentiment.length > 0) {
      conditions.push(sql`sentiment = ANY(${sentiment}::text[])`);
    }

    if (min_relevance !== undefined) {
      conditions.push(sql`relevance_score >= ${min_relevance}`);
    }

    if (date_from) {
      conditions.push(sql`ingested_at >= ${date_from}::timestamptz`);
    }

    if (date_to) {
      conditions.push(sql`ingested_at <= ${date_to}::timestamptz`);
    }

    // Combine all conditions with AND
    const whereClause = conditions.reduce(
      (acc, cond) => sql`${acc} AND ${cond}`,
    );

    const orderClause = sql.raw(SORT_COLUMN[sort]);
    const offset = (page - 1) * limit;

    // ── 4. Execute count query ────────────────────────────────────────────
    const countResult = await db.execute<{ total: string }>(
      sql`SELECT COUNT(*)::int AS total FROM signal_feed_mv WHERE ${whereClause}`,
    );
    const total = Number(countResult[0]?.total ?? 0);

    // ── 5. Execute data query ─────────────────────────────────────────────
    const dataResult = await db.execute(
      sql`SELECT * FROM signal_feed_mv WHERE ${whereClause} ORDER BY ${orderClause} LIMIT ${limit} OFFSET ${offset}`,
    );

    // ── 6. Write audit log (non-blocking) ────────────────────────────────
    void writeAuditLog({
      accountId,
      actorId: accountId,
      action: "signal.read",
      resourceType: "signal",
      resourceId: projectId,
      metadata: {
        projectId,
        page,
        limit,
        total,
        filters: { source, type, sentiment, min_relevance, date_from, date_to, sort },
      },
    });

    return NextResponse.json({
      data: dataResult,
      pagination: {
        page,
        limit,
        total,
      },
    });
  } catch (err) {
    console.error("[GET /api/projects/:id/signals] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
