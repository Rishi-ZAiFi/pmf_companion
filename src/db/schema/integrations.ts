import { pgTable, uuid, text, jsonb, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts";

/**
 * integrations — third-party service connections per account.
 * access_token is stored encrypted at rest (AES-256 via application-layer encryption).
 */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** slack | hubspot | intercom | notion | segment */
    provider: text("provider").notNull(),
    /** Encrypted OAuth access token */
    accessToken: text("access_token").notNull(),
    /** Provider-specific configuration (channel IDs, workspace IDs, etc.) */
    config: jsonb("config").default(sql`'{}'`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    accountProviderUnique: unique("integrations_account_provider_unique").on(
      table.accountId,
      table.provider,
    ),
  }),
);

export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
