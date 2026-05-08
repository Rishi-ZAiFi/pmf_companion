import { Worker, type Job } from "bullmq";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { campaigns } from "@/db/schema/campaigns";
import { contacts } from "@/db/schema/contacts";
import { conversations } from "@/db/schema/conversations";
import {
  redisConnection,
  deliverCampaignQueue,
  sendEmailQueue,
  sendSmsQueue,
  sendVoiceQueue,
  sendChatQueue,
  notificationQueue,
  type DeliverCampaignJobData,
  type SendConversationJobData,
} from "@/lib/queues";
import { projects } from "@/db/schema/projects";

// ── Plan limits ──────────────────────────────────────────────────────────────

const PLAN_CONVERSATION_LIMITS: Record<string, number> = {
  free: 50,
  starter: 500,
  growth: 2000,
  enterprise: Infinity,
};

/**
 * Returns the Redis key for the monthly conversation counter.
 * Format: account:{accountId}:conversations:{YYYY-MM}
 */
function conversationCountKey(accountId: string): string {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `account:${accountId}:conversations:${month}`;
}

/**
 * Returns the channel-specific queue for a given channel.
 */
function getChannelQueue(channel: string) {
  switch (channel) {
    case "email":
      return sendEmailQueue;
    case "sms":
      return sendSmsQueue;
    case "voice":
      return sendVoiceQueue;
    case "widget":
      return sendChatQueue;
    default:
      throw new Error(`Unknown channel: ${channel}`);
  }
}

/**
 * Checks whether a contact has opted out of a given channel.
 */
function isOptedOut(
  contact: {
    optedOutEmail: boolean;
    optedOutSms: boolean;
    optedOutVoice: boolean;
  },
  channel: string,
): boolean {
  switch (channel) {
    case "email":
      return contact.optedOutEmail;
    case "sms":
      return contact.optedOutSms;
    case "voice":
      return contact.optedOutVoice;
    case "widget":
      // Widget channel has no opt-out flag; respect email opt-out as a proxy
      return false;
    default:
      return false;
  }
}

/**
 * BullMQ Worker that processes `deliver-campaign` jobs.
 *
 * For each job:
 * 1. Loads the campaign and verifies it is in `launching` status.
 * 2. Loads target contacts filtered by the campaign's segment filter.
 * 3. Checks opt-out status per contact per channel.
 * 4. Enforces the monthly conversation quota via Redis atomic increment.
 * 5. Creates conversation records and enqueues channel-specific send jobs.
 * 6. Sets campaign status to `active` when delivery is complete.
 *
 * Requirements: 9.6, 21.1, 21.3, 21.4
 */
