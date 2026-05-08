/**
 * GET  /api/projects/:id/webhooks  — list all webhook endpoints for a project
 * POST /api/projects/:id/webhooks  — create a new webhook endpoint (max 10 per project)
 *
 * Requirements: 20.4
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and, count } from "drizzle-orm";
import { randomBytes } from "crypto";
import { z } from "zod";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { webhookEndpoints } from "@/db/schema/webhook-endpoints";
import { requireAuth } from "@/lib/require-auth";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Requirement 20.4: maximum 10 webhook endpoints per project */
const MAX_WEBHOOKS_PER_PROJECT = 10;

/** Supported event types */
const VALID_EVENTS = ["signal.created", "pmf_score.changed"] as const;

// ── Validation ────────────────────────────────────────────────────────────────

const createWebhookSchema = z.object({
  url: z.string().url("url must be a valid URL"),
  events: z
    .array(z.enum(VALID_EVENTS))
    .min(1, "At least one event type is required")
    .refine(
      (arr) => new Set(arr).size === arr.length,
      "events must not contain duplicates",
    ),
});

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

// ── GET /api/projects/:id/webhooks ────────────────────────────────────────────

/**
 * List all webhook endpoints for a project.
 *
 * Response shape:
 * ```json
 * {
 *   "webhooks": [
 *     {
 *       "id": "uuid",
 *       "url": "https://example.com/hook",
 *       "events": ["signal.created"],
 *       "isActive": true,
 *       "createdAt": "2024-01-01T00:00:00Z"
 *     }
 *   ]
 * }
 * ```
 *
 * Note: The `secret` field is intentionally omitted from the response for security.
 *
 * Responses:
 *   200 — List of webhook endpoints (may be empty).
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 *
 * Requirements: 20.4
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id: projectId } = await params;

  try {
    const project = await verifyProjectAccess(projectId, accountId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const rows = await db
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        events: webhookEndpoints.events,
        isActive: webhookEndpoints.isActive,
        createdAt: webhookEndpoints.createdAt,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.projectId, projectId))
      .orderBy(webhookEndpoints.createdAt);

    return NextResponse.json({ webhooks: rows });
  } catch (err) {
    console.error("[GET /api/projects/:id/webhooks] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}

// ── POST /api/projects/:id/webhooks ───────────────────────────────────────────

/**
 * Create a new webhook endpoint for a project.
 *
 * Request body:
 * ```json
 * {
 *   "url": "https://example.com/hook",
 *   "events": ["signal.created", "pmf_score.changed"]
 * }
 * ```
 *
 * Response shape (201):
 * ```json
 * {
 *   "webhook": {
 *     "id": "uuid",
 *     "url": "https://example.com/hook",
 *     "secret": "hex-encoded-secret",
 *     "events": ["signal.created"],
 *     "isActive": true,
 *     "createdAt": "2024-01-01T00:00:00Z"
 *   }
 * }
 * ```
 *
 * Note: The `secret` is only returned on creation. Store it securely — it will
 * not be returned again.
 *
 * Responses:
 *   201 — Webhook endpoint created.
 *   400 — Validation error or max 10 endpoints reached.
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 *
 * Requirements: 20.4
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;
  const { id: projectId } = await params;

  try {
    const project = await verifyProjectAccess(projectId, accountId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // ── Parse and validate request body ──────────────────────────────────────
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    const parsed = createWebhookSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { url, events } = parsed.data;

    // ── Enforce max 10 endpoints per project ──────────────────────────────────
    const [{ total }] = await db
      .select({ total: count() })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.projectId, projectId));

    if (total >= MAX_WEBHOOKS_PER_PROJECT) {
      return NextResponse.json(
        {
          error: `Maximum of ${MAX_WEBHOOKS_PER_PROJECT} webhook endpoints per project reached`,
        },
        { status: 400 },
      );
    }

    // ── Generate a cryptographically random signing secret ────────────────────
    const secret = randomBytes(32).toString("hex");

    // ── Insert the new endpoint ───────────────────────────────────────────────
    const [created] = await db
      .insert(webhookEndpoints)
      .values({
        projectId,
        url,
        secret,
        events,
        isActive: true,
      })
      .returning({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        secret: webhookEndpoints.secret,
        events: webhookEndpoints.events,
        isActive: webhookEndpoints.isActive,
        createdAt: webhookEndpoints.createdAt,
      });

    return NextResponse.json({ webhook: created }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/projects/:id/webhooks] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
