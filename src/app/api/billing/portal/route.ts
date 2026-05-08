/**
 * POST /api/billing/portal
 *
 * Creates a Stripe Billing Portal session for the authenticated account.
 *
 * The Billing Portal lets founders manage their subscription without leaving
 * the Stripe-hosted UI: cancel, update payment method, view invoices, and
 * switch plans (if the portal is configured to allow it in the Stripe Dashboard).
 *
 * The handler:
 *   1. Looks up the Stripe customer ID for the authenticated account.
 *   2. Creates a Billing Portal session for that customer.
 *   3. Returns the session URL for the client to redirect to.
 *
 * If the account has no Stripe customer yet (i.e. they have never subscribed),
 * the handler returns a 400 error directing them to use the Checkout flow first.
 *
 * Responses:
 *   200 — { url: string }
 *   400 — No Stripe customer exists for this account.
 *   401 — Not authenticated.
 *   500 — Stripe or database error.
 *
 * Requirements: 21.5
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { requireAuth } from "@/lib/require-auth";
import { env } from "@/lib/env";

// ── Stripe client ─────────────────────────────────────────────────────────────

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// ── Route handler ─────────────────────────────────────────────────────────────

/**
 * POST /api/billing/portal
 *
 * Requirements: 21.5
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Authenticate ───────────────────────────────────────────────────────
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  try {
    // ── 2. Load account record ────────────────────────────────────────────
    const [account] = await db
      .select({
        id: accounts.id,
        stripeCustomerId: accounts.stripeCustomerId,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // ── 3. Guard: customer must exist ─────────────────────────────────────
    if (!account.stripeCustomerId) {
      return NextResponse.json(
        {
          error:
            "No billing account found. Please subscribe to a plan first using the checkout flow.",
          checkout_required: true,
        },
        { status: 400 },
      );
    }

    // ── 4. Create Billing Portal session ──────────────────────────────────
    const baseUrl = env.NEXTAUTH_URL;

    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${baseUrl}/billing`,
    });

    console.log(
      `[billing/portal] Created billing portal session ${session.id} for account ${accountId} (customer ${account.stripeCustomerId})`,
    );

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[billing/portal] Unexpected error:", err);

    if (err instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: `Stripe error: ${err.message}` },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
