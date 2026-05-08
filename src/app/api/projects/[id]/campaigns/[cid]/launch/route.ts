import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { campaigns } from "@/db/schema/campaigns";
import { projects } from "@/db/schema/projects";
import { accounts } from "@/db/schema/accounts";
import { withAuth } from "@/lib/require-auth";
import {
  redisConnection,
  deliverCampaignQueue,
  notificationQueue,
} from "@/lib/queues";

// ── Plan limits ──────────────────────────────────────────────────────────────

const PLAN_CONVERSATION_LIMITS: Record<string, number> = {
  free: 50,
  starter: 500,
  growth: 2000,
  enterprise: Infinity,
};

/** Plans that are allowed to run active campaigns (Requirement 21.2) */
const ACTIVE_CAMPAIGN_PLANS = new Set(["starter", "growth", "enterprise"]);

// ── Validation schema ────────────────────────────────────────────────────────

const launchSchema = z.object({
  /**
   * Founder must confirm they have obtained consent from contacts
   * before the campaign can be launched (Requirement 22.3).
   */
  consent_confirmed: z.literal(true, {
    errorMap: () => ({
      message:
        "You must confirm that you have obtained consent from your contacts (consent_confirmed: true)",
    }),
  }),
});

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

async function loadAccount(accountId: string) {
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  return account ?? null;
}

/**
 * Returns the Redis key for the monthly conversation counter.
 * Format: account:{accountId}:conversations:{YYYY-MM}
 */
function conversationCountKey(accountId: string): string {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `account:${accountId}:conversations:${month}`;
}

// ── POST /api/projects/:id/campaigns/:cid/launch ─────────────────────────────

/**
 * Launches a campaign.
 *
 * Pre-conditions:
 *   - Campaign must be in `draft` or `paused` status.
 *   - Founder must confirm consent (consent_confirmed: true).
 *   - Account plan must support active campaigns (starter, growth, enterprise).
 *   - Account must not have exceeded the monthly conversation quota.
 *
 * On success:
 *   - Sets campaign status to `launching`.
 *   - Enqueues a `deliver-campaign` job (delivery begins within 15 minutes).
 *
 * Request body (JSON):
 *   { consent_confirmed: true }
 *
 * Responses:
 *   200 — Updated campaign object with status `launching`.
 *   400 — Validation error or invalid campaign status.
 *   401 — Not authenticated.
 *   402 — Plan upgrade required (free tier or quota exceeded).
 *   404 — Project or campaign not found.
 *   500 — Unexpected server error.
 */
