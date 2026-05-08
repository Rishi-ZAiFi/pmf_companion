/**
 * /api/integrations/slack
 *
 * DELETE — Disconnect the Slack integration for the authenticated account.
 *          Removes the integration record from the database.
 *
 * GET    — Return the current Slack integration status (connected/disconnected)
 *          and the configured channel ID (without exposing the access token).
 *
 * PATCH  — Update the Slack integration config (e.g. change the channel_id).
 *
 * Requirements: 20.1
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { requireAuth } from "@/lib/require-auth";
import { sql } from "drizzle-orm";

// ── GET /api/integrations/slack ───────────────────────────────────────────────

/**
 * Returns the current Slack integration status for the authenticated account.
 * The access token is never returned to the client.
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
        eq(integrations.provider, "slack"),
      ),
    )
    .limit(1);

  if (!row) {
    return NextResponse.json({ connected: false });
  }

  const config = row.config as Record<string, unknown> | null;

  return NextResponse.json({
    connected: true,
    channelId: config?.channel_id ?? null,
    teamName: config?.team_name ?? null,
    teamId: config?.team_id ?? null,
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// ── PATCH /api/integrations/slack ─────────────────────────────────────────────

/**
 * Update the Slack integration configuration.
 * Currently supports updating the `channel_id` where notifications are posted.
 *
 * Body: { channel_id: string }
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).channel_id !== "string"
  ) {
    return NextResponse.json(
      { error: "Request body must include a string field: channel_id" },
      { status: 400 },
    );
  }

  const channelId = (body as Record<string, string>).channel_id.trim();
  if (!channelId) {
    return NextResponse.json({ error: "channel_id must not be empty." }, { status: 400 });
  }

  // Fetch the existing integration to merge config
  const [existing] = await db
    .select({ config: integrations.config })
    .from(integrations)
    .where(
      and(
        eq(integrations.accountId, accountId),
        eq(integrations.provider, "slack"),
      ),
    )
    .limit(1);

  if (!existing) {
    return NextResponse.json(
      { error: "No Slack integration found. Connect Slack first." },
      { status: 404 },
    );
  }

  const existingConfig = (existing.config as Record<string, unknown>) ?? {};
  const updatedConfig = { ...existingConfig, channel_id: channelId };

  await db
    .update(integrations)
    .set({ config: updatedConfig, updatedAt: sql`now()` })
    .where(
      and(
        eq(integrations.accountId, accountId),
        eq(integrations.provider, "slack"),
      ),
    );

  return NextResponse.json({ success: true, channelId });
}

// ── DELETE /api/integrations/slack ────────────────────────────────────────────

/**
 * Disconnects the Slack integration by deleting the integration record.
 * After this, no Slack notifications will be sent for the account.
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
        eq(integrations.provider, "slack"),
      ),
    )
    .returning({ id: integrations.id });

  if (result.length === 0) {
    return NextResponse.json(
      { error: "No Slack integration found for this account." },
      { status: 404 },
    );
  }

  console.log(`[slack] Integration disconnected for account ${accountId}`);

  return NextResponse.json({ success: true });
}
