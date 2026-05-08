import { pgTable, uuid, text, integer, boolean, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects";
import { signals } from "./signals";

/**
 * theme_clusters — named groups of semantically related signals.
 * Created and updated by the cluster-signals BullMQ worker.
 */
export const themeClusters = pgTable("theme_clusters", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** LLM-generated cluster name (≤ 6 words), null until name-cluster job runs */
  name: text("name"),
  /** LLM-generated 2-sentence summary */
  summary: text("summary"),
  signalCount: integer("signal_count").notNull().default(0),
  /** growing | stable | declining — based on ingestion rate over past 7 days */
  trendDirection: text("trend_direction").notNull().default("stable"),
  isDismissed: boolean("is_dismissed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * signal_cluster_memberships — many-to-many join between signals and clusters.
 * A signal can belong to at most one cluster (enforced by application logic),
 * but the schema allows many-to-many for future flexibility.
 */
export const signalClusterMemberships = pgTable(
  "signal_cluster_memberships",
  {
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => themeClusters.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.signalId, table.clusterId] }),
  }),
);

export type ThemeCluster = typeof themeClusters.$inferSelect;
export type NewThemeCluster = typeof themeClusters.$inferInsert;
export type SignalClusterMembership = typeof signalClusterMemberships.$inferSelect;
export type NewSignalClusterMembership = typeof signalClusterMemberships.$inferInsert;
