import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { requireAuth } from "@/lib/require-auth";
import { suspendProjectJobs } from "@/lib/project-lifecycle";

// ── POST /api/projects/:id/archive ───────────────────────────────────────────

/**
 * Archives a project by setting its status to 'archived'.
 * Only active projects can be archived.
 *
 * Responses:
 *   200 — Archived project object.
 *   401 — Not authenticated.
 *   403 — Project is deleted and cannot be archived.
 *   404 — Project not found or does not belong to account.
 *   409 — Project is already archived.
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
        { error: "Cannot archive a deleted project" },
        { status: 403 },
      );
    }

    if (project.status === "archived") {
      return NextResponse.json(
        { error: "Project is already archived" },
        { status: 409 },
      );
    }

    const [archived] = await db
      .update(projects)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    // Suspend all scraping and campaign jobs for this project (Requirement 1.6).
    // Historical signal data is retained — only active job scheduling is suspended.
    await suspendProjectJobs(id);

    return NextResponse.json(archived);
  } catch (err) {
    console.error("[POST /api/projects/:id/archive] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
