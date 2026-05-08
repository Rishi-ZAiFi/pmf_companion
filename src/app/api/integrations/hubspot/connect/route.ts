/**
 * GET /api/integrations/hubspot/connect
 *
 * Initiates the HubSpot OAuth 2.0 authorization flow by redirecting the
 * authenticated founder to HubSpot's authorization URL.
 *
 * Required HubSpot OAuth scopes:
 *   - crm.objects.contacts.read   — read contact records
 *   - crm.objects.contacts.write  — update contact properties (push tags)
 *
 * The `state` parameter encodes the accountId (base64url) to verify the
 * callback and prevent CSRF attacks.
 *
 * Requirements: 20.2
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { env } from "@/lib/env";

/** HubSpot OAuth scopes required for the integration. */
const HUBSPOT_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
].join(" ");

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticate the request
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  // 2. Validate that HubSpot credentials are configured
  if (!env.HUBSPOT_CLIENT_ID) {
    return NextResponse.json(
      { error: "HubSpot integration is not configured on this server." },
      { status: 503 },
    );
  }

  // 3. Build the state parameter (base64url-encoded accountId for CSRF protection)
  const state = Buffer.from(accountId).toString("base64url");

  // 4. Build the HubSpot OAuth authorization URL
  const redirectUri = `${env.NEXTAUTH_URL}/api/integrations/hubspot/callback`;

  const params = new URLSearchParams({
    client_id: env.HUBSPOT_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: HUBSPOT_SCOPES,
    state,
  });

  const authorizationUrl = `https://app.hubspot.com/oauth/authorize?${params.toString()}`;

  // 5. Redirect the founder to HubSpot
  return NextResponse.redirect(authorizationUrl);
}
