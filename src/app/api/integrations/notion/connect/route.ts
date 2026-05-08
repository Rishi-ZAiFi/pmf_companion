/**
 * GET /api/integrations/notion/connect
 *
 * Initiates the Notion OAuth 2.0 authorization flow by redirecting the
 * authenticated founder to Notion's authorization URL.
 *
 * Notion OAuth uses the standard authorization code flow. The integration
 * receives a bot token that can create pages in databases the user has
 * shared with the integration.
 *
 * The `state` parameter encodes the accountId (base64url) to verify the
 * callback and prevent CSRF attacks.
 *
 * Requirements: 20.3
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { env } from "@/lib/env";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticate the request
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  // 2. Validate that Notion credentials are configured
  if (!env.NOTION_CLIENT_ID) {
    return NextResponse.json(
      { error: "Notion integration is not configured on this server." },
      { status: 503 },
    );
  }

  // 3. Build the state parameter (base64url-encoded accountId for CSRF protection)
  const state = Buffer.from(accountId).toString("base64url");

  // 4. Build the Notion OAuth authorization URL
  const redirectUri = `${env.NEXTAUTH_URL}/api/integrations/notion/callback`;

  const params = new URLSearchParams({
    client_id: env.NOTION_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    owner: "user",
    state,
  });

  const authorizationUrl = `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;

  // 5. Redirect the founder to Notion
  return NextResponse.redirect(authorizationUrl);
}
