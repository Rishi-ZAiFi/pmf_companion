/**
 * calculate-pmf-score.ts
 *
 * BullMQ worker that recalculates the PMF score for a project and stores
 * a snapshot in `pmf_score_snapshots`.
 *
 * PMF Score = (count of "very_disappointed" responses / total PMF survey responses) × 100
 *
 * A "very_disappointed" response is a transcript from a PMF survey campaign
 * where `wtp_signal = true` (the LLM detected willingness-to-pay / very disappointed signal).
 *
 * The worker also calculates per-segment scores and stores them in
 * `pmf_score_snapshots.segment_scores`.
 *
 * Requirements: 15.1, 15.2
 */

import { Worker, type Job } from "bullmq";
import { eq, and, sql, lte, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { transcripts } from "@/db/schema/transcripts";
import { conversations } from "@/db/schema/conversations";
import { campaigns } from "@/db/schema/campaigns";
import { contacts } from "@/db/schema/contacts";
import { pmfScoreSnapshots } from "@/db/schema/pmf-score-snapshots";
import { projects } from "@/db/schema/projects";
import {
  redisConnection,
  notificationQueue,
  type CalculatePmfScoreJobData,
} from "@/lib/queues";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch all analyzed PMF survey transcripts for a project.
 * A PMF survey transcript is one whose conversation belongs to a campaign
 * with goal = 'pmf_survey' and has been analyzed (analyzedAt IS NOT NULL).
 *
 * Returns an array of objects with:
 *   - transcriptId
 *   - wtpSignal: whether the contact would be "very disappointed"
 *   - segmentTags: the contact's segment tags (for per-segment breakdown)
 */
async function fetchPmfTranscripts(projectId: string): Promise<
  Array<{
    transcriptId: string;
    wtpSignal: boolean;
    segmentTags: string[];
  }>
> {
  // Join transcripts → conversations → campaigns to filter by goal = 'pmf_survey'
  // Also join contacts to get segment tags for per-segment breakdown.
  const rows = await db
    .select({
      transcriptId: transcripts.id,
      wtpSignal: transcripts.wtpSignal,
      segmentTags: contacts.segmentTags,
    })
    .from(transcripts)
    .innerJoin(conversations, eq(transcripts.conversationId, conversations.id))
    .innerJoin(campaigns, eq(conversations.campaignId, campaigns.id))
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(
      and(
        eq(transcripts.projectId, projectId),
        eq(campaigns.goal, "pmf_survey"),
        // Only count analyzed transcripts
        sql`${transcripts.analyzedAt} IS NOT NULL`,
      ),
    );

  return rows.map((row) => ({
    transcriptId: row.transcriptId,
    // wtp_signal = true means the contact would be "very disappointed"
    wtpSignal: row.wtpSignal ?? false,
    segmentTags: row.segmentTags ?? [],
  }));
}

/**
 * Calculate the overall PMF score and per-segment scores from a list of
 * PMF survey transcript results.
 *
 * Returns:
 *   - score: overall PMF score (0–100), or 0 if no responses
 *   - responseCount: total number of analyzed PMF survey responses
 *   - segmentScores: { [segmentTag]: score } per segment
 */
function calculateScores(
  responses: Array<{ wtpSignal: boolean; segmentTags: string[] }>,
): {
  score: number;
  responseCount: number;
  segmentScores: Record<string, number>;
} {
  const total = responses.length;

  if (total === 0) {
    return { score: 0, responseCount: 0, segmentScores: {} };
  }

  const veryDisappointed = responses.filter((r) => r.wtpSignal).length;
  const score = (veryDisappointed / total) * 100;

  // Per-segment breakdown
  const segmentMap: Record<string, { total: number; veryDisappointed: number }> = {};

  for (const response of responses) {
    for (const tag of response.segmentTags) {
      if (!segmentMap[tag]) {
        segmentMap[tag] = { total: 0, veryDisappointed: 0 };
      }
      segmentMap[tag].total += 1;
      if (response.wtpSignal) {
        segmentMap[tag].veryDisappointed += 1;
      }
    }
  }

  const segmentScores: Record<string, number> = {};
  for (const [tag, counts] of Object.entries(segmentMap)) {
    segmentScores[tag] = (counts.veryDisappointed / counts.total) * 100;
  }

  return { score, responseCount: total, segmentScores };
}

// ── Helpers (alert) ───────────────────────────────────────────────────────────

/**
 * Fetch the most recent PMF score snapshot that was recorded at or before
 * 24 hours ago for the given project.
 *
 * Returns the score as a number, or null if no such snapshot exists.
 */
async function fetchScoreFrom24HoursAgo(
  projectId: string,
): Promise<number | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // snapshot_date is a DATE column; compare against the date portion of the cutoff.
  const cutoffDate = cutoff.toISOString().split("T")[0]; // YYYY-MM-DD

  const rows = await db
    .select({ score: pmfScoreSnapshots.score })
    .from(pmfScoreSnapshots)
    .where(
      and(
        eq(pmfScoreSnapshots.projectId, projectId),
        lte(pmfScoreSnapshots.snapshotDate, cutoffDate),
      ),
    )
    .orderBy(desc(pmfScoreSnapshots.snapshotDate))
    .limit(1);

  if (rows.length === 0) return null;
  return parseFloat(rows[0].score as string);
}

