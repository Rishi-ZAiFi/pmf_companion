import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects";

/**
 * Custom Drizzle type for pgvector's vector(1536) column.
 * Drizzle does not ship a first-party pgvector type yet, so we define one
 * using customType. The value is stored as a PostgreSQL vector literal and
 * returned as a number[] in TypeScript.
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    // PostgreSQL returns vectors as '[0.1,0.2,...]'
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(Number);
  },
});

/**
 * signals — the core intelligence unit.
 * Stores both active signals (from conversations) and passive signals (from scrapers).
 *
 * Key constraints:
 *  - UNIQUE (project_id, source_url) — deduplication at the DB level
 *  - IVFFlat index on embedding — enables fast ANN search via pgvector
 *  - RLS policy enforces tenant isolation (see migration 0001)
 */
export const signals = pgTable(
  "signals",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** reddit | twitter | hn | linkedin | review | email | sms | voice | widget */
    source: text("source").notNull(),
    /** pain_point | feature_request | competitor_mention | market_trend | positive_sentiment | negative_sentiment */
    signalType: text("signal_type").notNull(),
    /** passive | active */
    signalKind: text("signal_kind").notNull().default("passive"),
    content: text("content").notNull(),
    sourceUrl: text("source_url"),
    author: text("author"),
    /** 0–100 relevance score based on semantic similarity to ICP */
    relevanceScore: integer("relevance_score").notNull().default(0),
    /** positive | neutral | negative */
    sentiment: text("sentiment"),
    /** 1–10, null for passive signals */
    painIntensity: integer("pain_intensity"),
    isOpportunity: boolean("is_opportunity").notNull().default(false),
    isBookmarked: boolean("is_bookmarked").notNull().default(false),
    customLabel: text("custom_label"),
    isDismissed: boolean("is_dismissed").notNull().default(false),
    /** 1536-dimensional embedding vector from text-embedding-3-small */
    embedding: vector("embedding"),
    /** pending_embedding | embedded | excluded */
    status: text("status").notNull().default("pending_embedding"),
    /** Arbitrary source-specific metadata (e.g. Reddit post score, tweet likes) */
    metadata: jsonb("metadata").default(sql`'{}'`),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Deduplication constraint — scrapers use INSERT ... ON CONFLICT DO NOTHING
    projectSourceUrlUnique: unique("signals_project_source_url_unique").on(
      table.projectId,
      table.sourceUrl,
    ),
    // B-tree index for fast project-scoped queries
    projectIdIdx: index("signals_project_id_idx").on(table.projectId),
    // Composite index for feed queries ordered by recency
    ingestedAtIdx: index("signals_ingested_at_idx").on(table.projectId, table.ingestedAt),
    // NOTE: The IVFFlat index on embedding is created in the SQL migration
    // (0001_initial_schema.sql) because Drizzle does not yet support USING ivfflat syntax.
  }),
);

export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
