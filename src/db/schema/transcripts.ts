import { pgTable, uuid, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { conversations } from "./conversations";
import { projects } from "./projects";

/**
 * transcripts — full text record of a completed conversation.
 * Populated after a voice call ends, an email thread closes, or an SMS/chat session ends.
 * The analyze-transcript worker fills in the analysis fields.
 */
export const transcripts = pgTable("transcripts", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  /** Denormalized for RLS policy efficiency */
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  /** positive | neutral | negative — filled by analyze-transcript worker */
  sentiment: text("sentiment"),
  /** 1–10 — filled by analyze-transcript worker */
  painIntensity: integer("pain_intensity"),
  /** Whether the contact showed willingness-to-pay signals */
  wtpSignal: boolean("wtp_signal"),
  /** Competitor names mentioned in the conversation */
  competitorMentions: text("competitor_mentions")
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** Top 3 verbatim quotes extracted by the LLM */
  topQuotes: text("top_quotes")
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** S3 URL for voice call recordings */
  recordingUrl: text("recording_url"),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Transcript = typeof transcripts.$inferSelect;
export type NewTranscript = typeof transcripts.$inferInsert;
