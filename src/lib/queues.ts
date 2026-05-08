import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "@/lib/env";

/**
 * Job data shape for the `generate-keywords` job.
 * The worker uses the ICP description and problem statement to generate
 * scraping keywords and subreddit candidates via OpenAI, then writes
 * the results back to the project record.
 */
export interface GenerateKeywordsJobData {
  projectId: string;
  icpDescription: string;
  problemStatement: string;
  competitorNames: string[];
}

/**
 * Job data shape for scraper jobs.
 * Each scraper job is keyed by projectId so it can be paused/removed per project.
 */
export interface ScraperJobData {
  projectId: string;
}

/**
 * Job data shape for the `embed-signal` job.
 * The embedding worker uses the signalId to load the signal text and generate
 * a vector embedding via OpenAI text-embedding-3-small.
 */
export interface EmbedSignalJobData {
  signalId: string;
  projectId: string;
}

/**
 * Shared Redis connection for BullMQ.
 * Using `maxRetriesPerRequest: null` is required by BullMQ for blocking commands.
 */
export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

/**
 * Queue for keyword and subreddit generation jobs.
 * Consumed by the `generate-keywords` worker (src/workers/generate-keywords.ts).
 */
export const generateKeywordsQueue = new Queue<GenerateKeywordsJobData>(
  "generate-keywords",
  { connection: redisConnection },
);

/**
 * Scraper queues — one per source platform.
 * Each queue runs repeatable jobs keyed by projectId.
 * These queues are defined here so they can be paused/resumed during
 * project archive/restore operations (Requirement 1.6).
 *
 * Workers for these queues are implemented in later tasks (5.x, 6.x).
 */
export const redditScraperQueue = new Queue<ScraperJobData>("reddit-scraper", {
  connection: redisConnection,
});

export const twitterScraperQueue = new Queue<ScraperJobData>(
  "twitter-scraper",
  { connection: redisConnection },
);

export const hnScraperQueue = new Queue<ScraperJobData>("hn-scraper", {
  connection: redisConnection,
});

export const linkedinScraperQueue = new Queue<ScraperJobData>(
  "linkedin-scraper",
  { connection: redisConnection },
);

export const reviewScraperQueue = new Queue<ScraperJobData>("review-scraper", {
  connection: redisConnection,
});

/**
 * Job data shape for the `cluster-signals` job.
 * The clustering worker groups all embedded signals for a project into theme clusters.
 */
export interface ClusterSignalsJobData {
  projectId: string;
}

/**
 * Job data shape for the `name-cluster` job.
 * The naming worker generates a human-readable name and summary for a cluster.
 */
export interface NameClusterJobData {
  clusterId: string;
  projectId: string;
}

/**
 * Queue for signal embedding jobs.
 * Consumed by the `embed-signal` worker (src/workers/embed-signal.ts).
 */
export const embedSignalQueue = new Queue<EmbedSignalJobData>("embed-signal", {
  connection: redisConnection,
});

/**
 * Queue for signal clustering jobs.
 * Consumed by the `cluster-signals` worker (src/workers/cluster-signals.ts).
 * Uses jobId deduplication to ensure only one pending cluster job per project at a time.
 */
export const clusterSignalsQueue = new Queue<ClusterSignalsJobData>("cluster-signals", {
  connection: redisConnection,
});

/**
 * Queue for cluster naming jobs.
 * Consumed by the `name-cluster` worker (src/workers/name-cluster.ts).
 */
export const nameClusterQueue = new Queue<NameClusterJobData>("name-cluster", {
  connection: redisConnection,
});

/**
 * All scraper queues collected for bulk operations (pause/resume on archive/restore).
 */
export const allScraperQueues = [
  redditScraperQueue,
  twitterScraperQueue,
  hnScraperQueue,
  linkedinScraperQueue,
  reviewScraperQueue,
] as const;

// ── Campaign delivery queues ─────────────────────────────────────────────────

/**
 * Job data shape for the `deliver-campaign` job.
 * The worker loads target contacts, checks opt-out status, and enqueues
 * channel-specific send-conversation jobs.
 */
export interface DeliverCampaignJobData {
  campaignId: string;
  projectId: string;
  accountId: string;
}

/**
 * Job data shape for channel-specific send-conversation jobs.
 */
