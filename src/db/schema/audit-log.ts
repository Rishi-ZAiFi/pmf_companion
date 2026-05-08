import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts";

/**
 * audit_log — immutable record of all data access and export events.
 * Retained for a minimum of 90 days per Requirement 22.6.
 * No RLS — the audit log is append-only and read only by admins.
 */
export const auditLog = pgTable("audit_log", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  /** The user who performed the action (may differ from accountId for team accounts) */
  actorId: uuid("actor_id"),
  /** e.g. 'signal.read', 'contact.export', 'project.delete' */
  action: text("action").notNull(),
  /** e.g. 'signal', 'contact', 'project' */
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id"),
  /** Additional context (IP address, user agent, etc.) */
  metadata: jsonb("metadata").default(sql`'{}'`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
