import { pgTable, uuid, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects";

/**
 * campaigns — targeted outreach efforts.
 * One campaign can span multiple channels and target a filtered contact segment.
 */
export const campaigns = pgTable("campaigns", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** pmf_survey | pain_point_discovery | feature_validation | churn_investigation */
  goal: text("goal").notNull(),
  /** Array of channels: email | sms | voice | widget */
  channels: text("channels").array().notNull(),
  /** Contact segment tags to target */
  segmentFilter: text("segment_filter")
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** Structured JSON script with turn-by-turn prompts */
  script: jsonb("script").notNull().default(sql`'{}'`),
  /** AI persona configuration */
  persona: jsonb("persona").notNull().default(sql`'{}'`),
  /** draft | launching | active | paused | completed | cancelled */
  status: text("status").notNull().default("draft"),
  conversationCount: integer("conversation_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
