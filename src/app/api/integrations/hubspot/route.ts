/**
 * /api/integrations/hubspot
 *
 * GET    — Return the current HubSpot integration status (connected/disconnected)
 *          and portal info (without exposing the access token).
 *
 * DELETE — Disconnect the HubSpot integration for the authenticated account.
 *          Removes the integration record from the database.
 *
 * Requirements: 20.2
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { requireAuth } from "@/lib/require-auth";

// ── GET /api/integrations/hubspot ─────────────────────────────────────────────

/**
 * Returns the current HubSpot integration status for the authenticated account.
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
        eq(integrations.provider, "hubspot"),
      ),
    )
    .limit(1);

  if (!row) {
    return NextResponse.json({ connected: false });
  }

  const config = row.config as Record<string, unknown> | null;

  return NextResponse.json({
    connected: true,
    hubId: config?.hub_id ?? null,
    hubDomain: config?.hub_domain ?? null,
    user: config?.user ?? null,
    scopes: config?.scopes ?? [],
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// ── DELETE /api/integrations/hubspot ──────────────────────────────────────────

/**
 * Disconnects the HubSpot integration by deleting the integration record.
 * After this, no HubSpot sync or tag-push operations will run for the account.
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
        eq(integrations.provider, "hubspot"),
      ),
    )
    .returning({ id: integrations.id });

  if (result.length === 0) {
    return NextResponse.json(
      { error: "No HubSpot integration found for this account." },
      { status: 404 },
    );
  }

  console.log(`[hubspot] Integration disconnected for account ${accountId}`);

  return NextResponse.json({ success: true });
}