export interface SendConversationJobData {
  conversationId: string;
  campaignId: string;
  contactId: string;
  projectId: string;
  channel: string;
}

/**
 * Job data shape for `pmf-alert` notification jobs.
 * Sent when the PMF score changes by ≥ 5 points within a 24-hour period.
 * Requirements: 15.5, 19.1
 */
export interface PmfAlertJobData {
  type: "pmf-alert";
  accountId: string;
  projectId: string;
  /** The newly calculated PMF score */
  newScore: number;
  /** The PMF score from ~24 hours ago */
  previousScore: number;
  /** Signed difference: newScore - previousScore */
  change: number;
}

/**
 * Job data shape for notification jobs.
 * The `pmf-alert` variant uses PmfAlertJobData for type-safe access to score fields.
 */
export type NotificationJobData =
  | PmfAlertJobData
  | {
      type: "quota-warning" | "quota-exceeded" | "cluster-alert" | "payment-failed" | "weekly-digest";
      accountId: string;
      projectId?: string;
      metadata?: Record<string, unknown>;
    };

/**
 * Queue for campaign delivery orchestration jobs.
 * Consumed by the `deliver-campaign` worker.
 */
export const deliverCampaignQueue = new Queue<DeliverCampaignJobData>(
  "deliver-campaign",
  { connection: redisConnection },
);

/**
 * Queue for outbound email conversation jobs.
 * Consumed by the `send-email` worker.
 */
export const sendEmailQueue = new Queue<SendConversationJobData>("send-email", {
  connection: redisConnection,
});

/**
 * Queue for outbound SMS conversation jobs.
 * Consumed by the `send-sms` worker.
 */
export const sendSmsQueue = new Queue<SendConversationJobData>("send-sms", {
  connection: redisConnection,
});

/**
 * Queue for outbound voice call conversation jobs.
 * Consumed by the `send-voice` worker.
 */
export const sendVoiceQueue = new Queue<SendConversationJobData>("send-voice", {
  connection: redisConnection,
});

/**
 * Queue for in-app chat widget conversation jobs.
 * Consumed by the `send-chat` worker.
 */
export const sendChatQueue = new Queue<SendConversationJobData>("send-chat", {
  connection: redisConnection,
});

/**
 * Queue for notification jobs (quota warnings, PMF alerts, etc.).
 * Consumed by the notification worker.
 */
export const notificationQueue = new Queue<NotificationJobData>("notifications", {
  connection: redisConnection,
});

// ── Transcript analysis queue ────────────────────────────────────────────────

/**
 * Job data shape for the `analyze-transcript` job.
 * The worker calls OpenAI to extract insights from a completed voice call
 * transcript and creates Active Signal records.
 */
export interface AnalyzeTranscriptJobData {
  transcriptId: string;
  conversationId: string;
  projectId: string;
}

/**
 * Queue for transcript analysis jobs.
 * Consumed by the `analyze-transcript` worker (src/workers/analyze-transcript.ts).
 * Enqueued by the Vapi webhook handler when a call ends (Requirement 12.5).
 */
export const analyzeTranscriptQueue = new Queue<AnalyzeTranscriptJobData>(
  "analyze-transcript",
  { connection: redisConnection },
);

// ── Webhook delivery queue ───────────────────────────────────────────────────

/**
 * Job data shape for the `deliver-webhook` job.
 * The worker POSTs the event payload to the registered webhook URL,
 * signs it with HMAC-SHA256, and retries on failure with exponential backoff.
 *
 * Requirements: 20.4
 */
export interface DeliverWebhookJobData {
  /** The webhook_endpoints row id */
  webhookEndpointId: string;
  /** The project this webhook belongs to */
  projectId: string;
  /** Event type: signal.created | pmf_score.changed */
  eventType: "signal.created" | "pmf_score.changed";
  /** The event payload to POST */
  payload: Record<string, unknown>;
}

/**
 * Queue for webhook delivery jobs.
 * Consumed by the `deliver-webhook` worker (src/workers/deliver-webhook.ts).
 * Enqueued when a new signal is created or the PMF score changes.
 *
 * Requirements: 20.4
 */
export const deliverWebhookQueue = new Queue<DeliverWebhookJobData>(
  "deliver-webhook",
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1_000, // 1s → 2s → 4s
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  },
);

