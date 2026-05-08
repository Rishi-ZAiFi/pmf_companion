import { NextRequest, NextResponse } from "next/server";
import { eq, and, ne, count } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { accounts } from "@/db/schema/accounts";
import { requireAuth } from "@/lib/require-auth";
import { generateKeywordsQueue } from "@/lib/queues";

// ── Plan limits ──────────────────────────────────────────────────────────────

const PLAN_LIMITS: Record<string, number | null> = {
  free: 1,
  starter: 3,
  growth: 10,
  enterprise: null, // unlimited
};

// ── Validation schemas ───────────────────────────────────────────────────────

const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  description: z.string().min(1, "Description is required"),
  icp_description: z.string().min(1, "ICP description is required"),
  problem_statement: z.string().min(1, "Problem statement is required"),
  competitor_names: z
    .array(z.string().min(1))
    .max(5, "Up to 5 competitor names allowed")
    .optional()
    .default([]),
});

// ── GET /api/projects ────────────────────────────────────────────────────────

/**
 * Lists all non-deleted projects for the authenticated account.
 *
 * Responses:
 *   200 — Array of project objects.
 *   401 — Not authenticated.
 *   500 — Unexpected server error.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  try {
    const rows = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.accountId, accountId),
          ne(projects.status, "deleted"),
        ),
      )
      .orderBy(projects.createdAt);

    return NextResponse.json(rows);
  } catch (err) {
    console.error("[GET /api/projects] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}

// ── POST /api/projects ───────────────────────────────────────────────────────

/**
 * Creates a new project for the authenticated account.
 * Enforces plan-level project count limits before creating.
 *
 * Request body (JSON):
 *   {
 *     name: string,
 *     description: string,
 *     icp_description: string,
 *     problem_statement: string,
 *     competitor_names?: string[] (max 5)
 *   }
 *
 * Responses:
 *   201 — Project created. Returns the created project.
 *   400 — Validation error. Returns { error, details }.
 *   401 — Not authenticated.
 *   402 — Plan limit exceeded. Returns { error, upgrade_required: true }.
 *   500 — Unexpected server error.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId, planTier } = authResult;

  // ── 1. Parse and validate request body ──────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createProjectSchema.safeParse(body);
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

  const { name, description, icp_description, problem_statement, competitor_names } =
    parsed.data;

  try {
    // ── 2. Enforce plan-level project count limit ────────────────────────
    const limit = PLAN_LIMITS[planTier] ?? PLAN_LIMITS["free"]!;

    if (limit !== null) {
      const [{ value: existingCount }] = await db
        .select({ value: count() })
        .from(projects)
        .where(
          and(
            eq(projects.accountId, accountId),
            ne(projects.status, "deleted"),
          ),
        );

      if (existingCount >= limit) {
        const tierLabel =
          planTier === "free"
            ? "Free"
            : planTier === "starter"
              ? "Starter"
              : planTier === "growth"
                ? "Growth"
                : "current";

        return NextResponse.json(
          {
            error: `Your ${tierLabel} plan allows a maximum of ${limit} project${limit === 1 ? "" : "s"}. Please upgrade your plan to create more projects.`,
            upgrade_required: true,
            current_count: existingCount,
            limit,
          },
          { status: 402 },
        );
      }
    }

    // ── 3. Insert new project row ────────────────────────────────────────
    const [created] = await db
      .insert(projects)
      .values({
        accountId,
        name,
        description,
        icpDescription: icp_description,
        problemStatement: problem_statement,
        competitorNames: competitor_names,
        status: "active",
      })
      .returning();

    // ── 4. Enqueue keyword generation job ────────────────────────────────
    // All required fields are guaranteed present by the schema validation above.
    // If enqueueing fails, log the error but don't fail the HTTP response —
    // the project was already saved and can be re-triggered later.
    try {
      await generateKeywordsQueue.add("generate-keywords", {
        projectId: created.id,
        icpDescription: created.icpDescription,
        problemStatement: created.problemStatement,
        competitorNames: created.competitorNames,
      });
    } catch (queueErr) {
      console.error(
        "[POST /api/projects] Failed to enqueue generate-keywords job:",
        queueErr,
      );
    }

    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    console.error("[POST /api/projects] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
