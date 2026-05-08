/**
 * cluster-signals.ts
 *
 * BullMQ worker that groups embedded signals into semantic theme clusters
 * using pgvector cosine distance.
 *
 * Algorithm (greedy agglomerative clustering):
 * 1. Load all embedded, non-excluded signals for the project that are not yet
 *    assigned to a cluster.
 * 2. For each unassigned signal, find all other unassigned signals within
 *    cosine distance ≤ 0.20 (cosine similarity ≥ 0.80).
 * 3. Assign the group to an existing cluster if one of the signals already
 *    belongs to one, or create a new cluster.
 * 4. Update signal_cluster_memberships and theme_clusters.signal_count.
 * 5. When a cluster reaches ≥ 5 signals and has no LLM-generated name,
 *    enqueue a name-cluster job.
 *
 * Requirements: 7.2, 7.4
 */

import { Worker, type Job } from "bullmq";
import { eq, and, isNull, sql, inArray, notInArray } from "drizzle-orm";
import { db } from "@/db/client";
import { signals } from "@/db/schema/signals";
import { themeClusters, signalClusterMemberships } from "@/db/schema/theme-clusters";
import { projects } from "@/db/schema/projects";
import {
  redisConnection,
  nameClusterQueue,
  notificationQueue,
  type ClusterSignalsJobData,
  type NameClusterJobData,
} from "@/lib/queues";

// ─── Clustering constants ─────────────────────────────────────────────────────

/** Cosine distance threshold: signals within this distance are considered similar. */
const COSINE_DISTANCE_THRESHOLD = 0.20;

/** Minimum signals in a cluster before requesting an LLM-generated name. */
const MIN_SIGNALS_FOR_NAMING = 5;

/** Signal count threshold that triggers a cluster-alert notification. */
const CLUSTER_ALERT_THRESHOLD = 10;

