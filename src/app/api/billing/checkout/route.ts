/**
 * POST /api/billing/checkout
 *
 * Creates a Stripe Checkout session for new subscriptions or plan upgrades.
 *
 * The caller provides the desired plan tier. The handler:
 *   1. Looks up (or creates) the Stripe customer for the authenticated account.
 *   2. Resolves the Stripe price ID for the requested plan from environment variables.
 *   3. Creates a Checkout session in `subscription` mode.
 *   4. Returns the session URL for the client to redirect to.
 *
 * Request body (JSON):
 *   { plan: 'starter' | 'growth' | 'enterprise' }
 *
 * Responses:
 *   200 — { url: string }
 *   400 — Invalid plan or missing body.
 *   401 — Not authenticated.
 *   500 — Stripe or database error.
 *
 * Requirements: 21.5
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { requireAuth } from "@/lib/require-auth";
import { env } from "@/lib/env";

// ── Stripe client ─────────────────────────────────────────────────────────────

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// ── Plan → price ID mapping ───────────────────────────────────────────────────

/**
 * Resolves the Stripe price ID for a given plan tier.
 * Price IDs are read from environment variables so they can differ between
 * test and production environments without code changes.
 */
function getPriceId(plan: string): string | null {
  switch (plan) {
    case "starter":
      return process.env.STRIPE_PRICE_STARTER ?? null;
    case "growth":
      return process.env.STRIPE_PRICE_GROWTH ?? null;
    case "enterprise":
      return process.env.STRIPE_PRICE_ENTERPRISE ?? null;
    default:
      return null;
  }
}

// ── Request schema ────────────────────────────────────────────────────────────

const checkoutSchema = z.object({
  plan: z.enum(["starter", "growth", "enterprise"], {
    errorMap: () => ({
      message: "plan must be one of: starter, growth, enterprise",
    }),
  }),
});

// ── Route handler ─────────────────────────────────────────────────────────────

/**
 * POST /api/billing/checkout
 *
 * Requirements: 21.5
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Authenticate ───────────────────────────────────────────────────────
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  // ── 2. Parse and validate request body ───────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const { plan } = parsed.data;

  // ── 3. Resolve Stripe price ID ────────────────────────────────────────────
  const priceId = getPriceId(plan);
  if (!priceId) {
    return NextResponse.json(
      {
        error: `No Stripe price configured for plan '${plan}'. Set STRIPE_PRICE_${plan.toUpperCase()} in your environment.`,
      },
      { status: 400 },
    );
  }

  try {
    // ── 4. Load account record ────────────────────────────────────────────
    const [account] = await db
      .select({
        id: accounts.id,
        email: accounts.email,
        name: accounts.name,
        stripeCustomerId: accounts.stripeCustomerId,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // ── 5. Get or create Stripe customer ──────────────────────────────────
    let customerId = account.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: account.email,
        name: account.name ?? undefined,
        metadata: { accountId },
      });

      customerId = customer.id;

      // Persist the new customer ID so future calls reuse it
      await db
        .update(accounts)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(accounts.id, accountId));

      console.log(
        `[billing/checkout] Created Stripe customer ${customerId} for account ${accountId}`,
      );
    }

    // ── 6. Create Checkout session ────────────────────────────────────────
    const baseUrl = env.NEXTAUTH_URL;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      // Allow the customer to switch between plans at checkout
      subscription_data: {
        metadata: { accountId, plan },
      },
      // Redirect URLs — the client handles the result on these pages
      success_url: `${baseUrl}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/billing?checkout=cancelled`,
      // Pre-fill the customer's email to reduce friction
      customer_update: {
        address: "auto",
      },
      // Allow promotion codes
      allow_promotion_codes: true,
      // Collect billing address for tax purposes
      billing_address_collection: "auto",
    });

    if (!session.url) {
      console.error(
        `[billing/checkout] Stripe returned a session without a URL for account ${accountId}`,
      );
      return NextResponse.json(
        { error: "Failed to create checkout session: no URL returned" },
        { status: 500 },
      );
    }

    console.log(
      `[billing/checkout] Created checkout session ${session.id} for account ${accountId} (plan: ${plan})`,
    );

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[billing/checkout] Unexpected error:", err);

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
