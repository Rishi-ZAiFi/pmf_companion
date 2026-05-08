import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects";

/**
 * webhook_endpoints — founder-registered URLs that receive event payloads.
 * Payloads are signed with HMAC-SHA256 using the per-endpoint secret.
 * Maximum 10 endpoints per project (enforced at the application layer).
 */
export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  /** HMAC-SHA256 signing secret — stored encrypted at rest */
  secret: text("secret").notNull(),
  /** Events to subscribe to: signal.created | pmf_score.changed */
  events: text("events").array().notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;
