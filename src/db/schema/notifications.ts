import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts";
import { projects } from "./projects";

/**
 * notifications — in-app notification records.
 * Delivered to the client via SSE on GET /api/notifications/stream.
 */
export const notifications = pgTable("notifications", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  /** Optional — null for account-level notifications (e.g. payment failed) */
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  /** pmf-alert | cluster-alert | quota-warning | quota-exceeded | payment-failed | weekly-digest */
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
