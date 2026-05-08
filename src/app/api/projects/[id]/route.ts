import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { requireAuth } from "@/lib/require-auth";
import { generateKeywordsQueue } from "@/lib/queues";

// ── Validation schema ────────────────────────────────────────────────────────

/**
 * Competitor management action schema.
 * Requirement 18.3: founders can add or remove tracked competitors at any time.
 * Requirement 18.4: when a competitor is removed, historical signals are retained
 *   but new signal collection ceases (scrapers check project.competitor_names).
 */
const competitorActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add_competitor"),
    competitor_name: z.string().min(1).max(255),
  }),
  z.object({
    action: z.literal("remove_competitor"),
    competitor_name: z.string().min(1).max(255),
  }),
]);

const updateProjectSchema = z.union([
  // Competitor management actions (discriminated by `action` field)
  competitorActionSchema,
  // General project field updates (no `action` field)
  z.object({
    action: z.undefined().optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().min(1).optional(),
    icp_description: z.string().min(1).optional(),
    problem_statement: z.string().min(1).optional(),
    competitor_names: z
      .array(z.string().min(1))
      .max(5, "Up to 5 competitor names allowed")
      .optional(),
    keywords: z.array(z.string().min(1)).optional(),
    /** Full replacement of the subreddit monitoring list. */
    subreddit_candidates: z.array(z.string().min(1)).optional(),
    /**
     * Subreddits to add to the monitoring list (merged with existing).
     * Requirement 2.3: founders can add subreddits at any time.
     */
    add_subreddits: z.array(z.string().min(1)).optional(),
    /**
     * Subreddits to remove from the monitoring list.
     * Requirement 2.3: founders can remove subreddits at any time.
     */
    remove_subreddits: z.array(z.string().min(1)).optional(),
  }),
]);

// ── Shared helper: load project and verify ownership ─────────────────────────

async function loadProject(id: string, accountId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (!project || project.accountId !== accountId) {
    return null;
  }

  return project;
}

// ── GET /api/projects/:id ────────────────────────────────────────────────────