export const POST = withAuth<{ id: string; cid: string }>(
  async (request, { params, auth }) => {
    const { accountId, planTier } = auth;
    const { id: projectId, cid: campaignId } = await params;

    // Parse and validate request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = launchSchema.safeParse(body);
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
      // ── 1. Verify project ownership ──────────────────────────────────────
      const project = await verifyProjectOwnership(projectId, accountId);
      if (!project) {
        return NextResponse.json(
          { error: "Project not found" },
          { status: 404 },
        );
      }

      // ── 2. Load campaign ─────────────────────────────────────────────────
      const campaign = await loadCampaign(campaignId, projectId);
      if (!campaign) {
        return NextResponse.json(
          { error: "Campaign not found" },
          { status: 404 },
        );
      }

      // ── 3. Validate campaign status ──────────────────────────────────────
      if (campaign.status !== "draft" && campaign.status !== "paused") {
        return NextResponse.json(
          {
            error: `Campaign cannot be launched from status '${campaign.status}'. Only draft or paused campaigns can be launched.`,
          },
          { status: 400 },
        );
      }

      // ── 4. Enforce plan: free tier cannot run active campaigns ───────────
      // (Requirement 21.2) — fetch a fresh plan_tier from the DB so we don't
      // rely on a potentially stale JWT claim.
      const account = await loadAccount(accountId);
      const currentPlanTier = account?.planTier ?? planTier;

      if (!ACTIVE_CAMPAIGN_PLANS.has(currentPlanTier)) {
        return NextResponse.json(
          {
            error: "upgrade_required",
            message:
              "Active campaigns are not available on the Free tier. Upgrade to Starter, Growth, or Enterprise to launch campaigns.",
            upgrade_url: "/api/billing/checkout",
          },
          { status: 402 },
        );
      }

      // ── 5. Enforce monthly conversation quota via Redis atomic increment ─
      // (Requirements 21.1, 21.3, 21.4)
      const limit = PLAN_CONVERSATION_LIMITS[currentPlanTier] ?? 0;

      if (limit !== Infinity) {
        const redisKey = conversationCountKey(accountId);

        // Read current count atomically
        const currentCountStr = await redisConnection.get(redisKey);
        const currentCount = currentCountStr
          ? parseInt(currentCountStr, 10)
          : 0;

        if (currentCount >= limit) {
          // 100% quota reached — pause all active campaigns and notify
          await pauseAllActiveCampaigns(projectId, accountId);

          try {
            await notificationQueue.add("quota-exceeded", {
              type: "quota-exceeded",
              accountId,
              projectId,
              metadata: { limit, currentCount },
            });
          } catch (notifyErr) {
            console.error(
              "[launch] Failed to enqueue quota-exceeded notification:",
              notifyErr,
            );
          }

          return NextResponse.json(
            {
              error:
                "Monthly conversation quota reached. All active campaigns have been paused. Please upgrade your plan.",
              quota_exceeded: true,
              current_count: currentCount,
              limit,
            },
            { status: 402 },
          );
        }

        // Warn at 90% usage
        const warningThreshold = Math.floor(limit * 0.9);
        if (currentCount >= warningThreshold) {
          try {
            await notificationQueue.add("quota-warning", {
              type: "quota-warning",
              accountId,
              projectId,
              metadata: { limit, currentCount, warningThreshold },
            });
          } catch (notifyErr) {
            console.error(
              "[launch] Failed to enqueue quota-warning notification:",
              notifyErr,
            );
          }
        }
      }

      // ── 6. Set campaign status to `launching` ────────────────────────────
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

      // ── 7. Enqueue deliver-campaign job ──────────────────────────────────
      // Delivery begins within 15 minutes (Requirement 9.6)
      await deliverCampaignQueue.add(
        "deliver-campaign",
        {
          campaignId,
          projectId,
          accountId,
        },
        {
          // Ensure the job is processed promptly
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      );

      console.log(
        `[launch] Campaign ${campaignId} set to launching, deliver-campaign job enqueued`,
      );

      return NextResponse.json(updated);
    } catch (err) {
      console.error(
        "[POST /api/projects/:id/campaigns/:cid/launch] Unexpected error:",
        err,
      );
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 },
      );
    }
  },
);

// ── Helper: pause all active campaigns for an account ───────────────────────

/**
 * Pauses all active/launching campaigns for the given account when quota is exceeded.
 * Requirements: 21.4
 */
async function pauseAllActiveCampaigns(
  _projectId: string,
  accountId: string,
): Promise<void> {
  try {
    // Find all projects for this account
    const accountProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.accountId, accountId));

    const projectIds = accountProjects.map((p) => p.id);

    if (projectIds.length === 0) return;

    // Pause all active/launching campaigns across all projects
    for (const pid of projectIds) {
      await db
        .update(campaigns)
        .set({ status: "paused", updatedAt: new Date() })
        .where(
          and(
            eq(campaigns.projectId, pid),
            eq(campaigns.status, "active"),
          ),
        );

      await db
        .update(campaigns)
        .set({ status: "paused", updatedAt: new Date() })
        .where(
          and(
            eq(campaigns.projectId, pid),
            eq(campaigns.status, "launching"),
          ),
        );
    }

    console.log(
      `[launch] Paused all active campaigns for account ${accountId} due to quota exceeded`,
    );
  } catch (err) {
    console.error(
      `[launch] Failed to pause campaigns for account ${accountId}:`,
      err,
    );
  }
}
