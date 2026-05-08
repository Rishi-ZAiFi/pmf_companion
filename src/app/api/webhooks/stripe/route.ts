/**
 * POST /api/webhooks/stripe
 *
 * Stripe webhook handler for subscription billing lifecycle events.
 *
 * Stripe sends signed POST requests to this endpoint when billing events occur.
 * The signature is verified using the `STRIPE_WEBHOOK_SECRET` environment variable
 * before any payload processing takes place.
 *
 * Handled events:
 *   - `invoice.payment_succeeded`      — clear grace period, update plan status
 *   - `invoice.payment_failed`         — record failure, start 7-day grace period,
 *                                        enqueue `payment-failed` notification
 *   - `customer.subscription.updated`  — update plan tier from new price/product
 *   - `customer.subscription.deleted`  — downgrade account to free tier
 *
 * Requirements: 21.5, 21.6
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { notificationQueue } from "@/lib/queues";
import { env } from "@/lib/env";

// ── Stripe client ─────────────────────────────────────────────────────────────

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// ── Plan tier mapping ─────────────────────────────────────────────────────────

/**
 * Maps Stripe price/product metadata to internal plan tier names.
 *
 * Stripe products should have a `plan_tier` metadata key set to one of:
 *   free | starter | growth | enterprise
 *
 * This function falls back to price nickname matching if metadata is absent.
 */
function resolvePlanTier(subscription: Stripe.Subscription): string {
  // Try to read plan_tier from the first subscription item's product metadata
  const item = subscription.items.data[0];
  if (!item) return "free";

  const price = item.price;

  // Check product metadata if the product is expanded
  if (typeof price.product === "object" && price.product !== null) {
    const product = price.product as Stripe.Product;
    const metaTier = product.metadata?.plan_tier;
    if (metaTier && ["free", "starter", "growth", "enterprise"].includes(metaTier)) {
      return metaTier;
    }
    // Fall back to product name matching
    const productName = product.name?.toLowerCase() ?? "";
    if (productName.includes("enterprise")) return "enterprise";
    if (productName.includes("growth")) return "growth";
    if (productName.includes("starter")) return "starter";
  }

  // Fall back to price nickname
  const nickname = price.nickname?.toLowerCase() ?? "";
  if (nickname.includes("enterprise")) return "enterprise";
  if (nickname.includes("growth")) return "growth";
  if (nickname.includes("starter")) return "starter";

  return "free";
}

// ── Event handlers ────────────────────────────────────────────────────────────

/**
 * Handle `invoice.payment_succeeded`.
 *
 * Clears any active grace period and payment failure timestamp, confirming
 * the account is in good standing.
 *
 * Requirements: 21.5
 */
async function handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  const customerId = typeof invoice.customer === "string"
    ? invoice.customer
    : invoice.customer?.id;

  if (!customerId) {
    console.warn("[stripe-webhook] payment_succeeded: missing customer ID");
    return;
  }

  const [account] = await db
    .select({ id: accounts.id, planTier: accounts.planTier })
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) {
    console.warn(`[stripe-webhook] payment_succeeded: no account found for customer ${customerId}`);
    return;
  }

  await db
    .update(accounts)
    .set({
      gracePeriodEndsAt: null,
      paymentFailedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, account.id));

  console.log(
    `[stripe-webhook] payment_succeeded: cleared grace period for account ${account.id} (customer ${customerId})`,
  );
}

/**
 * Handle `invoice.payment_failed`.
 *
 * Records the failure timestamp, starts a 7-day grace period, and enqueues
 * a `payment-failed` notification so the founder is alerted via email.
 *
 * Requirements: 21.6
 */
