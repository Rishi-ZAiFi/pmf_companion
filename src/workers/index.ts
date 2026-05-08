/**
 * Worker process entry point.
 *
 * This file starts all BullMQ workers as a single long-running Node.js process.
 * Deploy this separately from the Next.js web tier (e.g., as an ECS task or Fly.io machine).
 *
 * Usage:
 *   npm run worker
 *   # or directly:
 *   tsx src/workers/index.ts
 */

import { generateKeywordsWorker } from "./generate-keywords";
import { redditScraperWorker } from "./scrapers/reddit-scraper";
import { hnScraperWorker } from "./scrapers/hn-scraper";
import { twitterScraperWorker } from "./scrapers/twitter-scraper";
import { linkedinScraperWorker } from "./scrapers/linkedin-scraper";
import { reviewScraperWorker } from "./scrapers/review-scraper";
import { embedSignalWorker } from "./embed-signal";
import { clusterSignalsWorker } from "./cluster-signals";
import { nameClusterWorker } from "./name-cluster";
import { deliverCampaignWorker } from "./deliver-campaign";
import { sendEmailWorker } from "./send-email";
import { sendSmsWorker } from "./send-sms";
import { sendVoiceWorker } from "./send-voice";
import { analyzeTranscriptWorker } from "./analyze-transcript";
import { refreshSignalFeedWorker } from "./refresh-signal-feed";
import { calculatePmfScoreWorker } from "./calculate-pmf-score";
import { generatePersonasWorker } from "./generate-personas";
import { refreshPersonasWorker } from "./refresh-personas";
import { sendNotificationWorker } from "./send-notification";
import { expireGracePeriodWorker } from "./expire-grace-period";
import { weeklyDigestSchedulerWorker } from "./weekly-digest-scheduler";
import { deliverWebhookWorker } from "./deliver-webhook";
import { sendChatWorker } from "./send-chat";
import { processAccountDeletionsWorker } from "./process-account-deletions";
import { refreshSignalFeedQueue, refreshPersonasQueue, weeklyDigestSchedulerQueue, expireGracePeriodQueue, processAccountDeletionsQueue } from "@/lib/queues";

console.log("[workers] Starting worker processes...");
console.log(`[workers] generate-keywords worker: ${generateKeywordsWorker.name}`);
console.log(`[workers] reddit-scraper worker: ${redditScraperWorker.name}`);
console.log(`[workers] hn-scraper worker: ${hnScraperWorker.name}`);
console.log(`[workers] twitter-scraper worker: ${twitterScraperWorker.name}`);
console.log(`[workers] linkedin-scraper worker: ${linkedinScraperWorker.name}`);
console.log(`[workers] review-scraper worker: ${reviewScraperWorker.name}`);
console.log(`[workers] embed-signal worker: ${embedSignalWorker.name}`);
console.log(`[workers] cluster-signals worker: ${clusterSignalsWorker.name}`);
console.log(`[workers] name-cluster worker: ${nameClusterWorker.name}`);
console.log(`[workers] deliver-campaign worker: ${deliverCampaignWorker.name}`);
console.log(`[workers] send-email worker: ${sendEmailWorker.name}`);
console.log(`[workers] send-sms worker: ${sendSmsWorker.name}`);
console.log(`[workers] send-voice worker: ${sendVoiceWorker.name}`);
console.log(`[workers] analyze-transcript worker: ${analyzeTranscriptWorker.name}`);
console.log(`[workers] refresh-signal-feed worker: ${refreshSignalFeedWorker.name}`);
console.log(`[workers] calculate-pmf-score worker: ${calculatePmfScoreWorker.name}`);
console.log(`[workers] generate-personas worker: ${generatePersonasWorker.name}`);
console.log(`[workers] refresh-personas worker: ${refreshPersonasWorker.name}`);
console.log(`[workers] send-notification worker: ${sendNotificationWorker.name}`);
console.log(`[workers] weekly-digest-scheduler worker: ${weeklyDigestSchedulerWorker.name}`);
console.log(`[workers] expire-grace-period worker: ${expireGracePeriodWorker.name}`);
console.log(`[workers] deliver-webhook worker: ${deliverWebhookWorker.name}`);
console.log(`[workers] send-chat worker: ${sendChatWorker.name}`);
console.log(`[workers] process-account-deletions worker: ${processAccountDeletionsWorker.name}`);

