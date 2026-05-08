-- Migration: 0006_add_billing_grace_period
-- Adds billing-related columns to the accounts table to support the
-- 7-day grace period on payment failure (Requirement 21.6).
--
-- grace_period_ends_at: set to now() + 7 days when a payment fails;
--   cleared when payment succeeds. If non-null and in the past, the
--   account should be downgraded to the free tier.
--
-- payment_failed_at: timestamp of the most recent payment failure event
--   from Stripe. Used for audit purposes and to enqueue the payment-failed
--   notification exactly once per failure event.
--
-- Requirements: 21.5, 21.6

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS grace_period_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_failed_at TIMESTAMPTZ;
