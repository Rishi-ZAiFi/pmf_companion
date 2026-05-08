import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import OpenAI from "openai";
import { db } from "@/db/client";
import { campaigns } from "@/db/schema/campaigns";
import { projects } from "@/db/schema/projects";
import { withAuth } from "@/lib/require-auth";
import { env } from "@/lib/env";

// ── OpenAI client ────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ── Validation schemas ───────────────────────────────────────────────────────

const VALID_GOALS = [
  "pmf_survey",
  "pain_point_discovery",
  "feature_validation",
  "churn_investigation",
] as const;

const VALID_CHANNELS = ["email", "sms", "voice", "widget"] as const;

const createCampaignSchema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  goal: z.enum(VALID_GOALS, {
    errorMap: () => ({
      message:
        "Goal must be one of: pmf_survey, pain_point_discovery, feature_validation, churn_investigation",
    }),
  }),
  channels: z
    .array(z.enum(VALID_CHANNELS))
    .min(1, "At least one channel is required"),
  segment_filter: z.array(z.string().min(1)).optional().default([]),
});

// ── Shared helper: verify project ownership ──────────────────────────────────

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

// ── Script generation ────────────────────────────────────────────────────────

/**
 * Structured conversation script returned by OpenAI.
 */
interface ConversationScript {
  opening: string;
  turns: Array<{
    prompt: string;
    follow_up?: string;
  }>;
  closing: string;
}

/**
 * AI persona configuration returned by OpenAI.
 */
interface AiPersona {
  name: string;
  role: string;
  tone: string;
  instructions: string;
}

interface ScriptGenerationResult {
  script: ConversationScript;
  persona: AiPersona;
}

const GOAL_DESCRIPTIONS: Record<string, string> = {
  pmf_survey:
    "Conduct a Product-Market Fit survey using the Sean Ellis methodology. Ask how disappointed the user would be if they could no longer use the product, and probe for reasons.",
  pain_point_discovery:
    "Discover the user's primary pain points and frustrations related to the problem space. Probe deeply to understand root causes and impact.",
  feature_validation:
    "Validate whether a specific feature or product direction resonates with the user. Gauge interest, willingness to pay, and potential objections.",
  churn_investigation:
    "Investigate why the user stopped using or is considering leaving the product. Understand the root cause and what would have changed their decision.",
};

/**
 * Generates a conversation script and AI persona using OpenAI Chat Completions.
 * Requirements: 9.4
 */
async function generateScriptAndPersona(
  goal: string,
  productDescription: string,
  icpDescription: string,
): Promise<ScriptGenerationResult> {
  const goalDescription = GOAL_DESCRIPTIONS[goal] ?? goal;

  const prompt = `You are an expert UX researcher and product manager helping a startup founder conduct user interviews.

Generate a conversation script and AI persona for an outreach campaign with the following context:

Campaign Goal: ${goalDescription}
Product Description: ${productDescription}
Target ICP (Ideal Customer Profile): ${icpDescription}

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "script": {
    "opening": "Opening message to start the conversation",
    "turns": [
      {
        "prompt": "Question or message for this turn",
        "follow_up": "Optional follow-up probe if the response is vague or short"
      }
    ],
    "closing": "Closing message to end the conversation gracefully"
  },
  "persona": {
    "name": "AI persona first name (friendly, professional)",
    "role": "Role description (e.g. 'Product Researcher at [Company]')",
    "tone": "Tone description (e.g. 'warm, curious, non-salesy')",
    "instructions": "Behavioral instructions for the AI (2-3 sentences)"
  }
}

Requirements:
- The script should have 3-5 turns covering the campaign goal
- Each turn should have a clear, open-ended question
- Include follow-up probes for vague answers
- The persona should feel human and trustworthy, not robotic
- The opening should explain who the AI is and why they are reaching out
- The closing should thank the user and set expectations for next steps`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
    max_tokens: 2048,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned an empty response for script generation");
  }

  // Strip accidental markdown fences
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned) as ScriptGenerationResult;

  if (!parsed.script || !parsed.persona) {
    throw new Error("OpenAI response missing required script or persona fields");
  }

  return parsed;
}

// ── GET /api/projects/:id/campaigns ─────────────────────────────────────────

/**
 * Lists all campaigns for a project.
 *
 * Responses:
 *   200 — { campaigns: Campaign[] }
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 */
export const GET = withAuth<{ id: string }>(async (request, { params, auth }) => {
  const { accountId } = auth;
  const { id: projectId } = await params;

  try {
    const project = await verifyProjectOwnership(projectId, accountId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const campaignList = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.projectId, projectId))
      .orderBy(desc(campaigns.createdAt));

    return NextResponse.json({ campaigns: campaignList });
  } catch (err) {
    console.error("[GET /api/projects/:id/campaigns] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
});

// ── POST /api/projects/:id/campaigns ────────────────────────────────────────

/**
 * Creates a new campaign for a project.
 * Auto-generates a conversation script and AI persona via OpenAI.
 *
 * Request body (JSON):
 *   {
 *     name: string,
 *     goal: "pmf_survey" | "pain_point_discovery" | "feature_validation" | "churn_investigation",
 *     channels: ("email" | "sms" | "voice" | "widget")[],
 *     segment_filter?: string[]
 *   }
 *
 * Responses:
 *   201 — Created campaign object (with generated script and persona).
 *   400 — Validation error.
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 */
export const POST = withAuth<{ id: string }>(async (request, { params, auth }) => {
  const { accountId } = auth;
  const { id: projectId } = await params;

  try {
    const project = await verifyProjectOwnership(projectId, accountId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Parse and validate request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = createCampaignSchema.safeParse(body);
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

    const { name, goal, channels, segment_filter } = parsed.data;

    // Auto-generate conversation script and AI persona (Requirement 9.4)
    let scriptData: ScriptGenerationResult;
    try {
      scriptData = await generateScriptAndPersona(
        goal,
        project.description,
        project.icpDescription,
      );
    } catch (err) {
      console.error(
        "[POST /api/projects/:id/campaigns] Script generation failed:",
        err,
      );
      // Fall back to empty script/persona so the campaign can still be created
      scriptData = {
        script: { opening: "", turns: [], closing: "" },
        persona: { name: "", role: "", tone: "", instructions: "" },
      };
    }

    // Insert campaign
    const [created] = await db
      .insert(campaigns)
      .values({
        projectId,
        name,
        goal,
        channels,
        segmentFilter: segment_filter,
        script: scriptData.script,
        persona: scriptData.persona,
        status: "draft",
      })
      .returning();

    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    console.error("[POST /api/projects/:id/campaigns] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
});
