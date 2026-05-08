import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { requireAuth } from "@/lib/require-auth";
import { resumeProjectJobs } from "@/lib/project-lifecycle";

// ── POST /api/projects/:id/restore ───────────────────────────────────────────

/**
 * Restores an archived project by setting its status back to 'active'.
 * Only archived projects can be restored.
 *
 * Responses:
 *   200 — Restored project object.
 *   401 — Not authenticated.
 *   403 — Project is deleted and cannot be restored, or project is already active.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id } = await params;

  try {
    // Load project and verify ownership
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);

    if (!project || project.accountId !== accountId) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (project.status === "deleted") {
      return NextResponse.json(
        { error: "Cannot restore a deleted project" },
        { status: 403 },
      );
    }

    if (project.status === "active") {
      return NextResponse.json(
        { error: "Project is already active" },
        { status: 403 },
      );
    }

    // Only archived projects reach this point
    const [restored] = await db
      .update(projects)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    // Lift the suspension so scraper workers can process this project again (Requirement 1.6).
    await resumeProjectJobs(id);

    return NextResponse.json(restored);
  } catch (err) {
    console.error("[POST /api/projects/:id/restore] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