/** Maximum age (in milliseconds) for a cluster to be considered "new" for alert purposes. */
const CLUSTER_NEW_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmbeddedSignal {
  id: string;
  embedding: number[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute cosine distance between two vectors.
 * cosine_distance = 1 - cosine_similarity
 * cosine_similarity = dot(a, b) / (|a| * |b|)
 */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1; // treat zero vectors as maximally distant

  return 1 - dot / denom;
}

/**
 * Find all signals within cosine distance threshold of the given signal,
 * from the provided candidate pool.
 */
function findNeighbors(
  signal: EmbeddedSignal,
  candidates: EmbeddedSignal[],
  threshold: number,
): EmbeddedSignal[] {
  return candidates.filter(
    (candidate) =>
      candidate.id !== signal.id &&
      cosineDistance(signal.embedding, candidate.embedding) <= threshold,
  );
}

// ─── Worker ───────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `cluster-signals` jobs.
 *
 * Requirements: 7.2, 7.4
 */
export const clusterSignalsWorker = new Worker<ClusterSignalsJobData>(
  "cluster-signals",
  async (job: Job<ClusterSignalsJobData>) => {
    const { projectId } = job.data;

    console.log(`[cluster-signals] Processing job ${job.id} for project ${projectId}`);

    // ── 1. Load all embedded signals for the project ─────────────────────────
    const allEmbeddedSignals = await db
      .select({
        id: signals.id,
        embedding: signals.embedding,
      })
      .from(signals)
      .where(
        and(
          eq(signals.projectId, projectId),
          eq(signals.status, "embedded"),
        ),
      );

    if (allEmbeddedSignals.length === 0) {
      console.log(`[cluster-signals] No embedded signals found for project ${projectId}`);
      return { projectId, clustersCreated: 0, signalsAssigned: 0 };
    }

    // Filter out signals with null embeddings (shouldn't happen, but be safe)
    const validSignals = allEmbeddedSignals.filter(
      (s): s is EmbeddedSignal => s.embedding !== null && s.embedding.length > 0,
    );

    // ── 2. Load existing cluster memberships ─────────────────────────────────
    const signalIds = validSignals.map((s) => s.id);

    const existingMemberships = signalIds.length > 0
      ? await db
          .select({
            signalId: signalClusterMemberships.signalId,
            clusterId: signalClusterMemberships.clusterId,
          })
          .from(signalClusterMemberships)
          .where(inArray(signalClusterMemberships.signalId, signalIds))
      : [];

    const assignedSignalIds = new Set(existingMemberships.map((m) => m.signalId));

    // ── 3. Find unassigned signals ────────────────────────────────────────────
    const unassignedSignals = validSignals.filter((s) => !assignedSignalIds.has(s.id));

    if (unassignedSignals.length === 0) {
      console.log(
        `[cluster-signals] All ${validSignals.length} signals already assigned for project ${projectId}`,
      );
      return { projectId, clustersCreated: 0, signalsAssigned: 0 };
    }

    console.log(
      `[cluster-signals] Processing ${unassignedSignals.length} unassigned signals ` +
        `(${validSignals.length} total embedded) for project ${projectId}`,
    );

    // ── 4. Greedy agglomerative clustering ────────────────────────────────────
    const processed = new Set<string>();
    let clustersCreated = 0;
    let signalsAssigned = 0;

    // Track which clusters need their signal_count updated
    const clusterSignalCountUpdates = new Map<string, number>();

    for (const signal of unassignedSignals) {
      if (processed.has(signal.id)) continue;

      // Find all unassigned, unprocessed neighbors within the distance threshold
      const neighbors = findNeighbors(
        signal,
        unassignedSignals.filter((s) => !processed.has(s.id)),
        COSINE_DISTANCE_THRESHOLD,
      );

      // The group is this signal + its neighbors
      const group = [signal, ...neighbors];

      // Mark all as processed
      for (const s of group) {
        processed.add(s.id);
      }

      // Check if any signal in the group is already near an existing cluster
      // by looking at all embedded signals (including already-assigned ones)
      // that are within threshold of any signal in the group.
      let targetClusterId: string | null = null;

      for (const groupSignal of group) {
        for (const membership of existingMemberships) {
          // Find the assigned signal's embedding
          const assignedSignal = validSignals.find((s) => s.id === membership.signalId);
          if (!assignedSignal) continue;

          const dist = cosineDistance(groupSignal.embedding, assignedSignal.embedding);
          if (dist <= COSINE_DISTANCE_THRESHOLD) {
            targetClusterId = membership.clusterId;
            break;
          }
        }
        if (targetClusterId) break;
      }

      // Create a new cluster if no existing cluster was found
      if (!targetClusterId) {
        const [newCluster] = await db
          .insert(themeClusters)
          .values({
            projectId,
            signalCount: 0,
          })
          .returning({ id: themeClusters.id });

        if (!newCluster) {
          console.error(`[cluster-signals] Failed to create cluster for project ${projectId}`);
          continue;
        }

        targetClusterId = newCluster.id;
        clustersCreated++;
        console.log(
          `[cluster-signals] Created new cluster ${targetClusterId} for project ${projectId}`,
        );
      }

      // Insert memberships for all signals in the group
      if (group.length > 0) {
        const membershipRows = group.map((s) => ({
          signalId: s.id,
          clusterId: targetClusterId!,
        }));

        await db
          .insert(signalClusterMemberships)
          .values(membershipRows)
          .onConflictDoNothing();

        signalsAssigned += group.length;

        // Track count update for this cluster
        const current = clusterSignalCountUpdates.get(targetClusterId) ?? 0;
        clusterSignalCountUpdates.set(targetClusterId, current + group.length);

        // Also add to existingMemberships so subsequent iterations can find this cluster
        for (const s of group) {
          existingMemberships.push({ signalId: s.id, clusterId: targetClusterId });
          assignedSignalIds.add(s.id);
        }
      }
    }

    // ── 5. Update signal_count for all affected clusters ──────────────────────
    // Fetch current signal counts before updating so we can detect threshold crossings.
    const affectedClusterIds = Array.from(clusterSignalCountUpdates.keys());

    const previousClusterStates =
      affectedClusterIds.length > 0
        ? await db
            .select({
              id: themeClusters.id,
              signalCount: themeClusters.signalCount,
              createdAt: themeClusters.createdAt,
            })
            .from(themeClusters)
            .where(inArray(themeClusters.id, affectedClusterIds))
        : [];

    const previousCountById = new Map(
      previousClusterStates.map((c) => [c.id, { signalCount: c.signalCount, createdAt: c.createdAt }]),
    );

    for (const [clusterId, addedCount] of Array.from(clusterSignalCountUpdates.entries())) {
      await db
        .update(themeClusters)
        .set({
          signalCount: sql`${themeClusters.signalCount} + ${addedCount}`,
          updatedAt: new Date(),
        })
        .where(eq(themeClusters.id, clusterId));
    }

    // ── 6. Enqueue name-cluster jobs for clusters that qualify ────────────────
    // A cluster qualifies if it has ≥ 5 signals and no LLM-generated name yet.
    // Note: affectedClusterIds is already defined above (before the signal_count update).

    if (affectedClusterIds.length > 0) {
      const clustersNeedingNames = await db
        .select({
          id: themeClusters.id,
          signalCount: themeClusters.signalCount,
          name: themeClusters.name,
        })
        .from(themeClusters)
        .where(
          and(
            inArray(themeClusters.id, affectedClusterIds),
            isNull(themeClusters.name),
          ),
        );

      for (const cluster of clustersNeedingNames) {
        if (cluster.signalCount >= MIN_SIGNALS_FOR_NAMING) {
          await nameClusterQueue.add(
            "name-cluster",
            { clusterId: cluster.id, projectId } satisfies NameClusterJobData,
            {
              // Deduplicate: only one pending name job per cluster
              jobId: `name-cluster:${cluster.id}`,
            },
          );

          console.log(
            `[cluster-signals] Enqueued name-cluster job for cluster ${cluster.id} ` +
              `(${cluster.signalCount} signals)`,
          );
        }
      }
    }

    // ── 7. Enqueue cluster-alert notifications for clusters crossing ≥10 threshold ──
    // Requirements: 16.5, 19.2
    // Fire when:
    //   - The cluster was created within the past 48 hours (it's a "new" cluster)
    //   - The signal_count just crossed the ≥10 threshold (was < 10, now ≥ 10)
    if (affectedClusterIds.length > 0) {
      const now = Date.now();
      const clusterAlertCandidates: Array<{ id: string; newCount: number }> = [];

      for (const [clusterId, addedCount] of Array.from(clusterSignalCountUpdates.entries())) {
        const prev = previousCountById.get(clusterId);
        if (!prev) continue;

        const previousCount = prev.signalCount;
        const newCount = previousCount + addedCount;

        // Threshold crossing: was below 10, now at or above 10
        const crossedThreshold = previousCount < CLUSTER_ALERT_THRESHOLD && newCount >= CLUSTER_ALERT_THRESHOLD;
        if (!crossedThreshold) continue;

        // Cluster must be "new" — created within the past 48 hours
        const clusterAgeMs = now - new Date(prev.createdAt).getTime();
        const isNewCluster = clusterAgeMs <= CLUSTER_NEW_WINDOW_MS;
        if (!isNewCluster) continue;

        clusterAlertCandidates.push({ id: clusterId, newCount });
      }

      if (clusterAlertCandidates.length > 0) {
        // Fetch accountId for the project (needed for the notification job)
        const projectRows = await db
          .select({ accountId: projects.accountId })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);

        const accountId = projectRows.length > 0 ? projectRows[0].accountId : null;

        if (accountId) {
          for (const candidate of clusterAlertCandidates) {
            await notificationQueue.add(
              "cluster-alert",
              {
                type: "cluster-alert",
                accountId,
                projectId,
                metadata: {
                  clusterId: candidate.id,
                  signalCount: candidate.newCount,
                },
              },
              {
                // Deduplicate: only one alert per cluster crossing the threshold
                jobId: `cluster-alert:${candidate.id}`,
              },
            );

            console.log(
              `[cluster-signals] Enqueued cluster-alert notification for cluster ${candidate.id} ` +
                `(${candidate.newCount} signals, project ${projectId})`,
            );
          }
        } else {
          console.warn(
            `[cluster-signals] Could not find accountId for project ${projectId}; skipping cluster-alert`,
          );
        }
      }
    }

    console.log(
      `[cluster-signals] Completed for project ${projectId}: ` +
        `${clustersCreated} clusters created, ${signalsAssigned} signals assigned`,
    );

    return { projectId, clustersCreated, signalsAssigned };
  },
  {
    connection: redisConnection,
    concurrency: 2,
  },
);

clusterSignalsWorker.on("completed", (job) => {
  console.log(`[cluster-signals] Job ${job.id} completed successfully`);
});

clusterSignalsWorker.on("failed", (job, error) => {
  console.error(
    `[cluster-signals] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

clusterSignalsWorker.on("error", (error) => {
  console.error(`[cluster-signals] Worker error: ${error.message}`);
});