// Schedule the signal feed materialized view refresh as a repeatable job.
// Runs every 5 minutes via cron. BullMQ deduplicates repeatable jobs by
// (queue name + cron pattern), so this is safe to call on every startup.
// Requirements: 14.3, 23.2
await refreshSignalFeedQueue.add(
  "refresh-signal-feed",
  {},
  {
    repeat: { pattern: "*/5 * * * *" },
    jobId: "refresh-signal-feed-repeatable",
  },
);
console.log("[workers] Scheduled repeatable job: refresh-signal-feed (cron: */5 * * * *)");

// Schedule the persona refresh as a repeatable job.
// Runs every 24 hours via cron. BullMQ deduplicates repeatable jobs by
// (queue name + cron pattern), so this is safe to call on every startup.
// Requirements: 17.4
await refreshPersonasQueue.add(
  "refresh-personas",
  {},
  {
    repeat: { pattern: "0 */24 * * *" },
    jobId: "refresh-personas-repeatable",
  },
);
console.log("[workers] Scheduled repeatable job: refresh-personas (cron: 0 */24 * * *)");

// Schedule the weekly digest scheduler as a repeatable job.
// Runs every minute so it can check each account's timezone and determine
// whether it is currently Monday 09:00 in their local time.
// The worker itself handles deduplication via Redis keys to prevent
// sending more than one digest per account per day.
// Requirements: 19.3, 19.5
await weeklyDigestSchedulerQueue.add(
  "weekly-digest-scheduler",
  {},
  {
    repeat: { pattern: "* * * * *" },
    jobId: "weekly-digest-scheduler-repeatable",
  },
);
console.log("[workers] Scheduled repeatable job: weekly-digest-scheduler (cron: * * * * *)");

// Schedule the grace period expiry check as a repeatable job.
// Runs every hour to find accounts whose 7-day payment grace period has
// expired and downgrade them to the free tier.
// Requirements: 21.6
await expireGracePeriodQueue.add(
  "expire-grace-period",
  {},
  {
    repeat: { pattern: "0 * * * *" },
    jobId: "expire-grace-period-repeatable",
  },
);
console.log("[workers] Scheduled repeatable job: expire-grace-period (cron: 0 * * * *)");

// Schedule the account deletion processing as a daily repeatable job.
// Runs every day at 02:00 UTC to find accounts whose 30-day deletion window
// has passed and permanently delete them.
// Requirements: 22.4
await processAccountDeletionsQueue.add(
  "process-account-deletions",
  {},
  {
    repeat: { pattern: "0 2 * * *" },
    jobId: "process-account-deletions-repeatable",
  },
);
console.log("[workers] Scheduled repeatable job: process-account-deletions (cron: 0 2 * * *)");

// Graceful shutdown on SIGTERM / SIGINT
async function shutdown(signal: string) {
  console.log(`[workers] Received ${signal}, shutting down gracefully...`);

  try {
    await Promise.all([
      generateKeywordsWorker.close(),
      redditScraperWorker.close(),
      hnScraperWorker.close(),
      twitterScraperWorker.close(),
      linkedinScraperWorker.close(),
      reviewScraperWorker.close(),
      embedSignalWorker.close(),
      clusterSignalsWorker.close(),
      nameClusterWorker.close(),
      deliverCampaignWorker.close(),
      sendEmailWorker.close(),
      sendSmsWorker.close(),
      sendVoiceWorker.close(),
      analyzeTranscriptWorker.close(),
      refreshSignalFeedWorker.close(),
      calculatePmfScoreWorker.close(),
      generatePersonasWorker.close(),
      refreshPersonasWorker.close(),
      sendNotificationWorker.close(),
      weeklyDigestSchedulerWorker.close(),
      expireGracePeriodWorker.close(),
      deliverWebhookWorker.close(),
      sendChatWorker.close(),
      processAccountDeletionsWorker.close(),
    ]);
    console.log("[workers] All workers closed. Exiting.");
    process.exit(0);
  } catch (error) {
    console.error("[workers] Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log("[workers] All workers started and listening for jobs.");
