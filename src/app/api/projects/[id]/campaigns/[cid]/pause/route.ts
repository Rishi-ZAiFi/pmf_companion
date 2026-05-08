import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { campaigns } from "@/db/schema/campaigns";
import { projects } from "@/db/schema/projects";
import { withAuth } from "@/lib/require-auth";

// ── Shared helpers ───────────────────────────────────────────────────────────

async function verifyProjectOwnership(projectId: string, accountId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project || project.accountId !== accountId) {
    return null;
  }

  return project;
}

async function loadCampaign(campaignId: string, projectId: string) {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(
      and(eq(campaigns.id, campaignId), eq(campaigns.projectId, projectId)),
    )
    .limit(1);

  return campaign ?? null;
}

// ── POST /api/projects/:id/campaigns/:cid/pause ──────────────────────────────

/**
 * Pauses an active or launching campaign.
 *
 * While paused, no new conversations will be initiated, but in-progress
 * conversations are allowed to complete (Requirement 9.8).
 *
 * Responses:
 *   200 — Updated campaign object with status `paused`.
 *   400 — Campaign is not in a pausable state.
 *   401 — Not authenticated.
 *   404 — Project or campaign not found.
 *   500 — Unexpected server error.
 */
export const POST = withAuth<{ id: string; cid: string }>(
  async (request, { params, auth }) => {
    const { accountId } = auth;
    const { id: projectId, cid: campaignId } = await params;

    try {
      const project = await verifyProjectOwnership(projectId, accountId);
      if (!project) {
        return NextResponse.json(
          { error: "Project not found" },
          { status: 404 },
        );
      }

      const campaign = await loadCampaign(campaignId, projectId);
      if (!campaign) {
        return NextResponse.json(
          { error: "Campaign not found" },
          { status: 404 },
        );
      }

      // Only active or launching campaigns can be paused (Requirement 9.7)
      if (campaign.status !== "active" && campaign.status !== "launching") {
        return NextResponse.json(
          {
            error: `Campaign cannot be paused from status '${campaign.status}'. Only active or launching campaigns can be paused.`,
          },
          { status: 400 },
        );
      }

      const [updated] = await db
        .update(campaigns)
        .set({ status: "paused", updatedAt: new Date() })
        .where(
          and(
            eq(campaigns.id, campaignId),
            eq(campaigns.projectId, projectId),
          ),
        )
        .returning();

      console.log(`[pause] Campaign ${campaignId} paused`);

      return NextResponse.json(updated);
    } catch (err) {
      console.error(
        "[POST /api/projects/:id/campaigns/:cid/pause] Unexpected error:",
        err,
      );
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 },
      );
    }
  },
);