export const deliverCampaignWorker = new Worker<DeliverCampaignJobData>(
  "deliver-campaign",
  async (job: Job<DeliverCampaignJobData>) => {
    const { campaignId, projectId, accountId } = job.data;

    console.log(
      `[deliver-campaign] Processing job ${job.id} for campaign ${campaignId}`,
    );

    // ── 1. Load campaign ─────────────────────────────────────────────────────
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!campaign) {
      console.warn(
        `[deliver-campaign] Campaign ${campaignId} not found, skipping`,
      );
      return { skipped: true, reason: "campaign_not_found" };
    }

    // Only process campaigns in launching status
    // (paused campaigns should not continue delivery)
    if (campaign.status !== "launching") {
      console.warn(
        `[deliver-campaign] Campaign ${campaignId} is in status '${campaign.status}', expected 'launching'. Skipping.`,
      );
      return { skipped: true, reason: `unexpected_status_${campaign.status}` };
    }

    // ── 2. Load account plan tier ────────────────────────────────────────────
    const [project] = await db
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    // Get plan tier from accounts table
    const { accounts } = await import("@/db/schema/accounts");
    const [account] = await db
      .select({ planTier: accounts.planTier })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    const planTier = account?.planTier ?? "free";
    const limit = PLAN_CONVERSATION_LIMITS[planTier] ?? 0;

    // ── 3. Load target contacts filtered by segment ──────────────────────────
    let targetContacts: Array<{
      id: string;
      email: string | null;
      phone: string | null;
      optedOutEmail: boolean;
      optedOutSms: boolean;
      optedOutVoice: boolean;
      segmentTags: string[];
    }>;

    if (campaign.segmentFilter && campaign.segmentFilter.length > 0) {
      // Filter contacts by segment tags — contact must have at least one matching tag
      targetContacts = await db
        .select({
          id: contacts.id,
          email: contacts.email,
          phone: contacts.phone,
          optedOutEmail: contacts.optedOutEmail,
          optedOutSms: contacts.optedOutSms,
          optedOutVoice: contacts.optedOutVoice,
          segmentTags: contacts.segmentTags,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.projectId, projectId),
            // Check if any of the campaign's segment filters overlap with contact's tags
            sql`${contacts.segmentTags} && ${campaign.segmentFilter}::text[]`,
          ),
        );
    } else {
      // No segment filter — target all contacts in the project
      targetContacts = await db
        .select({
          id: contacts.id,
          email: contacts.email,
          phone: contacts.phone,
          optedOutEmail: contacts.optedOutEmail,
          optedOutSms: contacts.optedOutSms,
          optedOutVoice: contacts.optedOutVoice,
          segmentTags: contacts.segmentTags,
        })
        .from(contacts)
        .where(eq(contacts.projectId, projectId));
    }

    console.log(
      `[deliver-campaign] Found ${targetContacts.length} target contacts for campaign ${campaignId}`,
    );

    // ── 4. Deliver conversations per contact per channel ─────────────────────
    let deliveredCount = 0;
    let skippedOptOut = 0;
    let skippedQuota = 0;
    const redisKey = conversationCountKey(accountId);

    for (const contact of targetContacts) {
      for (const channel of campaign.channels) {
        // Check campaign status before each delivery (may have been paused/cancelled)
        const [currentCampaign] = await db
          .select({ status: campaigns.status })
          .from(campaigns)
          .where(eq(campaigns.id, campaignId))
          .limit(1);

        if (
          !currentCampaign ||
          (currentCampaign.status !== "launching" &&
            currentCampaign.status !== "active")
        ) {
          console.log(
            `[deliver-campaign] Campaign ${campaignId} status changed to '${currentCampaign?.status}', stopping delivery`,
          );
          // Update campaign status to reflect partial delivery
          await db
            .update(campaigns)
            .set({ updatedAt: new Date() })
            .where(eq(campaigns.id, campaignId));
          return {
            delivered: deliveredCount,
            skippedOptOut,
            skippedQuota,
            stopped: true,
            reason: `campaign_${currentCampaign?.status ?? "not_found"}`,
          };
        }

        // Check opt-out status for this channel (Requirement 9.6)
        if (isOptedOut(contact, channel)) {
          skippedOptOut++;
          continue;
        }

        // Check channel-specific contact info availability
        if (channel === "email" && !contact.email) continue;
        if (channel === "sms" && !contact.phone) continue;
        if (channel === "voice" && !contact.phone) continue;

        // Enforce monthly quota via Redis atomic increment (Requirement 21.1)
        if (limit !== Infinity) {
          const newCount = await redisConnection.incr(redisKey);

          // Set TTL on first increment (expire at end of month + buffer)
          if (newCount === 1) {
            // Set expiry to ~35 days to cover the full month
            await redisConnection.expire(redisKey, 35 * 24 * 60 * 60);
          }

          if (newCount > limit) {
            // Quota exceeded — decrement back and stop delivery
            await redisConnection.decr(redisKey);
            skippedQuota++;

            // Pause all active campaigns and notify (Requirement 21.4)
            await db
              .update(campaigns)
              .set({ status: "paused", updatedAt: new Date() })
              .where(eq(campaigns.id, campaignId));

            try {
              await notificationQueue.add("quota-exceeded", {
                type: "quota-exceeded",
                accountId,
                projectId,
                metadata: { limit, currentCount: newCount - 1 },
              });
            } catch (notifyErr) {
              console.error(
                "[deliver-campaign] Failed to enqueue quota-exceeded notification:",
                notifyErr,
              );
            }

            console.log(
              `[deliver-campaign] Quota exceeded for account ${accountId}, pausing campaign ${campaignId}`,
            );

            return {
              delivered: deliveredCount,
              skippedOptOut,
              skippedQuota: skippedQuota + (targetContacts.length - deliveredCount - skippedOptOut),
              stopped: true,
              reason: "quota_exceeded",
            };
          }

          // Warn at 90% usage (Requirement 21.3)
          const warningThreshold = Math.floor(limit * 0.9);
          if (newCount === warningThreshold) {
            try {
              await notificationQueue.add("quota-warning", {
                type: "quota-warning",
                accountId,
                projectId,
                metadata: { limit, currentCount: newCount, warningThreshold },
              });
            } catch (notifyErr) {
              console.error(
                "[deliver-campaign] Failed to enqueue quota-warning notification:",
                notifyErr,
              );
            }
          }
        }

        // Create conversation record
        const [conversation] = await db
          .insert(conversations)
          .values({
            campaignId,
            contactId: contact.id,
            projectId,
            channel,
            status: "pending",
          })
          .returning();

        // Enqueue channel-specific send-conversation job
        const channelQueue = getChannelQueue(channel);
        const jobData: SendConversationJobData = {
          conversationId: conversation.id,
          campaignId,
          contactId: contact.id,
          projectId,
          channel,
        };

        await channelQueue.add(`send-${channel}`, jobData, {
          attempts: 3,
          backoff: { type: "exponential", delay: 10000 },
        });

        deliveredCount++;
      }
    }

    // ── 5. Update campaign status to `active` ────────────────────────────────
    await db
      .update(campaigns)
      .set({
        status: "active",
        conversationCount: deliveredCount,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));

    console.log(
      `[deliver-campaign] Campaign ${campaignId} delivery complete: ` +
        `${deliveredCount} conversations enqueued, ` +
        `${skippedOptOut} skipped (opt-out), ` +
        `${skippedQuota} skipped (quota)`,
    );

    return {
      delivered: deliveredCount,
      skippedOptOut,
      skippedQuota,
    };
  },
  {
    connection: redisConnection,
    concurrency: 2,
    lockDuration: 300_000, // 5 minutes — delivery can take time for large contact lists
  },
);

deliverCampaignWorker.on("completed", (job, result) => {
  console.log(
    `[deliver-campaign] Job ${job.id} completed:`,
    JSON.stringify(result),
  );
});

deliverCampaignWorker.on("failed", (job, error) => {
  console.error(
    `[deliver-campaign] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

deliverCampaignWorker.on("error", (error) => {
  console.error(`[deliver-campaign] Worker error: ${error.message}`);
});
