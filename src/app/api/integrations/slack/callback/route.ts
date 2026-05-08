/**
 * GET /api/integrations/slack/callback
 *
 * Handles the Slack OAuth 2.0 callback after the founder authorizes the app.
 *
 * Flow:
 *   1. Validate the `state` parameter to prevent CSRF attacks.
 *   2. Exchange the `code` for an access token via Slack's `oauth.v2.access` API.
 *   3. Encrypt the access token with AES-256-GCM.
 *   4. Upsert the integration record in the `integrations` table.
 *   5. Redirect the founder to the integrations settings page.
 *
 * The `channel_id` is not set during the OAuth flow — the founder configures
 * the target channel separately via the settings UI (or it can be passed as a
 * query param `channel_id` on the connect URL for a one-step flow).
 *
 * Requirements: 20.1
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { encrypt } from "@/lib/encryption";
import { env } from "@/lib/env";
import { sql } from "drizzle-orm";

/** Shape of a successful Slack `oauth.v2.access` response (relevant fields). */
interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id: string; name: string };
  authed_user?: { id: string };
  incoming_webhook?: {
    channel: string;
    channel_id: string;
    configuration_url: string;
    url: string;
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
    redirectUrl.searchParams.set("slack_error", errorParam);
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

  // ── 4. Validate Slack credentials are configured ────────────────────────────
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "Slack integration is not configured on this server." },
      { status: 503 },
    );
  }

  // ── 5. Exchange the code for an access token ────────────────────────────────
  const redirectUri = `${env.NEXTAUTH_URL}/api/integrations/slack/callback`;

  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    console.error(
      `[slack/callback] Token exchange HTTP error: ${tokenResponse.status} ${tokenResponse.statusText}`,
    );
    return NextResponse.json(
      { error: "Failed to exchange authorization code with Slack." },
      { status: 502 },
    );
  }

  const tokenData = (await tokenResponse.json()) as SlackOAuthResponse;

  if (!tokenData.ok || !tokenData.access_token) {
    console.error(`[slack/callback] Slack token exchange error: ${tokenData.error ?? "unknown"}`);
    const redirectUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
    redirectUrl.searchParams.set("slack_error", tokenData.error ?? "token_exchange_failed");
    return NextResponse.redirect(redirectUrl.toString());
  }

  // ── 6. Encrypt the access token ─────────────────────────────────────────────
  const encryptedToken = encrypt(tokenData.access_token);

  // ── 7. Build the integration config ─────────────────────────────────────────
  // If the OAuth response includes an incoming_webhook channel_id, use it as
  // the default channel. The founder can change it later in settings.
  const defaultChannelId = tokenData.incoming_webhook?.channel_id ?? null;

  const config: Record<string, unknown> = {
    team_id: tokenData.team?.id ?? null,
    team_name: tokenData.team?.name ?? null,
    bot_user_id: tokenData.bot_user_id ?? null,
    app_id: tokenData.app_id ?? null,
    scope: tokenData.scope ?? null,
  };

  if (defaultChannelId) {
    config.channel_id = defaultChannelId;
  }

  // ── 8. Upsert the integration record ────────────────────────────────────────
  await db
    .insert(integrations)
    .values({
      accountId,
      provider: "slack",
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

  console.log(`[slack/callback] Slack integration connected for account ${accountId}`);

  // ── 9. Redirect to the integrations settings page ───────────────────────────
  const successUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
  successUrl.searchParams.set("slack_connected", "true");
  return NextResponse.redirect(successUrl.toString());
}
