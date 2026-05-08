import { pgTable, uuid, numeric, integer, jsonb, date, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects";

/**
 * pmf_score_snapshots — daily PMF score records for trend charting.
 * One row per project per day; UNIQUE constraint prevents duplicate snapshots.
 */
export const pmfScoreSnapshots = pgTable(
  "pmf_score_snapshots",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** PMF score 0.00–100.00 */
    score: numeric("score", { precision: 5, scale: 2 }).notNull(),
    responseCount: integer("response_count").notNull(),
    /** Per-segment scores: { "segment_tag": score } */
    segmentScores: jsonb("segment_scores").default(sql`'{}'`),
    snapshotDate: date("snapshot_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    projectDateUnique: unique("pmf_score_snapshots_project_date_unique").on(
      table.projectId,
      table.snapshotDate,
    ),
  }),
);

export type PmfScoreSnapshot = typeof pmfScoreSnapshots.$inferSelect;
export type NewPmfScoreSnapshot = typeof pmfScoreSnapshots.$inferInsert;
