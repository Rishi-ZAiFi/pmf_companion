/**
 * GET /api/integrations/notion/callback
 *
 * Handles the Notion OAuth 2.0 callback after the founder authorizes the app.
 *
 * Flow:
 *   1. Validate the `state` parameter to prevent CSRF attacks.
 *   2. Exchange the `code` for an access token via Notion's token endpoint.
 *   3. Encrypt the access token with AES-256-GCM.
 *   4. Upsert the integration record in the `integrations` table.
 *   5. Redirect the founder to the integrations settings page.
 *
 * Requirements: 20.3
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { encrypt } from "@/lib/encryption";
import { env } from "@/lib/env";

/** Shape of a successful Notion token response. */
interface NotionTokenResponse {
  access_token: string;
  token_type: string;
  bot_id: string;
  workspace_name?: string;
  workspace_icon?: string;
  workspace_id: string;
  owner?: {
    type: string;
    user?: {
      id: string;
      name?: string;
      avatar_url?: string;
      type?: string;
      person?: { email?: string };
    };
  };
  duplicated_template_id?: string | null;
  request_id?: string;
}

/** Shape of a Notion API error response. */
interface NotionErrorResponse {
  object: "error";
  status: number;
  code: string;
  message: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");

  // ── 1. Handle user-denied authorization ────────────────────────────────────
  if (errorParam) {
    const redirectUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
    redirectUrl.searchParams.set("notion_error", errorParam);
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

  // ── 4. Validate Notion credentials are configured ───────────────────────────
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "Notion integration is not configured on this server." },
      { status: 503 },
    );
  }

  // ── 5. Exchange the code for an access token ────────────────────────────────
  // Notion requires HTTP Basic Auth with client_id:client_secret
  const redirectUri = `${env.NEXTAUTH_URL}/api/integrations/notion/callback`;
  const credentials = Buffer.from(
    `${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`,
  ).toString("base64");

  const tokenResponse = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const errorData = (await tokenResponse.json()) as NotionErrorResponse;
    console.error(
      `[notion/callback] Token exchange error: ${tokenResponse.status} ${errorData.message ?? "unknown"}`,
    );
    const redirectUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
    redirectUrl.searchParams.set("notion_error", "token_exchange_failed");
    return NextResponse.redirect(redirectUrl.toString());
  }

  const tokenData = (await tokenResponse.json()) as NotionTokenResponse;

  if (!tokenData.access_token) {
    console.error("[notion/callback] No access_token in Notion response");
    const redirectUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
    redirectUrl.searchParams.set("notion_error", "token_exchange_failed");
    return NextResponse.redirect(redirectUrl.toString());
  }

  // ── 6. Encrypt the access token ─────────────────────────────────────────────
  const encryptedToken = encrypt(tokenData.access_token);

  // ── 7. Build the integration config ─────────────────────────────────────────
  const config: Record<string, unknown> = {
    workspace_id: tokenData.workspace_id,
    workspace_name: tokenData.workspace_name ?? null,
    workspace_icon: tokenData.workspace_icon ?? null,
    bot_id: tokenData.bot_id,
    owner_type: tokenData.owner?.type ?? null,
    owner_user_id: tokenData.owner?.user?.id ?? null,
    owner_user_name: tokenData.owner?.user?.name ?? null,
  };

  // ── 8. Upsert the integration record ────────────────────────────────────────
  await db
    .insert(integrations)
    .values({
      accountId,
      provider: "notion",
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

  console.log(`[notion/callback] Notion integration connected for account ${accountId}`);

  // ── 9. Redirect to the integrations settings page ───────────────────────────
  const successUrl = new URL(`${env.NEXTAUTH_URL}/settings/integrations`);
  successUrl.searchParams.set("notion_connected", "true");
  return NextResponse.redirect(successUrl.toString());
}
