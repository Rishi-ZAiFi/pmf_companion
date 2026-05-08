/**
 * /api/integrations/intercom
 *
 * GET    — Return the current Intercom integration status (connected/disconnected)
 *          and workspace info (without exposing the access token).
 *
 * DELETE — Disconnect the Intercom integration for the authenticated account.
 *          Removes the integration record from the database.
 *
 * Requirements: 20.2
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { requireAuth } from "@/lib/require-auth";

// ── GET /api/integrations/intercom ────────────────────────────────────────────

/**
 * Returns the current Intercom integration status for the authenticated account.
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
        eq(integrations.provider, "intercom"),
      ),
    )
    .limit(1);

  if (!row) {
    return NextResponse.json({ connected: false });
  }

  const config = row.config as Record<string, unknown> | null;

  return NextResponse.json({
    connected: true,
    appId: config?.app_id ?? null,
    appName: config?.app_name ?? null,
    region: config?.region ?? null,
    adminName: config?.admin_name ?? null,
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// ── DELETE /api/integrations/intercom ─────────────────────────────────────────

/**
 * Disconnects the Intercom integration by deleting the integration record.
 * After this, no Intercom sync or attribute-push operations will run for the account.
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
        eq(integrations.provider, "intercom"),
      ),
    )
    .returning({ id: integrations.id });

  if (result.length === 0) {
    return NextResponse.json(
      { error: "No Intercom integration found for this account." },
      { status: 404 },
    );
  }

  console.log(`[intercom] Integration disconnected for account ${accountId}`);

  return NextResponse.json({ success: true });
}
