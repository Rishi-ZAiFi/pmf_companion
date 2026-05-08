/**
 * GET /api/integrations/slack/connect
 *
 * Initiates the Slack OAuth 2.0 authorization flow by redirecting the
 * authenticated founder to Slack's authorization URL.
 *
 * Required Slack OAuth scopes:
 *   - chat:write       — post messages to channels
 *   - channels:read    — list public channels (for channel picker)
 *   - groups:read      — list private channels the bot is in
 *
 * The `state` parameter encodes the accountId (base64) to verify the callback
 * and prevent CSRF attacks.
 *
 * Requirements: 20.1
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { env } from "@/lib/env";

/** Slack OAuth scopes required for the integration. */
const SLACK_SCOPES = ["chat:write", "channels:read", "groups:read"].join(",");

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticate the request
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  // 2. Validate that Slack credentials are configured
  if (!env.SLACK_CLIENT_ID) {
    return NextResponse.json(
      { error: "Slack integration is not configured on this server." },
      { status: 503 },
    );
  }

  // 3. Build the state parameter (base64-encoded accountId for CSRF protection)
  const state = Buffer.from(accountId).toString("base64url");

  // 4. Build the Slack OAuth authorization URL
  const redirectUri = `${env.NEXTAUTH_URL}/api/integrations/slack/callback`;

  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: SLACK_SCOPES,
    redirect_uri: redirectUri,
    state,
  });

  const authorizationUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;

  // 5. Redirect the founder to Slack
  return NextResponse.redirect(authorizationUrl);
}
