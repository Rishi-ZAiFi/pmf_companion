/**
 * GET /api/integrations/intercom/callback
 *
 * Handles the Intercom OAuth 2.0 callback after the founder authorizes the app.
 *
 * Flow:
 *   1. Validate the `state` parameter to prevent CSRF attacks.
 *   2. Exchange the `code` for an access token via Intercom's token endpoint.
 *   3. Fetch the Intercom workspace info to store in config.
 *   4. Encrypt the access token with AES-256-GCM.
 *   5. Upsert the integration record in the `integrations` table.
 *   6. Redirect the founder to the integrations settings page.
 *
 * Requirements: 20.2
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { encrypt } from "@/lib/encryption";
import { env } from "@/lib/env";

/** Shape of a successful Intercom token response. */
interface IntercomTokenResponse {
  token?: string;
  access_token?: string;
  token_type?: string;
}

/** Shape of the Intercom /me endpoint response. */
interface IntercomMeResponse {
  type?: string;
  id?: string;
  name?: string;
  app?: {
    id_code?: string;
    name?: string;
    region?: string;
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");

  // ── 1. Handle user-denied authorization ────────────────────────────────────
  if (errorParam) {
    const redirectUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
    redirectUrl.searchParams.set("intercom_error", errorParam);
    return NextResponse.redirect(redirectUrl.toString());
  }

  // ── 2. Validate required parameters ────────────────────────────────────────
  if (!code || !state) {
    return NextResponse.json(
      { error: "Missing required OAuth parameters: code and state." },
      { status: 400 },
    );
  }

  // ── 3. Decode and validate the state parameter (CSRF check) ────────────────
  let accountId: string;
  try {
    accountId = Buffer.from(state, "base64url").toString("utf8");
    // Basic UUID format validation
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
      throw new Error("Invalid UUID format");
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid state parameter." },
      { status: 400 },
    );
  }

  // ── 4. Validate Intercom credentials are configured ─────────────────────────
  if (!env.INTERCOM_CLIENT_ID || !env.INTERCOM_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "Intercom integration is not configured on this server." },
      { status: 503 },
    );
  }

  // ── 5. Exchange the code for an access token ────────────────────────────────
  const redirectUri = `${env.NEXTAUTH_URL}/api/integrations/intercom/callback`;

  const tokenResponse = await fetch("https://api.intercom.io/auth/eagle/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      code,
      client_id: env.INTERCOM_CLIENT_ID,
      client_secret: env.INTERCOM_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error(
      `[intercom/callback] Token exchange HTTP error: ${tokenResponse.status} ${errorText}`,
    );
    const redirectUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
    redirectUrl.searchParams.set("intercom_error", "token_exchange_failed");
    return NextResponse.redirect(redirectUrl.toString());
  }

  const tokenData = (await tokenResponse.json()) as IntercomTokenResponse;

  // Intercom may return either `token` or `access_token`
  const accessToken = tokenData.access_token ?? tokenData.token;

  if (!accessToken) {
    console.error("[intercom/callback] No access_token in Intercom response");
    const redirectUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
    redirectUrl.searchParams.set("intercom_error", "token_exchange_failed");
    return NextResponse.redirect(redirectUrl.toString());
  }

  // ── 6. Fetch workspace info to store in config ──────────────────────────────
  let workspaceInfo: IntercomMeResponse = {};
  try {
    const meResponse = await fetch("https://api.intercom.io/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    if (meResponse.ok) {
      workspaceInfo = (await meResponse.json()) as IntercomMeResponse;
    }
  } catch (err) {
    // Non-fatal — we can still store the token without workspace info
    console.warn("[intercom/callback] Could not fetch workspace info:", err);
  }

  // ── 7. Encrypt the access token ─────────────────────────────────────────────
  const encryptedToken = encrypt(accessToken);

  // ── 8. Build the integration config ─────────────────────────────────────────
  const config: Record<string, unknown> = {
    app_id: workspaceInfo.app?.id_code ?? null,
    app_name: workspaceInfo.app?.name ?? null,
    region: workspaceInfo.app?.region ?? null,
    admin_id: workspaceInfo.id ?? null,
    admin_name: workspaceInfo.name ?? null,
  };

  // ── 9. Upsert the integration record ────────────────────────────────────────
  await db
    .insert(integrations)
    .values({
      accountId,
      provider: "intercom",
      accessToken: encryptedToken,
      config,
    })
    .onConflictDoUpdate({
      target: [integrations.accountId, integrations.provider],
      set: {
        accessToken: encryptedToken,
        config,
        updatedAt: sql`now()`,
      },
    });

  console.log(`[intercom/callback] Intercom integration connected for account ${accountId}`);

  // ── 10. Redirect to the integrations settings page ──────────────────────────
  const successUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
  successUrl.searchParams.set("intercom_connected", "true");
  return NextResponse.redirect(successUrl.toString());
}
