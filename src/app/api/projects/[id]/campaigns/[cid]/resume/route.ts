import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { campaigns } from "@/db/schema/campaigns";
import { projects } from "@/db/schema/projects";
import { withAuth } from "@/lib/require-auth";
import { deliverCampaignQueue } from "@/lib/queues";

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

// ── POST /api/projects/:id/campaigns/:cid/resume ─────────────────────────────

/**
 * Resumes a paused campaign.
 * Sets status back to `launching` and re-enqueues the deliver-campaign job
 * to continue delivering to remaining contacts.
 *
 * Responses:
 *   200 — Updated campaign object with status `launching`.
 *   400 — Campaign is not in a resumable state.
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

      // Only paused campaigns can be resumed (Requirement 9.7)
      if (campaign.status !== "paused") {
        return NextResponse.json(
          {
            error: `Campaign cannot be resumed from status '${campaign.status}'. Only paused campaigns can be resumed.`,
          },
          { status: 400 },
        );
      }

      // Set status back to launching and re-enqueue delivery
      const [updated] = await db
        .update(campaigns)
        .set({ status: "launching", updatedAt: new Date() })
        .where(
          and(
            eq(campaigns.id, campaignId),
            eq(campaigns.projectId, projectId),
          ),
        )
        .returning();

      // Re-enqueue deliver-campaign job to continue delivery
      await deliverCampaignQueue.add(
        "deliver-campaign",
        {
          campaignId,
          projectId,
          accountId,
        },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      );

      console.log(
        `[resume] Campaign ${campaignId} resumed, deliver-campaign job re-enqueued`,
      );

      return NextResponse.json(updated);
    } catch (err) {
      console.error(
        "[POST /api/projects/:id/campaigns/:cid/resume] Unexpected error:",
        err,
      );
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 },
      );
    }
  },
);
