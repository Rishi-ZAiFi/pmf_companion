/**
 * GET /api/billing/status
 *
 * Returns the current billing status for the authenticated account.
 *
 * Response body:
 *   {
 *     plan_tier: 'free' | 'starter' | 'growth' | 'enterprise',
 *     stripe_customer_id: string | null,
 *     subscription_status: 'active' | 'past_due' | 'canceled' | 'trialing' | 'none',
 *     grace_period: {
 *       active: boolean,
 *       ends_at: string | null,   // ISO 8601 timestamp or null
 *       days_remaining: number | null
 *     },
 *     payment_failed_at: string | null  // ISO 8601 timestamp or null
 *   }
 *
 * The `subscription_status` field is fetched live from Stripe when a
 * `stripe_customer_id` is present, so it always reflects the current state.
 * If no Stripe customer exists, `subscription_status` is `'none'`.
 *
 * Responses:
 *   200 — Billing status object.
 *   401 — Not authenticated.
 *   500 — Database or Stripe error.
 *
 * Requirements: 21.5, 21.6
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetches the most recent active (or past_due / trialing) subscription for a
 * Stripe customer and returns its status string.
 *
 * Returns `'none'` if the customer has no subscriptions.
 */
async function fetchSubscriptionStatus(
  customerId: string,
): Promise<"active" | "past_due" | "canceled" | "trialing" | "none"> {
  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      limit: 1,
      // Fetch the most recent subscription regardless of status
      status: "all",
    });

    const sub = subscriptions.data[0];
    if (!sub) return "none";

    // Map Stripe statuses to our simplified set
    switch (sub.status) {
      case "active":
        return "active";
      case "past_due":
        return "past_due";
      case "canceled":
        return "canceled";
      case "trialing":
        return "trialing";
      default:
        // incomplete, incomplete_expired, unpaid → treat as past_due for UI purposes
        return "past_due";
    }
  } catch (err) {
    console.warn(
      `[billing/status] Could not fetch subscriptions for customer ${customerId}:`,
      err,
    );
    return "none";
  }
}

/**
 * Calculates the number of whole days remaining until a given date.
 * Returns `null` if the date is in the past or not provided.
 */
function daysRemaining(endsAt: Date | null): number | null {
  if (!endsAt) return null;
  const now = Date.now();
  const diff = endsAt.getTime() - now;
  if (diff <= 0) return null;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

// ── Route handler ─────────────────────────────────────────────────────────────

/**
 * GET /api/billing/status
 *
 * Requirements: 21.5, 21.6
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // ── 1. Authenticate ───────────────────────────────────────────────────────
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  try {
    // ── 2. Load account record ────────────────────────────────────────────
    const [account] = await db
      .select({
        id: accounts.id,
        planTier: accounts.planTier,
        stripeCustomerId: accounts.stripeCustomerId,
        gracePeriodEndsAt: accounts.gracePeriodEndsAt,
        paymentFailedAt: accounts.paymentFailedAt,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // ── 3. Fetch live subscription status from Stripe ─────────────────────
    const subscriptionStatus = account.stripeCustomerId
      ? await fetchSubscriptionStatus(account.stripeCustomerId)
      : "none";

    // ── 4. Compute grace period info ──────────────────────────────────────
    const gracePeriodEndsAt = account.gracePeriodEndsAt;
    const gracePeriodActive =
      gracePeriodEndsAt !== null && gracePeriodEndsAt > new Date();

    const gracePeriod = {
      active: gracePeriodActive,
      ends_at: gracePeriodEndsAt ? gracePeriodEndsAt.toISOString() : null,
      days_remaining: gracePeriodActive ? daysRemaining(gracePeriodEndsAt) : null,
    };

    // ── 5. Build and return response ──────────────────────────────────────
    return NextResponse.json({
      plan_tier: account.planTier,
      stripe_customer_id: account.stripeCustomerId ?? null,
      subscription_status: subscriptionStatus,
      grace_period: gracePeriod,
      payment_failed_at: account.paymentFailedAt
        ? account.paymentFailedAt.toISOString()
        : null,
    });
  } catch (err) {
    console.error("[billing/status] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
