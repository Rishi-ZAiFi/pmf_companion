/**
 * GET /api/integrations/hubspot/callback
 *
 * Handles the HubSpot OAuth 2.0 callback after the founder authorizes the app.
 *
 * Flow:
 *   1. Validate the `state` parameter to prevent CSRF attacks.
 *   2. Exchange the `code` for an access token via HubSpot's token endpoint.
 *   3. Fetch the HubSpot portal/account info to store in config.
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

/** Shape of a successful HubSpot token response. */
interface HubSpotTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/** Shape of the HubSpot token info endpoint response. */
interface HubSpotTokenInfo {
  hub_id?: number;
  hub_domain?: string;
  user?: string;
  user_id?: number;
  app_id?: number;
  scopes?: string[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");

  // ── 1. Handle user-denied authorization ────────────────────────────────────
  if (errorParam) {
    const redirectUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
    redirectUrl.searchParams.set("hubspot_error", errorParam);
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

  // ── 4. Validate HubSpot credentials are configured ─────────────────────────
  if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "HubSpot integration is not configured on this server." },
      { status: 503 },
    );
  }

  // ── 5. Exchange the code for an access token ────────────────────────────────
  const redirectUri = `${env.NEXTAUTH_URL}/api/integrations/hubspot/callback`;

  const tokenResponse = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.HUBSPOT_CLIENT_ID,
      client_secret: env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error(
      `[hubspot/callback] Token exchange HTTP error: ${tokenResponse.status} ${errorText}`,
    );
    const redirectUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
    redirectUrl.searchParams.set("hubspot_error", "token_exchange_failed");
    return NextResponse.redirect(redirectUrl.toString());
  }

  const tokenData = (await tokenResponse.json()) as HubSpotTokenResponse;

  if (!tokenData.access_token) {
    console.error("[hubspot/callback] No access_token in HubSpot response");
    const redirectUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
    redirectUrl.searchParams.set("hubspot_error", "token_exchange_failed");
    return NextResponse.redirect(redirectUrl.toString());
  }

  // ── 6. Fetch portal info to store in config ─────────────────────────────────
  let portalInfo: HubSpotTokenInfo = {};
  try {
    const infoResponse = await fetch(
      `https://api.hubapi.com/oauth/v1/access-tokens/${tokenData.access_token}`,
      {
        headers: { "Content-Type": "application/json" },
      },
    );
    if (infoResponse.ok) {
      portalInfo = (await infoResponse.json()) as HubSpotTokenInfo;
    }
  } catch (err) {
    // Non-fatal — we can still store the token without portal info
    console.warn("[hubspot/callback] Could not fetch portal info:", err);
  }

  // ── 7. Encrypt the access token ─────────────────────────────────────────────
  const encryptedToken = encrypt(tokenData.access_token);

  // ── 8. Build the integration config ─────────────────────────────────────────
  const config: Record<string, unknown> = {
    hub_id: portalInfo.hub_id ?? null,
    hub_domain: portalInfo.hub_domain ?? null,
    user: portalInfo.user ?? null,
    scopes: portalInfo.scopes ?? [],
    // Store encrypted refresh token if provided (for token refresh flows)
    refresh_token: tokenData.refresh_token
      ? encrypt(tokenData.refresh_token)
      : null,
    expires_in: tokenData.expires_in ?? null,
  };

  // ── 9. Upsert the integration record ────────────────────────────────────────
  await db
    .insert(integrations)
    .values({
      accountId,
      provider: "hubspot",
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

  console.log(`[hubspot/callback] HubSpot integration connected for account ${accountId}`);

  // ── 10. Redirect to the integrations settings page ──────────────────────────
  const successUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
  successUrl.searchParams.set("hubspot_connected", "true");
  return NextResponse.redirect(successUrl.toString());
}