// ── Grace period expiry queue ────────────────────────────────────────────────

/**
 * Queue for the grace period expiry check job.
 * A repeatable job is scheduled every hour by the worker process
 * (src/workers/expire-grace-period.ts).
 *
 * On each run, the worker finds accounts whose 7-day payment grace period
 * has expired and downgrades them to the free tier.
 *
 * Requirements: 21.6
 */
export const expireGracePeriodQueue = new Queue("expire-grace-period", {
  connection: redisConnection,
});

// ── Signal feed materialized view refresh queue ──────────────────────────────

/**
 * Queue for refreshing the `signal_feed_mv` materialized view.
 * A repeatable job is scheduled every 5 minutes by the worker process
 * (src/workers/refresh-signal-feed.ts).
 *
 * Requirements: 14.3, 23.2
 */
export const refreshSignalFeedQueue = new Queue("refresh-signal-feed", {
  connection: redisConnection,
});

// ── PMF score calculation queue ──────────────────────────────────────────────

/**
 * Job data shape for the `calculate-pmf-score` job.
 * The worker recalculates the PMF score for a project and stores a snapshot
 * in `pmf_score_snapshots`.
 */
export interface CalculatePmfScoreJobData {
  projectId: string;
}

/**
 * Queue for PMF score calculation jobs.
 * Consumed by the `calculate-pmf-score` worker (src/workers/calculate-pmf-score.ts).
 * Enqueued by the `analyze-transcript` worker when the campaign goal is `pmf_survey`.
 *
 * Requirements: 15.1, 15.2
 */
export const calculatePmfScoreQueue = new Queue<CalculatePmfScoreJobData>(
  "calculate-pmf-score",
  { connection: redisConnection },
);

// ── Persona generation queue ─────────────────────────────────────────────────

/**
 * Job data shape for the `generate-personas` job.
 * The worker clusters contacts by their signal patterns and generates
 * persona names and descriptions via OpenAI.
 *
 * Requirements: 17.1, 17.2
 */
export interface GeneratePersonasJobData {
  projectId: string;
}

/**
 * Queue for persona generation jobs.
 * Consumed by the `generate-personas` worker (src/workers/generate-personas.ts).
 * Results are cached in Redis under `personas:{projectId}` with a 24-hour TTL.
 *
 * Requirements: 17.1, 17.2, 17.4
 */
export const generatePersonasQueue = new Queue<GeneratePersonasJobData>(
  "generate-personas",
  { connection: redisConnection },
);

// ── Persona refresh scheduler queue ─────────────────────────────────────────

/**
 * Queue for the persona refresh trigger job.
 * No job data is needed — the worker loads all active projects itself.
 * A repeatable job is scheduled every 24 hours by the worker process
 * (src/workers/refresh-personas.ts).
 *
 * Requirements: 17.4
 */
export const refreshPersonasQueue = new Queue("refresh-personas", {
  connection: redisConnection,
});

// ── Account deletion processing queue ────────────────────────────────────────

/**
 * Queue for the account deletion processing job.
 * A repeatable job is scheduled daily by the worker process
 * (src/workers/process-account-deletions.ts).
 *
 * On each run, the worker finds accounts whose 30-day deletion window has
 * passed and permanently deletes them. ON DELETE CASCADE in the database
 * schema handles removal of all related data (projects, signals, contacts,
 * campaigns, etc.).
 *
 * Requirements: 22.4
 */
export const processAccountDeletionsQueue = new Queue(
  "process-account-deletions",
  { connection: redisConnection },
);

// ── Weekly digest scheduler queue ────────────────────────────────────────────

/**
 * Queue for the weekly digest scheduler trigger job.
 * No job data is needed — the worker loads all accounts and checks timezones.
 * A repeatable job is scheduled every minute by the worker process
 * (src/workers/weekly-digest-scheduler.ts).
 *
 * The worker checks each account's configured timezone and enqueues
 * `weekly-digest` notification jobs for accounts where it is currently
 * Monday 09:00 local time.
 *
 * Requirements: 19.3, 19.5
 */
export const weeklyDigestSchedulerQueue = new Queue("weekly-digest-scheduler", {
  connection: redisConnection,
});
