import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { campaigns } from "@/db/schema/campaigns";
import { projects } from "@/db/schema/projects";
import { withAuth } from "@/lib/require-auth";

// ── Validation schemas ───────────────────────────────────────────────────────

const VALID_GOALS = [
  "pmf_survey",
  "pain_point_discovery",
  "feature_validation",
  "churn_investigation",
] as const;

const VALID_CHANNELS = ["email", "sms", "voice", "widget"] as const;

const updateCampaignSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  goal: z.enum(VALID_GOALS).optional(),
  channels: z.array(z.enum(VALID_CHANNELS)).min(1).optional(),
  segment_filter: z.array(z.string().min(1)).optional(),
  /** Full replacement of the conversation script */
  script: z.record(z.unknown()).optional(),
  /** Full replacement of the AI persona */
  persona: z.record(z.unknown()).optional(),
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

// ── GET /api/projects/:id/campaigns/:cid ─────────────────────────────────────

/**
 * Returns a single campaign by ID.
 *
 * Responses:
 *   200 — Campaign object.
 *   401 — Not authenticated.
 *   404 — Project or campaign not found.
 *   500 — Unexpected server error.
 */
export const GET = withAuth<{ id: string; cid: string }>(
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

      return NextResponse.json(campaign);
    } catch (err) {
      console.error(
        "[GET /api/projects/:id/campaigns/:cid] Unexpected error:",
        err,
      );
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 },
      );
    }
  },
);

// ── PATCH /api/projects/:id/campaigns/:cid ───────────────────────────────────

/**
 * Updates a campaign's fields.
 * Only campaigns in `draft` status can have their goal, channels, or segment
 * filter changed. Script and persona can be edited at any time before launch.
 *
 * Request body (JSON, all fields optional):
 *   {
 *     name?: string,
 *     goal?: "pmf_survey" | "pain_point_discovery" | "feature_validation" | "churn_investigation",
 *     channels?: ("email" | "sms" | "voice" | "widget")[],
 *     segment_filter?: string[],
 *     script?: object,
 *     persona?: object
 *   }
 *
 * Responses:
 *   200 — Updated campaign object.
 *   400 — Validation error or invalid status transition.
 *   401 — Not authenticated.
 *   404 — Project or campaign not found.
 *   500 — Unexpected server error.
 */
export const PATCH = withAuth<{ id: string; cid: string }>(
  async (request, { params, auth }) => {
    const { accountId } = auth;
    const { id: projectId, cid: campaignId } = await params;

    // Parse and validate request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = updateCampaignSchema.safeParse(body);
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

      const { name, goal, channels, segment_filter, script, persona } =
        parsed.data;

      // Structural fields (goal, channels, segment_filter) can only be changed
      // while the campaign is in draft status (Requirement 9.5)
      const structuralChange =
        goal !== undefined ||
        channels !== undefined ||
        segment_filter !== undefined;

      if (structuralChange && campaign.status !== "draft") {
        return NextResponse.json(
          {
            error:
              "Campaign goal, channels, and segment filter can only be changed while the campaign is in draft status",
          },
          { status: 400 },
        );
      }

      // Build update payload
      const updateValues: Partial<typeof campaigns.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (name !== undefined) updateValues.name = name;
      if (goal !== undefined) updateValues.goal = goal;
      if (channels !== undefined) updateValues.channels = channels;
      if (segment_filter !== undefined)
        updateValues.segmentFilter = segment_filter;
      if (script !== undefined) updateValues.script = script;
      if (persona !== undefined) updateValues.persona = persona;

      const [updated] = await db
        .update(campaigns)
        .set(updateValues)
        .where(
          and(
            eq(campaigns.id, campaignId),
            eq(campaigns.projectId, projectId),
          ),
        )
        .returning();

      return NextResponse.json(updated);
    } catch (err) {
      console.error(
        "[PATCH /api/projects/:id/campaigns/:cid] Unexpected error:",
        err,
      );
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 },
      );
    }
  },
);
