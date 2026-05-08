import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";


/**
 * accounts — one row per founder / team.
 * Not tenant-scoped itself; all other tables reference this via projects.
 */
export const accounts = pgTable("accounts", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  name: text("name"),
  /**
   * Bcrypt hash of the account password.
   * NULL for OAuth-only accounts (e.g. Google sign-in) that have no password.
   */
  passwordHash: text("password_hash"),
  /** free | starter | growth | enterprise */
  planTier: text("plan_tier").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  timezone: text("timezone").notNull().default("UTC"),
  /**
   * Notification preferences per notification type.
   * Each key is a notification type (pmf-alert, cluster-alert, etc.)
   * and the value is a boolean: true = enabled, false = disabled.
   * Requirements: 19.4
   */
  notificationPreferences: jsonb("notification_preferences")
    .notNull()
    .default(sql`'{
      "pmf-alert": true,
      "cluster-alert": true,
      "quota-warning": true,
      "quota-exceeded": true,
      "payment-failed": true,
      "weekly-digest": true
    }'::jsonb`),
  /**
   * Set to `now() + 7 days` when a Stripe `invoice.payment_failed` event is
   * received. Cleared (set to NULL) when payment succeeds. If non-null and in
   * the past, the account is eligible for downgrade to the free tier.
   * Requirements: 21.6
   */
  gracePeriodEndsAt: timestamp("grace_period_ends_at", { withTimezone: true }),
  /**
   * Timestamp of the most recent Stripe payment failure event.
   * Used for audit purposes and to avoid duplicate payment-failed notifications.
   * Requirements: 21.6
   */
  paymentFailedAt: timestamp("payment_failed_at", { withTimezone: true }),
  /**
   * When set, the account is scheduled for permanent deletion at this timestamp
   * (30 days after the deletion request). NULL means no deletion is pending.
   * A daily BullMQ worker (`process-account-deletions`) checks for accounts
   * past this timestamp and permanently deletes them.
   * Requirements: 22.4
   */
  deletionScheduledAt: timestamp("deletion_scheduled_at", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
