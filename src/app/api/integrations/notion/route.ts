/**
 * /api/integrations/notion
 *
 * GET    — Return the current Notion integration status (connected/disconnected)
 *          and workspace info (without exposing the access token).
 *
 * DELETE — Disconnect the Notion integration for the authenticated account.
 *          Removes the integration record from the database.
 *
 * Requirements: 20.3
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { requireAuth } from "@/lib/require-auth";

// ── GET /api/integrations/notion ──────────────────────────────────────────────

/**
 * Returns the current Notion integration status for the authenticated account.
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
        eq(integrations.provider, "notion"),
      ),
    )
    .limit(1);

  if (!row) {
    return NextResponse.json({ connected: false });
  }

  const config = row.config as Record<string, unknown> | null;

  return NextResponse.json({
    connected: true,
    workspaceId: config?.workspace_id ?? null,
    workspaceName: config?.workspace_name ?? null,
    workspaceIcon: config?.workspace_icon ?? null,
    botId: config?.bot_id ?? null,
    ownerType: config?.owner_type ?? null,
    ownerUserName: config?.owner_user_name ?? null,
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// ── DELETE /api/integrations/notion ───────────────────────────────────────────

/**
 * Disconnects the Notion integration by deleting the integration record.
 * After this, no Notion exports will be available for the account.
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
        eq(integrations.provider, "notion"),
      ),
    )
    .returning({ id: integrations.id });

  if (result.length === 0) {
    return NextResponse.json(
      { error: "No Notion integration found for this account." },
      { status: 404 },
    );
  }

  console.log(`[notion] Integration disconnected for account ${accountId}`);

  return NextResponse.json({ success: true });
}
