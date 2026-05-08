/**
 * /api/integrations/segment
 *
 * Segment source integration management.
 *
 * GET    — Return the current Segment integration status, project mapping,
 *          and trigger events (without exposing the shared secret).
 *
 * POST   — Configure the Segment integration. Stores the shared secret
 *          (encrypted) and the project/event mapping in the `integrations`
 *          table. Upserts on conflict so re-configuring is idempotent.
 *
 * DELETE — Disconnect the Segment integration by removing the record.
 *
 * Integration config structure (stored in `config` JSONB):
 *   {
 *     project_id:     string    — which project receives the events
 *     trigger_events: string[]  — Segment event names that trigger a widget conversation
 *   }
 *
 * The shared secret used for HMAC-SHA256 signature verification is stored
 * encrypted in `access_token` (AES-256-GCM via the encryption module).
 *
 * Requirements: 20.5
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { projects } from "@/db/schema/projects";
import { requireAuth } from "@/lib/require-auth";
import { encrypt } from "@/lib/encryption";

// ── Validation schema ─────────────────────────────────────────────────────────

const configureSchema = z.object({
  /** The shared secret used to verify Segment webhook signatures (HMAC-SHA256). */
  shared_secret: z.string().min(1, "shared_secret must not be empty"),
  /** The project ID that should receive events from this Segment source. */
  project_id: z.string().uuid("project_id must be a valid UUID"),
  /**
   * Segment event names that should trigger a widget conversation.
   * An empty array means all events trigger a conversation.
   */
  trigger_events: z.array(z.string()).default([]),
});

// ── GET /api/integrations/segment ─────────────────────────────────────────────

/**
 * Returns the current Segment integration status for the authenticated account.
 * The shared secret (access_token) is never returned to the client.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  const [row] = await db
    .select({
      id: integrations.id,
      config: integrations.config,
      createdAt: integrations.createdAt,
      updatedAt: integrations.updatedAt,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.accountId, accountId),
        eq(integrations.provider, "segment"),
      ),
    )
    .limit(1);

  if (!row) {
    return NextResponse.json({ connected: false });
  }

  const config = row.config as Record<string, unknown> | null;

  return NextResponse.json({
    connected: true,
    projectId: config?.project_id ?? null,
    triggerEvents: config?.trigger_events ?? [],
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// ── POST /api/integrations/segment ────────────────────────────────────────────

/**
 * Configure (or reconfigure) the Segment integration.
 *
 * Body:
 *   {
 *     shared_secret:  string    — HMAC-SHA256 shared secret from Segment
 *     project_id:     string    — UUID of the project to map events to
 *     trigger_events: string[]  — event names that trigger widget conversations
 *   }
 *
 * The shared secret is encrypted with AES-256-GCM before storage.
 * Upserts on (account_id, provider) conflict so re-configuring is idempotent.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  // ── Parse and validate request body ──────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = configureSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { shared_secret, project_id, trigger_events } = parsed.data;

  // ── Verify the project belongs to this account ────────────────────────────
  const [project] = await db
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .where(and(eq(projects.id, project_id), eq(projects.accountId, accountId)))
    .limit(1);

  if (!project) {
    return NextResponse.json(
      { error: "Project not found or does not belong to this account." },
      { status: 404 },
    );
  }

  if (project.status === "deleted") {
    return NextResponse.json(
      { error: "Cannot configure Segment integration for a deleted project." },
      { status: 400 },
    );
  }

  // ── Encrypt the shared secret ─────────────────────────────────────────────
  const encryptedSecret = encrypt(shared_secret);

  // ── Upsert the integration record ─────────────────────────────────────────
  const config = {
    project_id,
    trigger_events,
  };

  const [upserted] = await db
    .insert(integrations)
    .values({
      accountId,
      provider: "segment",
      accessToken: encryptedSecret,
      config,
    })
    .onConflictDoUpdate({
      target: [integrations.accountId, integrations.provider],
      set: {
        accessToken: encryptedSecret,
        config,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: integrations.id,
      createdAt: integrations.createdAt,
      updatedAt: integrations.updatedAt,
    });

  console.log(
    `[segment-integration] Configured for account ${accountId}, project ${project_id} (${trigger_events.length} trigger events)`,
  );

  return NextResponse.json({
    success: true,
    id: upserted.id,
    projectId: project_id,
    triggerEvents: trigger_events,
    connectedAt: upserted.createdAt,
    updatedAt: upserted.updatedAt,
  });
}

// ── DELETE /api/integrations/segment ──────────────────────────────────────────

/**
 * Disconnects the Segment integration by deleting the integration record.
 * After this, no Segment events will trigger widget conversations.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  const result = await db
    .delete(integrations)
    .where(
      and(
        eq(integrations.accountId, accountId),
        eq(integrations.provider, "segment"),
      ),
    )
    .returning({ id: integrations.id });

  if (result.length === 0) {
    return NextResponse.json(
      { error: "No Segment integration found for this account." },
      { status: 404 },
    );
  }

  console.log(`[segment-integration] Disconnected for account ${accountId}`);

  return NextResponse.json({ success: true });
}
