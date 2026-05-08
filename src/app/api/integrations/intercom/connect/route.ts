/**
 * GET /api/integrations/intercom/connect
 *
 * Initiates the Intercom OAuth 2.0 authorization flow by redirecting the
 * authenticated founder to Intercom's authorization URL.
 *
 * The `state` parameter encodes the accountId (base64url) to verify the
 * callback and prevent CSRF attacks.
 *
 * Requirements: 20.2
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { env } from "@/lib/env";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticate the request
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  // 2. Validate that Intercom credentials are configured
  if (!env.INTERCOM_CLIENT_ID) {
    return NextResponse.json(
      { error: "Intercom integration is not configured on this server." },
      { status: 503 },
    );
  }

  // 3. Build the state parameter (base64url-encoded accountId for CSRF protection)
  const state = Buffer.from(accountId).toString("base64url");

  // 4. Build the Intercom OAuth authorization URL
  const redirectUri = `${env.NEXTAUTH_URL}/api/integrations/intercom/callback`;

  const params = new URLSearchParams({
    client_id: env.INTERCOM_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
  });

  const authorizationUrl = `https://app.intercom.com/oauth?${params.toString()}`;

  // 5. Redirect the founder to Intercom
  return NextResponse.redirect(authorizationUrl);
}
