/**
 * DELETE /api/projects/:id/webhooks/:wid — delete a webhook endpoint
 *
 * Requirements: 20.4
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { webhookEndpoints } from "@/db/schema/webhook-endpoints";
import { requireAuth } from "@/lib/require-auth";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Verify that the project exists, belongs to the authenticated account,
 * and is not deleted. Returns the project row or null.
 */
async function verifyProjectAccess(
  projectId: string,
  accountId: string,
): Promise<{ id: string } | null> {
  const [project] = await db
    .select({ id: projects.id, accountId: projects.accountId, status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project || project.accountId !== accountId || project.status === "deleted") {
    return null;
  }

  return { id: project.id };
}

// ── DELETE /api/projects/:id/webhooks/:wid ────────────────────────────────────

/**
 * Delete a webhook endpoint.
 *
 * Responses:
 *   200 — Webhook endpoint deleted.
 *   401 — Not authenticated.
 *   404 — Project or webhook endpoint not found.
 *   500 — Unexpected server error.
 *
 * Requirements: 20.4
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; wid: string }> },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id: projectId, wid: webhookId } = await params;

  try {
    const project = await verifyProjectAccess(projectId, accountId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Delete the webhook endpoint, scoped to the project for safety
    const deleted = await db
      .delete(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, webhookId),
          eq(webhookEndpoints.projectId, projectId),
        ),
      )
      .returning({ id: webhookEndpoints.id });

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: "Webhook endpoint not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(
      "[DELETE /api/projects/:id/webhooks/:wid] Unexpected error:",
      err,
    );
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