/**
 * Fetch the accountId for a given project.
 */
async function fetchAccountId(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  return rows.length > 0 ? rows[0].accountId : null;
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `calculate-pmf-score` jobs.
 *
 * Requirements: 15.1, 15.2
 */
export const calculatePmfScoreWorker = new Worker<CalculatePmfScoreJobData>(
  "calculate-pmf-score",
  async (job: Job<CalculatePmfScoreJobData>) => {
    const { projectId } = job.data;

    console.log(
      `[calculate-pmf-score] Processing job ${job.id} for project ${projectId}`,
    );

    // ── 1. Fetch all analyzed PMF survey transcripts ──────────────────────────
    const pmfResponses = await fetchPmfTranscripts(projectId);

    console.log(
      `[calculate-pmf-score] Found ${pmfResponses.length} PMF survey responses for project ${projectId}`,
    );

    // ── 2. Calculate overall and per-segment scores ───────────────────────────
    const { score, responseCount, segmentScores } = calculateScores(pmfResponses);

    console.log(
      `[calculate-pmf-score] Calculated PMF score: ${score.toFixed(2)} ` +
        `(${pmfResponses.filter((r) => r.wtpSignal).length} very_disappointed / ${responseCount} total)`,
    );

    // ── 3. Store snapshot in pmf_score_snapshots ──────────────────────────────
    // Use today's date as the snapshot date.
    // The UNIQUE constraint on (project_id, snapshot_date) means we upsert:
    // if a snapshot already exists for today, update it with the latest score.
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    await db
      .insert(pmfScoreSnapshots)
      .values({
        projectId,
        score: score.toFixed(2),
        responseCount,
        segmentScores,
        snapshotDate: today,
      })
      .onConflictDoUpdate({
        target: [pmfScoreSnapshots.projectId, pmfScoreSnapshots.snapshotDate],
        set: {
          score: score.toFixed(2),
          responseCount,
          segmentScores,
        },
      });

    console.log(
      `[calculate-pmf-score] Stored PMF score snapshot for project ${projectId} on ${today}: ` +
        `score=${score.toFixed(2)}, responseCount=${responseCount}`,
    );

    // ── 4. Check for ≥5-point change in the past 24 hours ────────────────────
    // Requirements: 15.5, 19.1
    const previousScore = await fetchScoreFrom24HoursAgo(projectId);

    if (previousScore !== null) {
      const change = score - previousScore;
      const absoluteChange = Math.abs(change);

      console.log(
        `[calculate-pmf-score] 24h score comparison for project ${projectId}: ` +
          `previous=${previousScore.toFixed(2)}, new=${score.toFixed(2)}, change=${change.toFixed(2)}`,
      );

      if (absoluteChange >= 5) {
        const accountId = await fetchAccountId(projectId);

        if (accountId) {
          await notificationQueue.add("pmf-alert", {
            type: "pmf-alert",
            accountId,
            projectId,
            newScore: score,
            previousScore,
            change,
          });

          console.log(
            `[calculate-pmf-score] Enqueued pmf-alert notification for project ${projectId}: ` +
              `change=${change.toFixed(2)} points (${previousScore.toFixed(2)} → ${score.toFixed(2)})`,
          );
        } else {
          console.warn(
            `[calculate-pmf-score] Could not find accountId for project ${projectId}; skipping pmf-alert`,
          );
        }
      }
    } else {
      console.log(
        `[calculate-pmf-score] No snapshot found from 24 hours ago for project ${projectId}; skipping alert check`,
      );
    }

    return {
      projectId,
      score,
      responseCount,
      snapshotDate: today,
    };
  },
  {
    connection: redisConnection,
    concurrency: 3,
  },
);

calculatePmfScoreWorker.on("completed", (job) => {
  console.log(`[calculate-pmf-score] Job ${job.id} completed successfully`);
});

calculatePmfScoreWorker.on("failed", (job, error) => {
  console.error(
    `[calculate-pmf-score] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

calculatePmfScoreWorker.on("error", (error) => {
  console.error(`[calculate-pmf-score] Worker error: ${error.message}`);
});