/**
 * Returns a single project by ID.
 * The project must belong to the authenticated account and must not be deleted.
 *
 * Responses:
 *   200 — Project object.
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
  const { id } = await params;

  try {
    const project = await loadProject(id, accountId);

    if (!project || project.status === "deleted") {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json(project);
  } catch (err) {
    console.error("[GET /api/projects/:id] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}

// ── PATCH /api/projects/:id ──────────────────────────────────────────────────

/**
 * Updates allowed fields on a project, or manages tracked competitors.
 * Returns 403 if the project is deleted, 404 if not found.
 *
 * Request body (JSON) — two modes:
 *
 * **Competitor management** (Requirements 18.3, 18.4):
 *   { "action": "add_competitor",    "competitor_name": "Acme" }
 *   { "action": "remove_competitor", "competitor_name": "Acme" }
 *
 *   - add_competitor: appends to competitor_names (max 5 total).
 *   - remove_competitor: removes from competitor_names. Historical signals
 *     attributed to the competitor are retained; the scraper will naturally
 *     stop collecting new signals since it checks project.competitor_names.
 *
 * **General field update** (all fields optional):
 *   {
 *     name?: string,
 *     description?: string,
 *     icp_description?: string,
 *     problem_statement?: string,
 *     competitor_names?: string[] (max 5, full replacement),
 *     keywords?: string[],
 *     subreddit_candidates?: string[],
 *     add_subreddits?: string[],
 *     remove_subreddits?: string[]
 *   }
 *
 * Responses:
 *   200 — Updated project object.
 *   400 — Validation error (including competitor limit exceeded).
 *   401 — Not authenticated.
 *   403 — Project is deleted and cannot be modified.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id } = await params;

  // ── 1. Parse and validate request body ──────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = updateProjectSchema.safeParse(body);
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

  try {
    // ── 2. Load and verify project ownership ────────────────────────────
    const project = await loadProject(id, accountId);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (project.status === "deleted") {
      return NextResponse.json(
        { error: "Cannot modify a deleted project" },
        { status: 403 },
      );
    }

    // ── 3. Handle competitor management actions ──────────────────────────
    if (parsed.data.action === "add_competitor") {
      const { competitor_name } = parsed.data;
      const current = project.competitorNames ?? [];

      // Check if already tracked (case-insensitive)
      const alreadyTracked = current.some(
        (c) => c.toLowerCase() === competitor_name.toLowerCase(),
      );
      if (alreadyTracked) {
        return NextResponse.json(
          { error: `Competitor "${competitor_name}" is already being tracked` },
          { status: 400 },
        );
      }

      // Enforce max 5 competitors (Requirement 1.3)
      if (current.length >= 5) {
        return NextResponse.json(
          { error: "Maximum of 5 competitors allowed per project" },
          { status: 400 },
        );
      }

      const [updated] = await db
        .update(projects)
        .set({
          competitorNames: [...current, competitor_name],
          updatedAt: new Date(),
        })
        .where(eq(projects.id, id))
        .returning();

      return NextResponse.json(updated);
    }

    if (parsed.data.action === "remove_competitor") {
      const { competitor_name } = parsed.data;
      const current = project.competitorNames ?? [];

      // Check if the competitor is actually tracked
      const exists = current.some(
        (c) => c.toLowerCase() === competitor_name.toLowerCase(),
      );
      if (!exists) {
        return NextResponse.json(
          { error: `Competitor "${competitor_name}" is not being tracked` },
          { status: 400 },
        );
      }

      // Remove the competitor — historical signals are retained (no deletion).
      // The scraper will naturally stop collecting new signals for this
      // competitor since it checks project.competitor_names before scraping.
      // (Requirement 18.4)
      const updated_names = current.filter(
        (c) => c.toLowerCase() !== competitor_name.toLowerCase(),
      );

      const [updated] = await db
        .update(projects)
        .set({
          competitorNames: updated_names,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, id))
        .returning();

      return NextResponse.json(updated);
    }

    // ── 4. Handle general field updates ─────────────────────────────────
    const {
      name,
      description,
      icp_description,
      problem_statement,
      competitor_names,
      keywords,
      subreddit_candidates,
      add_subreddits,
      remove_subreddits,
    } = parsed.data;

    const updateValues: Partial<typeof projects.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (name !== undefined) updateValues.name = name;
    if (description !== undefined) updateValues.description = description;
    if (icp_description !== undefined) updateValues.icpDescription = icp_description;
    if (problem_statement !== undefined)
      updateValues.problemStatement = problem_statement;
    if (competitor_names !== undefined)
      updateValues.competitorNames = competitor_names;
    if (keywords !== undefined) updateValues.keywords = keywords;

    // Handle subreddit list management (Requirement 2.3)
    if (subreddit_candidates !== undefined) {
      // Full replacement
      updateValues.subredditCandidates = subreddit_candidates;
    } else if (add_subreddits !== undefined || remove_subreddits !== undefined) {
      // Additive/subtractive update — merge with existing list
      let current = project.subredditCandidates ?? [];

      if (add_subreddits && add_subreddits.length > 0) {
        // Normalize: strip r/ prefix, lowercase for deduplication
        const normalized = add_subreddits.map((s) =>
          s.replace(/^r\//i, "").trim(),
        );
        const existing = new Set(current.map((s) => s.toLowerCase()));
        for (const sub of normalized) {
          if (!existing.has(sub.toLowerCase())) {
            current = [...current, sub];
            existing.add(sub.toLowerCase());
          }
        }
      }

      if (remove_subreddits && remove_subreddits.length > 0) {
        const toRemove = new Set(
          remove_subreddits.map((s) =>
            s.replace(/^r\//i, "").trim().toLowerCase(),
          ),
        );
        current = current.filter((s) => !toRemove.has(s.toLowerCase()));
      }

      updateValues.subredditCandidates = current;
    }

    // ── 5. Persist update ────────────────────────────────────────────────
    const [updated] = await db
      .update(projects)
      .set(updateValues)
      .where(eq(projects.id, id))
      .returning();

    // ── 6. Enqueue keyword generation job if applicable ──────────────────
    // Only re-generate keywords when the update touched icpDescription or
    // problemStatement (to avoid redundant re-generation on unrelated edits),
    // and only when the project is active and all required fields are present.
    const touchedKeyFields =
      icp_description !== undefined || problem_statement !== undefined;

    const hasAllRequiredFields =
      updated.name &&
      updated.description &&
      updated.icpDescription &&
      updated.problemStatement;

    if (
      touchedKeyFields &&
      hasAllRequiredFields &&
      updated.status === "active"
    ) {
      try {
        await generateKeywordsQueue.add("generate-keywords", {
          projectId: updated.id,
          icpDescription: updated.icpDescription,
          problemStatement: updated.problemStatement,
          competitorNames: updated.competitorNames,
        });
      } catch (queueErr) {
        console.error(
          "[PATCH /api/projects/:id] Failed to enqueue generate-keywords job:",
          queueErr,
        );
      }
    }

    return NextResponse.json(updated);
  } catch (err) {
    console.error("[PATCH /api/projects/:id] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}

// ── DELETE /api/projects/:id ─────────────────────────────────────────────────

/**
 * Soft-deletes a project by setting its status to 'deleted'.
 * Returns 403 if the project is already deleted.
 *
 * Responses:
 *   200 — Deleted project object.
 *   401 — Not authenticated.
 *   403 — Project is already deleted.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id } = await params;

  try {
    const project = await loadProject(id, accountId);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (project.status === "deleted") {
      return NextResponse.json(
        { error: "Project is already deleted" },
        { status: 403 },
      );
    }

    const [deleted] = await db
      .update(projects)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    return NextResponse.json(deleted);
  } catch (err) {
    console.error("[DELETE /api/projects/:id] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
