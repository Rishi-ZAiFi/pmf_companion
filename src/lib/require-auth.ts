import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The auth context returned by `requireAuth` on a successful authentication
 * check. Contains the validated session and the extracted account identifiers.
 */
export interface AuthContext {
  /** UUID from the `accounts` table — used to scope all DB queries via RLS. */
  accountId: string;
  /** Billing plan tier: free | starter | growth | enterprise */
  planTier: string;
  /** The full NextAuth session object. */
  session: Session;
}

/**
 * Discriminated union returned by `requireAuth`.
 *
 * On success, `ok` is `true` and the auth context is available.
 * On failure, `ok` is `false` and `response` is a ready-to-return 401 NextResponse.
 */
export type AuthResult =
  | ({ ok: true } & AuthContext)
  | { ok: false; response: NextResponse };

// ── Core helper ──────────────────────────────────────────────────────────────

/**
 * Validates the current session and sets `app.current_account_id` on the
 * PostgreSQL connection so that Row-Level Security policies can enforce
 * tenant isolation.
 *
 * **Usage in a route handler:**
 * ```ts
 * export async function GET(request: NextRequest) {
 *   const auth = await requireAuth(request);
 *   if (!auth.ok) return auth.response;
 *
 *   const { accountId } = auth;
 *   // ... query the DB — RLS is already active for this accountId
 * }
 * ```
 *
 * **RLS note:** PostgreSQL's `SET LOCAL` only takes effect inside a
 * transaction. Because the Next.js API tier uses a connection pool (via
 * `postgres.js`), we use `SET` (session-level) here so the variable persists
 * for the lifetime of the pooled connection checkout. Route handlers that
 * need strict transaction isolation should wrap their queries in
 * `db.transaction()` and call `SET LOCAL` inside the transaction callback
 * instead.
 *
 * @param _request - The incoming Next.js request (reserved for future use,
 *   e.g. extracting bearer tokens from the `Authorization` header).
 */
export async function requireAuth(_request?: NextRequest): Promise<AuthResult> {
  // 1. Retrieve the current session via NextAuth.
  const session = await auth();

  // 2. Guard: no session at all.
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      ),
    };
  }

  // 3. Guard: session exists but is missing the custom accountId field.
  //    This can happen if the JWT callback didn't run (e.g. malformed token).
  const accountId = session.user?.accountId;
  if (!accountId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid session: missing account identifier" },
        { status: 401 },
      ),
    };
  }

  const planTier = session.user?.planTier ?? "free";

  // 4. Set the PostgreSQL session variable so RLS policies can read it.
  //    We use SET (not SET LOCAL) because SET LOCAL requires an open
  //    transaction and the connection pool may reuse connections across
  //    requests. The variable is scoped to the connection checkout.
  //
  //    The accountId is a UUID validated by NextAuth — we still use a
  //    parameterised query to prevent any injection risk.
  await db.execute(sql`SET app.current_account_id = ${accountId}`);

  return {
    ok: true,
    accountId,
    planTier,
    session,
  };
}

// ── Higher-order function wrapper ────────────────────────────────────────────

/**
 * A route handler type compatible with Next.js App Router.
 * The handler receives the auth context as its second argument.
 */
export type AuthenticatedHandler<TParams = Record<string, string>> = (
  request: NextRequest,
  context: { params: TParams; auth: AuthContext },
) => Promise<NextResponse> | NextResponse;

/**
 * Wraps a Next.js App Router route handler with authentication.
 *
 * The wrapped handler is only called when the request is authenticated.
 * On failure, a 401 response is returned automatically.
 *
 * **Usage:**
 * ```ts
 * export const GET = withAuth<{ id: string }>(async (request, { params, auth }) => {
 *   const { accountId } = auth;
 *   const project = await db.query.projects.findFirst({ ... });
 *   return NextResponse.json(project);
 * });
 * ```
 *
 * @param handler - The route handler to wrap.
 */
export function withAuth<TParams = Record<string, string>>(
  handler: AuthenticatedHandler<TParams>,
): (
  request: NextRequest,
  context: { params: TParams },
) => Promise<NextResponse> {
  return async (
    request: NextRequest,
    context: { params: TParams },
  ): Promise<NextResponse> => {
    const authResult = await requireAuth(request);

    if (!authResult.ok) {
      return authResult.response;
    }

    // authResult.ok is true here — extract the AuthContext fields.
    const authContext: AuthContext = {
      accountId: authResult.accountId,
      planTier: authResult.planTier,
      session: authResult.session,
    };

    return handler(request, { params: context.params, auth: authContext });
  };
}
