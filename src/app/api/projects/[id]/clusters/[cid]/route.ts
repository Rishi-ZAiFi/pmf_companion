import { NextRequest, NextResponse } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { themeClusters, signalClusterMemberships } from "@/db/schema/theme-clusters";
import { requireAuth } from "@/lib/require-auth";

// ── Validation schemas ───────────────────────────────────────────────────────

/**
 * Discriminated union schema for the three supported cluster operations.
 * Requirement 16.4: rename, merge, or dismiss a Theme Cluster.
 */
const patchClusterSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("rename"),
    /** New name for the cluster (1–255 characters). */
    name: z.string().min(1).max(255),
  }),
  z.object({
    action: z.literal("merge"),
    /** UUID of the target cluster to merge this cluster into. */
    target_cluster_id: z.string().uuid("target_cluster_id must be a valid UUID"),
  }),
  z.object({
    action: z.literal("dismiss"),
  }),
]);

// ── Shared helpers ───────────────────────────────────────────────────────────

async function verifyProjectOwnership(projectId: string, accountId: string) {
  const [project] = await db
    .select({ id: projects.id, accountId: projects.accountId, status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project || project.accountId !== accountId || project.status === "deleted") {
    return null;
  }

  return project;
}

async function loadCluster(clusterId: string, projectId: string) {
  const [cluster] = await db
    .select()
    .from(themeClusters)
    .where(
      and(eq(themeClusters.id, clusterId), eq(themeClusters.projectId, projectId)),
    )
    .limit(1);

  return cluster ?? null;
}

// ── PATCH /api/projects/:id/clusters/:cid ────────────────────────────────────

/**
 * Manages a Theme Cluster via one of three operations:
 *
 * **Rename** — updates the cluster's `name` field.
 * ```json
 * { "action": "rename", "name": "New Name" }
 * ```
 *
 * **Merge** — moves all signal memberships from this cluster into the target
 * cluster, updates the target's `signal_count` to the sum of both, and marks
 * this cluster as dismissed.
 * ```json
 * { "action": "merge", "target_cluster_id": "uuid" }
 * ```
 *
 * **Dismiss** — sets `is_dismissed = true` on the cluster.
 * ```json
 * { "action": "dismiss" }
 * ```
 *
 * Responses:
 *   200 — Updated cluster object (for merge, returns the target cluster).
 *   400 — Invalid JSON or validation error.
 *   401 — Not authenticated.
 *   404 — Project not found, or cluster not found / does not belong to project.
 *   500 — Unexpected server error.
 *
 * Requirements: 16.4
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; cid: string }> },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id: projectId, cid: clusterId } = await params;

  // ── 1. Parse and validate request body ──────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = patchClusterSchema.safeParse(body);
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
    // ── 2. Verify project ownership ────────────────────────────────────────
    const project = await verifyProjectOwnership(projectId, accountId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // ── 3. Verify the cluster exists and belongs to this project ───────────
    const cluster = await loadCluster(clusterId, projectId);
    if (!cluster) {
      return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
    }

    const { action } = parsed.data;

    // ── 4. Execute the requested operation ────────────────────────────────

    if (action === "rename") {
      // ── Rename: update the cluster's name field ────────────────────────
      const [updated] = await db
        .update(themeClusters)
        .set({ name: parsed.data.name, updatedAt: new Date() })
        .where(and(eq(themeClusters.id, clusterId), eq(themeClusters.projectId, projectId)))
        .returning();

      return NextResponse.json({ data: updated });
    }

    if (action === "dismiss") {
      // ── Dismiss: mark the cluster as dismissed ─────────────────────────
      const [updated] = await db
        .update(themeClusters)
        .set({ isDismissed: true, updatedAt: new Date() })
        .where(and(eq(themeClusters.id, clusterId), eq(themeClusters.projectId, projectId)))
        .returning();

      return NextResponse.json({ data: updated });
    }

    // action === "merge"
    const { target_cluster_id: targetClusterId } = parsed.data;

    // Prevent merging a cluster into itself
    if (targetClusterId === clusterId) {
      return NextResponse.json(
        { error: "Cannot merge a cluster into itself" },
        { status: 400 },
      );
    }

    // ── Verify the target cluster exists and belongs to this project ───────
    const targetCluster = await loadCluster(targetClusterId, projectId);
    if (!targetCluster) {
      return NextResponse.json(
        { error: "Target cluster not found" },
        { status: 404 },
      );
    }

    // ── Merge: run all steps in a transaction ──────────────────────────────
    //
    // Steps:
    //   a. Move all signal_cluster_memberships from source → target.
    //      Use ON CONFLICT DO NOTHING to handle signals already in both clusters.
    //   b. Update target cluster's signal_count = source.signal_count + target.signal_count.
    //   c. Mark source cluster as dismissed.
    const updatedTarget = await db.transaction(async (tx) => {
      // a. Reassign memberships — skip any that already exist in the target
      await tx.execute(
        sql`
          INSERT INTO signal_cluster_memberships (signal_id, cluster_id)
          SELECT signal_id, ${targetClusterId}::uuid
          FROM signal_cluster_memberships
          WHERE cluster_id = ${clusterId}::uuid
          ON CONFLICT DO NOTHING
        `,
      );

      // b. Update target signal_count to the combined total
      const newSignalCount = cluster.signalCount + targetCluster.signalCount;
      const [updated] = await tx
        .update(themeClusters)
        .set({ signalCount: newSignalCount, updatedAt: new Date() })
        .where(eq(themeClusters.id, targetClusterId))
        .returning();

      // c. Dismiss the source cluster
      await tx
        .update(themeClusters)
        .set({ isDismissed: true, updatedAt: new Date() })
        .where(eq(themeClusters.id, clusterId));

      return updated;
    });

    return NextResponse.json({ data: updatedTarget });
  } catch (err) {
    console.error("[PATCH /api/projects/:id/clusters/:cid] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
