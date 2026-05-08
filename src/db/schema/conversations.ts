import { pgTable, uuid, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { campaigns } from "./campaigns";
import { contacts } from "./contacts";
import { projects } from "./projects";

/**
 * conversations — one record per contact per campaign delivery.
 * Tracks the lifecycle of a single AI-driven conversation across any channel.
 */
export const conversations = pgTable("conversations", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),
  /** Denormalized for RLS policy efficiency */
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** email | sms | voice | widget */
  channel: text("channel").notNull(),
  /** pending | in_progress | completed | opted_out | failed */
  status: text("status").notNull().default("pending"),
  turnCount: integer("turn_count").notNull().default(0),
  /** Vapi call ID, Twilio SID, or SendGrid message ID */
  externalId: text("external_id"),
  /** Arbitrary channel-specific metadata (e.g. widget message history) */
  metadata: jsonb("metadata").default(sql`'{}'`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