async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = typeof invoice.customer === "string"
    ? invoice.customer
    : invoice.customer?.id;

  if (!customerId) {
    console.warn("[stripe-webhook] payment_failed: missing customer ID");
    return;
  }

  const [account] = await db
    .select({ id: accounts.id, planTier: accounts.planTier, gracePeriodEndsAt: accounts.gracePeriodEndsAt })
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) {
    console.warn(`[stripe-webhook] payment_failed: no account found for customer ${customerId}`);
    return;
  }

  const now = new Date();
  const gracePeriodEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // now + 7 days

  await db
    .update(accounts)
    .set({
      paymentFailedAt: now,
      gracePeriodEndsAt,
      updatedAt: now,
    })
    .where(eq(accounts.id, account.id));

  console.log(
    `[stripe-webhook] payment_failed: grace period set for account ${account.id} until ${gracePeriodEndsAt.toISOString()} (customer ${customerId})`,
  );

  // Enqueue payment-failed notification (email to founder)
  await notificationQueue.add(
    "payment-failed",
    {
      type: "payment-failed",
      accountId: account.id,
      metadata: {
        gracePeriodEndsAt: gracePeriodEndsAt.toISOString(),
        invoiceId: invoice.id,
        amountDue: invoice.amount_due,
        currency: invoice.currency,
      },
    },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      // Deduplicate: one notification per invoice failure
      jobId: `payment-failed:${invoice.id}`,
    },
  );

  console.log(
    `[stripe-webhook] payment_failed: enqueued payment-failed notification for account ${account.id}`,
  );
}

/**
 * Handle `customer.subscription.updated`.
 *
 * Updates the account's plan tier based on the new subscription price/product.
 * This covers plan upgrades, downgrades, and reactivations.
 *
 * Requirements: 21.5
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const customerId = typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer?.id;

  if (!customerId) {
    console.warn("[stripe-webhook] subscription_updated: missing customer ID");
    return;
  }

  const [account] = await db
    .select({ id: accounts.id, planTier: accounts.planTier })
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) {
    console.warn(`[stripe-webhook] subscription_updated: no account found for customer ${customerId}`);
    return;
  }

  // Fetch the full subscription with expanded product to resolve the plan tier
  let expandedSubscription = subscription;
  try {
    expandedSubscription = await stripe.subscriptions.retrieve(subscription.id, {
      expand: ["items.data.price.product"],
    });
  } catch (err) {
    console.warn(
      `[stripe-webhook] subscription_updated: could not expand subscription ${subscription.id}, using event data:`,
      err,
    );
  }

  const newPlanTier = resolvePlanTier(expandedSubscription);

  await db
    .update(accounts)
    .set({
      planTier: newPlanTier,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, account.id));

  console.log(
    `[stripe-webhook] subscription_updated: account ${account.id} plan tier updated to '${newPlanTier}' (was '${account.planTier}')`,
  );
}

/**
 * Handle `customer.subscription.deleted`.
 *
 * Downgrades the account to the free tier when a subscription is cancelled
 * or expires. Also clears any active grace period since the subscription
 * is now definitively ended.
 *
 * Requirements: 21.5, 21.6
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const customerId = typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer?.id;

  if (!customerId) {
    console.warn("[stripe-webhook] subscription_deleted: missing customer ID");
    return;
  }

  const [account] = await db
    .select({ id: accounts.id, planTier: accounts.planTier })
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) {
    console.warn(`[stripe-webhook] subscription_deleted: no account found for customer ${customerId}`);
    return;
  }

  await db
    .update(accounts)
    .set({
      planTier: "free",
      gracePeriodEndsAt: null,
      paymentFailedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, account.id));

  console.log(
    `[stripe-webhook] subscription_deleted: account ${account.id} downgraded to free tier (was '${account.planTier}')`,
  );
}

// ── Webhook Handler ───────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/stripe
 *
 * Verifies the Stripe webhook signature and dispatches to the appropriate
 * event handler.
 *
 * IMPORTANT: Next.js must NOT parse the body before we read it as raw bytes
 * for signature verification. We use `request.text()` to get the raw body.
 *
 * Requirements: 21.5, 21.6
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Read raw body for signature verification ───────────────────────────
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    console.warn("[stripe-webhook] Missing stripe-signature header");
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  // ── 2. Verify webhook signature ───────────────────────────────────────────
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.warn(`[stripe-webhook] Signature verification failed: ${message}`);
    return NextResponse.json({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
  }

  console.log(`[stripe-webhook] Received event: ${event.type} (id: ${event.id})`);

  // ── 3. Dispatch to event handler ──────────────────────────────────────────
  try {
    switch (event.type) {
      case "invoice.payment_succeeded":
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;

      case "invoice.payment_failed":
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      default:
        // Acknowledge but ignore unhandled event types
        console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
        break;
    }

    return NextResponse.json({ received: true, event: event.type });
  } catch (error) {
    console.error(`[stripe-webhook] Error handling event ${event.type}:`, error);
    // Return 500 so Stripe retries the delivery
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
