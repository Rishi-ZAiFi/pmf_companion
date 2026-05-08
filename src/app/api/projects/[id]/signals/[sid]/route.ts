import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { signals } from "@/db/schema/signals";
import { projects } from "@/db/schema/projects";
import { withAuth } from "@/lib/require-auth";

// ── Validation schema ────────────────────────────────────────────────────────

/**
 * All fields are optional — only provided fields will be updated.
 * Requirement 14.5: bookmark, tag with custom label, and dismiss signals.
 */
const updateSignalSchema = z.object({
  /** Toggle bookmark state on the signal. */
  is_bookmarked: z.boolean().optional(),
  /** Set or clear a custom label. Pass null to clear. */
  custom_label: z.string().min(1).max(255).nullable().optional(),
  /** Dismiss the signal from the feed. */
  is_dismissed: z.boolean().optional(),
});

// ── Shared helpers ───────────────────────────────────────────────────────────

async function verifyProjectOwnership(projectId: string, accountId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project || project.accountId !== accountId || project.status === "deleted") {
    return null;
  }

  return project;
}

async function loadSignal(signalId: string, projectId: string) {
  const [signal] = await db
    .select()
    .from(signals)
    .where(and(eq(signals.id, signalId), eq(signals.projectId, projectId)))
    .limit(1);

  return signal ?? null;
}

// ── GET /api/projects/:id/signals/:sid ───────────────────────────────────────

/**
 * Returns a single signal by ID, including `source_url` for source link
 * resolution (Requirement 14.6).
 *
 * Responses:
 *   200 — Signal object (includes source_url).
 *   401 — Not authenticated.
 *   404 — Project or signal not found.
 *   500 — Unexpected server error.
 */
export const GET = withAuth<{ id: string; sid: string }>(
  async (request, { params, auth }) => {
    const { accountId } = auth;
    const { id: projectId, sid: signalId } = await params;

    try {
      const project = await verifyProjectOwnership(projectId, accountId);
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }

      const signal = await loadSignal(signalId, projectId);
      if (!signal) {
        return NextResponse.json({ error: "Signal not found" }, { status: 404 });
      }

      return NextResponse.json(signal);
    } catch (err) {
      console.error("[GET /api/projects/:id/signals/:sid] Unexpected error:", err);
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 },
      );
    }
  },
);

// ── PATCH /api/projects/:id/signals/:sid ─────────────────────────────────────

/**
 * Updates signal interaction fields: bookmark, custom label, and/or dismiss.
 * Only the fields provided in the request body are updated.
 *
 * Requirement 14.5: founders can bookmark, tag with a custom label, and
 * dismiss signals from the feed.
 *
 * Request body (JSON, all fields optional):
 *   {
 *     is_bookmarked?: boolean       — toggle bookmark
 *     custom_label?: string | null  — set or clear custom label
 *     is_dismissed?: boolean        — dismiss signal from feed
 *   }
 *
 * Responses:
 *   200 — Updated signal object.
 *   400 — Validation error or no fields provided.
 *   401 — Not authenticated.
 *   404 — Project or signal not found.
 *   500 — Unexpected server error.
 */
export const PATCH = withAuth<{ id: string; sid: string }>(
  async (request, { params, auth }) => {
    const { accountId } = auth;
    const { id: projectId, sid: signalId } = await params;

    // ── 1. Parse and validate request body ──────────────────────────────
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = updateSignalSchema.safeParse(body);
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

    const { is_bookmarked, custom_label, is_dismissed } = parsed.data;

    // Require at least one field to update
    if (
      is_bookmarked === undefined &&
      custom_label === undefined &&
      is_dismissed === undefined
    ) {
      return NextResponse.json(
        { error: "At least one field must be provided: is_bookmarked, custom_label, or is_dismissed" },
        { status: 400 },
      );
    }

    try {
      // ── 2. Verify project ownership ──────────────────────────────────
      const project = await verifyProjectOwnership(projectId, accountId);
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }

      // ── 3. Verify signal belongs to the project ──────────────────────
      const signal = await loadSignal(signalId, projectId);
      if (!signal) {
        return NextResponse.json({ error: "Signal not found" }, { status: 404 });
      }

      // ── 4. Build update payload (only include provided fields) ────────
      const updateValues: Partial<typeof signals.$inferInsert> = {};

      if (is_bookmarked !== undefined) updateValues.isBookmarked = is_bookmarked;
      if (custom_label !== undefined) updateValues.customLabel = custom_label;
      if (is_dismissed !== undefined) updateValues.isDismissed = is_dismissed;

      // ── 5. Persist update ─────────────────────────────────────────────
      const [updated] = await db
        .update(signals)
        .set(updateValues)
        .where(and(eq(signals.id, signalId), eq(signals.projectId, projectId)))
        .returning();

      return NextResponse.json(updated);
    } catch (err) {
      console.error("[PATCH /api/projects/:id/signals/:sid] Unexpected error:", err);
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 },
      );
    }
  },
);
