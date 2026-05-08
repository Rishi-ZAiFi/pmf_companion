/**
 * send-notification.ts
 *
 * BullMQ worker that processes notification jobs and delivers them via
 * email (SendGrid) and in-app notification records.
 *
 * Handles the following notification types:
 * - pmf-alert: PMF score changed by ≥5 points in 24 hours
 * - cluster-alert: New theme cluster reached ≥10 signals in 48 hours
 * - quota-warning: Account reached 90% of monthly conversation quota
 * - quota-exceeded: Account reached 100% of monthly conversation quota
 * - payment-failed: Stripe payment failed
 * - weekly-digest: Weekly summary of top signals, PMF score, and new clusters
 *
 * Requirements: 19.1, 19.2, 19.3, 21.3, 21.4, 21.6
 */

import { Worker, type Job } from "bullmq";
import sgMail from "@sendgrid/mail";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { notifications } from "@/db/schema/notifications";
import { accounts } from "@/db/schema/accounts";
import { projects } from "@/db/schema/projects";
import { signals } from "@/db/schema/signals";
import { themeClusters } from "@/db/schema/theme-clusters";
import { pmfScoreSnapshots } from "@/db/schema/pmf-score-snapshots";
import { redisConnection, type NotificationJobData } from "@/lib/queues";
import { env } from "@/lib/env";
import { getSlackIntegration, sendPmfAlert as sendSlackPmfAlert } from "@/lib/slack";

// Configure SendGrid API key
sgMail.setApiKey(env.SENDGRID_API_KEY);

// ── Constants ─────────────────────────────────────────────────────────────────

const FROM_EMAIL = "notifications@marketsignal.io";
const FROM_NAME = "Market Signal Platform";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch account details (email, name, timezone, notification preferences) for notification delivery.
 */
async function fetchAccount(accountId: string): Promise<{
  email: string;
  name: string | null;
  timezone: string;
  notificationPreferences: Record<string, boolean>;
} | null> {
  const [account] = await db
    .select({
      email: accounts.email,
      name: accounts.name,
      timezone: accounts.timezone,
      notificationPreferences: accounts.notificationPreferences,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account) return null;

  // Parse notification preferences with fallback to all-enabled
  const prefs = account.notificationPreferences as Record<string, unknown> | null;
  const notificationPreferences: Record<string, boolean> = {};
  if (prefs && typeof prefs === "object") {
    for (const [key, value] of Object.entries(prefs)) {
      if (typeof value === "boolean") {
        notificationPreferences[key] = value;
      }
    }
  }

  return {
    email: account.email,
    name: account.name,
    timezone: account.timezone,
    notificationPreferences,
  };
}

/**
 * Check whether a notification type is enabled for an account.
 * Defaults to `true` (enabled) if the preference is not explicitly set.
 */
function isNotificationEnabled(
  preferences: Record<string, boolean>,
  type: string,
): boolean {
  if (Object.prototype.hasOwnProperty.call(preferences, type)) {
    return preferences[type];
  }
  // Default: enabled
  return true;
}

/**
 * Fetch project name for notification context.
 */
async function fetchProjectName(projectId: string): Promise<string | null> {
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  return project?.name ?? null;
}

/**
 * Create an in-app notification record in the notifications table.
 */
async function createInAppNotification(
  accountId: string,
  projectId: string | undefined,
  type: string,
  title: string,
  body: string,
): Promise<void> {
  await db.insert(notifications).values({
    accountId,
    projectId: projectId ?? null,
    type,
    title,
    body,
    isRead: false,
  });
}

/**
 * Send an email notification via SendGrid.
 */
async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string,
  textBody: string,
): Promise<void> {
  try {
    await sgMail.send({
      to,
      from: {
        email: FROM_EMAIL,
        name: FROM_NAME,
      },
      subject,
      text: textBody,
      html: htmlBody,
    });
    console.log(`[send-notification] Email sent to ${to}: ${subject}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[send-notification] SendGrid send failed: ${message}`);
    throw error;
  }
}

// ── Notification Handlers ─────────────────────────────────────────────────────

/**
 * Handle pmf-alert notification.
 * Sent when PMF score changes by ≥5 points within 24 hours.
 * Requirements: 15.5, 19.1, 19.4
 */
async function handlePmfAlert(
  job: Job<NotificationJobData>,
): Promise<{ sent: boolean }> {
  const data = job.data;
  if (data.type !== "pmf-alert") {
    throw new Error("Invalid job data for pmf-alert handler");
  }

  const { accountId, projectId, newScore, previousScore, change } = data;

  const account = await fetchAccount(accountId);
  if (!account) {
    console.warn(`[pmf-alert] Account ${accountId} not found, skipping`);
    return { sent: false };
  }

  // Check notification preferences
  if (!isNotificationEnabled(account.notificationPreferences, "pmf-alert")) {
    console.log(`[pmf-alert] Notification disabled for account ${accountId}, skipping`);
    return { sent: false };
  }

  const projectName = await fetchProjectName(projectId);
  const projectLabel = projectName ?? "your project";

  const direction = change > 0 ? "increased" : "decreased";
  const emoji = change > 0 ? "📈" : "📉";

  const title = `${emoji} PMF Score ${direction} by ${Math.abs(change).toFixed(1)} points`;
  const body = `Your PMF score for ${projectLabel} ${direction} from ${previousScore.toFixed(1)} to ${newScore.toFixed(1)} in the past 24 hours.`;

  // Create in-app notification
  await createInAppNotification(accountId, projectId, "pmf-alert", title, body);

  // Send email notification
  const subject = `PMF Alert: Score ${direction} to ${newScore.toFixed(1)}`;
  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <h2 style="color: ${change > 0 ? "#10b981" : "#ef4444"};">${emoji} PMF Score ${direction}</h2>
  <p>Hi ${account.name ?? "there"},</p>
  <p>Your PMF score for <strong>${projectLabel}</strong> has ${direction} significantly:</p>
  <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
    <p style="margin: 0; font-size: 14px; color: #6b7280;">Previous Score (24h ago)</p>
    <p style="margin: 5px 0 15px 0; font-size: 32px; font-weight: bold;">${previousScore.toFixed(1)}%</p>
    <p style="margin: 0; font-size: 14px; color: #6b7280;">Current Score</p>
    <p style="margin: 5px 0 0 0; font-size: 32px; font-weight: bold; color: ${change > 0 ? "#10b981" : "#ef4444"};">${newScore.toFixed(1)}%</p>
  </div>
  <p>Change: <strong style="color: ${change > 0 ? "#10b981" : "#ef4444"};">${change > 0 ? "+" : ""}${change.toFixed(1)} points</strong></p>
  <p><a href="${env.NEXTAUTH_URL}/projects/${projectId}" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 10px;">View Dashboard</a></p>
</body>
</html>`.trim();

  const textBody = `
${emoji} PMF Score ${direction}

Hi ${account.name ?? "there"},

Your PMF score for ${projectLabel} has ${direction} significantly:

Previous Score (24h ago): ${previousScore.toFixed(1)}%
Current Score: ${newScore.toFixed(1)}%
Change: ${change > 0 ? "+" : ""}${change.toFixed(1)} points

View your dashboard: ${env.NEXTAUTH_URL}/projects/${projectId}
`.trim();

  await sendEmail(account.email, subject, htmlBody, textBody);

  // ── Send Slack notification if integration is connected ──────────────────
  // Requirements: 20.1
  try {
    const slackIntegration = await getSlackIntegration(accountId);
    if (slackIntegration) {
      await sendSlackPmfAlert({
        channelId: slackIntegration.channelId,
        accessToken: slackIntegration.accessToken,
        newScore,
        previousScore,
        change,
        projectName: projectLabel,
        appBaseUrl: env.NEXTAUTH_URL,
        projectId,
      });
      console.log(`[pmf-alert] Slack notification sent for account ${accountId}`);
    }
  } catch (slackError) {
    // Slack failure should not prevent the email/in-app notification from succeeding
    const message = slackError instanceof Error ? slackError.message : String(slackError);
    console.error(`[pmf-alert] Slack notification failed (non-fatal): ${message}`);
  }

  return { sent: true };
}

/**
 * Handle cluster-alert notification.
 * Sent when a new theme cluster reaches ≥10 signals within 48 hours.
 * Requirements: 16.5, 19.2, 19.4
 */
async function handleClusterAlert(
  job: Job<NotificationJobData>,
): Promise<{ sent: boolean }> {
  const data = job.data;
  if (data.type !== "cluster-alert") {
    throw new Error("Invalid job data for cluster-alert handler");
  }

  const { accountId, projectId, metadata } = data;

  if (!projectId) {
    console.warn("[cluster-alert] Missing projectId, skipping");
    return { sent: false };
  }

  const account = await fetchAccount(accountId);
  if (!account) {
    console.warn(`[cluster-alert] Account ${accountId} not found, skipping`);
    return { sent: false };
  }

  // Check notification preferences
  if (!isNotificationEnabled(account.notificationPreferences, "cluster-alert")) {
    console.log(`[cluster-alert] Notification disabled for account ${accountId}, skipping`);
    return { sent: false };
  }

  const clusterId = metadata?.clusterId as string | undefined;
  const clusterName = metadata?.clusterName as string | undefined;
  const signalCount = metadata?.signalCount as number | undefined;

  const projectName = await fetchProjectName(projectId);
  const projectLabel = projectName ?? "your project";

  const title = `🔔 New theme cluster: ${clusterName ?? "Unnamed"}`;
  const body = `A new theme cluster "${clusterName ?? "Unnamed"}" has reached ${signalCount ?? 10} signals in ${projectLabel}.`;

  // Create in-app notification only (not email for cluster alerts per requirements)
  await createInAppNotification(accountId, projectId, "cluster-alert", title, body);

  console.log(`[cluster-alert] In-app notification created for cluster ${clusterId}`);

  return { sent: true };
}

/**
 * Handle quota-warning notification.
 * Sent when account reaches 90% of monthly conversation quota.
 * Requirements: 21.3, 19.4
 */
async function handleQuotaWarning(
  job: Job<NotificationJobData>,
): Promise<{ sent: boolean }> {
  const data = job.data;
  if (data.type !== "quota-warning") {
    throw new Error("Invalid job data for quota-warning handler");
  }

  const { accountId, metadata } = data;

  const account = await fetchAccount(accountId);
  if (!account) {
    console.warn(`[quota-warning] Account ${accountId} not found, skipping`);
    return { sent: false };
  }

  // Check notification preferences
  if (!isNotificationEnabled(account.notificationPreferences, "quota-warning")) {
    console.log(`[quota-warning] Notification disabled for account ${accountId}, skipping`);
    return { sent: false };
  }

  const limit = metadata?.limit as number | undefined;
  const currentCount = metadata?.currentCount as number | undefined;

  const title = "⚠️ Approaching conversation quota limit";
  const body = `You've used ${currentCount ?? "N/A"} of ${limit ?? "N/A"} conversations this month (90% of your plan limit).`;

  // Create in-app notification
  await createInAppNotification(accountId, undefined, "quota-warning", title, body);

  // Send email notification
  const subject = "Approaching Conversation Quota Limit";
  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <h2 style="color: #f59e0b;">⚠️ Approaching Conversation Quota</h2>
  <p>Hi ${account.name ?? "there"},</p>
  <p>You've used <strong>${currentCount ?? "N/A"}</strong> of <strong>${limit ?? "N/A"}</strong> conversations this month (90% of your plan limit).</p>
  <p>When you reach 100% of your quota, all active campaigns will be paused automatically.</p>
  <p><a href="${env.NEXTAUTH_URL}/settings/billing" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 10px;">Upgrade Plan</a></p>
</body>
</html>`.trim();

  const textBody = `
⚠️ Approaching Conversation Quota

Hi ${account.name ?? "there"},

You've used ${currentCount ?? "N/A"} of ${limit ?? "N/A"} conversations this month (90% of your plan limit).

When you reach 100% of your quota, all active campaigns will be paused automatically.

Upgrade your plan: ${env.NEXTAUTH_URL}/settings/billing
`.trim();

  await sendEmail(account.email, subject, htmlBody, textBody);

  return { sent: true };
}

/**
 * Handle quota-exceeded notification.
 * Sent when account reaches 100% of monthly conversation quota.
 * Requirements: 21.4, 19.4
 */
async function handleQuotaExceeded(
  job: Job<NotificationJobData>,
): Promise<{ sent: boolean }> {
  const data = job.data;
  if (data.type !== "quota-exceeded") {
    throw new Error("Invalid job data for quota-exceeded handler");
  }

  const { accountId, metadata } = data;

  const account = await fetchAccount(accountId);
  if (!account) {
    console.warn(`[quota-exceeded] Account ${accountId} not found, skipping`);
    return { sent: false };
  }

  // Check notification preferences
  if (!isNotificationEnabled(account.notificationPreferences, "quota-exceeded")) {
    console.log(`[quota-exceeded] Notification disabled for account ${accountId}, skipping`);
    return { sent: false };
  }

  const limit = metadata?.limit as number | undefined;
  const currentCount = metadata?.currentCount as number | undefined;

  const title = "🚫 Conversation quota exceeded";
  const body = `You've reached your monthly conversation limit (${limit ?? "N/A"}). All active campaigns have been paused.`;

  // Create in-app notification
  await createInAppNotification(accountId, undefined, "quota-exceeded", title, body);

  // Send email notification
  const subject = "Conversation Quota Exceeded - Campaigns Paused";
  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <h2 style="color: #ef4444;">🚫 Conversation Quota Exceeded</h2>
  <p>Hi ${account.name ?? "there"},</p>
  <p>You've reached your monthly conversation limit of <strong>${limit ?? "N/A"}</strong> conversations.</p>
  <p><strong>All active campaigns have been paused automatically.</strong></p>
  <p>To resume your campaigns, please upgrade your plan or wait until your quota resets next month.</p>
  <p><a href="${env.NEXTAUTH_URL}/settings/billing" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 10px;">Upgrade Plan</a></p>
</body>
</html>`.trim();

  const textBody = `
🚫 Conversation Quota Exceeded

Hi ${account.name ?? "there"},

You've reached your monthly conversation limit of ${limit ?? "N/A"} conversations.

All active campaigns have been paused automatically.

To resume your campaigns, please upgrade your plan or wait until your quota resets next month.

Upgrade your plan: ${env.NEXTAUTH_URL}/settings/billing
`.trim();

  await sendEmail(account.email, subject, htmlBody, textBody);

  return { sent: true };
}

/**
 * Handle payment-failed notification.
 * Sent when a Stripe payment fails.
 * Requirements: 21.6, 19.4
 */
async function handlePaymentFailed(
  job: Job<NotificationJobData>,
): Promise<{ sent: boolean }> {
  const data = job.data;
  if (data.type !== "payment-failed") {
    throw new Error("Invalid job data for payment-failed handler");
  }

  const { accountId, metadata } = data;

  const account = await fetchAccount(accountId);
  if (!account) {
    console.warn(`[payment-failed] Account ${accountId} not found, skipping`);
    return { sent: false };
  }

  // Check notification preferences
  if (!isNotificationEnabled(account.notificationPreferences, "payment-failed")) {
    console.log(`[payment-failed] Notification disabled for account ${accountId}, skipping`);
    return { sent: false };
  }

  const invoiceUrl = metadata?.invoiceUrl as string | undefined;

  const title = "💳 Payment failed";
  const body = "Your recent payment failed. Please update your payment method to avoid service interruption.";

  // Create in-app notification
  await createInAppNotification(accountId, undefined, "payment-failed", title, body);

  // Send email notification
  const subject = "Payment Failed - Action Required";
  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <h2 style="color: #ef4444;">💳 Payment Failed</h2>
  <p>Hi ${account.name ?? "there"},</p>
  <p>We were unable to process your recent payment for Market Signal Platform.</p>
  <p>Please update your payment method within 7 days to avoid service interruption. If payment is not resolved, your account will be downgraded to the free tier.</p>
  <p><a href="${invoiceUrl ?? `${env.NEXTAUTH_URL}/settings/billing`}" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 10px;">Update Payment Method</a></p>
</body>
</html>`.trim();

  const textBody = `
💳 Payment Failed

Hi ${account.name ?? "there"},

We were unable to process your recent payment for Market Signal Platform.

Please update your payment method within 7 days to avoid service interruption. If payment is not resolved, your account will be downgraded to the free tier.

Update payment method: ${invoiceUrl ?? `${env.NEXTAUTH_URL}/settings/billing`}
`.trim();

  await sendEmail(account.email, subject, htmlBody, textBody);

  return { sent: true };
}

/**
 * Handle weekly-digest notification.
 * Sent every Monday at 09:00 in the founder's configured timezone.
 * Includes: top 5 signals by relevance, PMF score movement, new clusters from past 7 days.
 * Requirements: 19.3, 19.4, 19.5
 */
async function handleWeeklyDigest(
  job: Job<NotificationJobData>,
): Promise<{ sent: boolean }> {
  const data = job.data;
  if (data.type !== "weekly-digest") {
    throw new Error("Invalid job data for weekly-digest handler");
  }

  const { accountId, projectId } = data;

  if (!projectId) {
    console.warn("[weekly-digest] Missing projectId, skipping");
    return { sent: false };
  }

  const account = await fetchAccount(accountId);
  if (!account) {
    console.warn(`[weekly-digest] Account ${accountId} not found, skipping`);
    return { sent: false };
  }

  // Check notification preferences
  if (!isNotificationEnabled(account.notificationPreferences, "weekly-digest")) {
    console.log(`[weekly-digest] Notification disabled for account ${accountId}, skipping`);
    return { sent: false };
  }

  const projectName = await fetchProjectName(projectId);
  const projectLabel = projectName ?? "your project";

  // ── 1. Fetch top 5 signals by relevance from the past 7 days ────────────────
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const topSignals = await db
    .select({
      id: signals.id,
      content: signals.content,
      signalType: signals.signalType,
      relevanceScore: signals.relevanceScore,
      source: signals.source,
    })
    .from(signals)
    .where(
      and(
        eq(signals.projectId, projectId),
        gte(signals.ingestedAt, sevenDaysAgo),
        eq(signals.status, "embedded"),
      ),
    )
    .orderBy(desc(signals.relevanceScore))
    .limit(5);

  // ── 2. Fetch PMF score movement (current vs 7 days ago) ─────────────────────
  const today = new Date().toISOString().split("T")[0];
  const sevenDaysAgoDate = sevenDaysAgo.toISOString().split("T")[0];

  const [currentSnapshot] = await db
    .select({ score: pmfScoreSnapshots.score })
    .from(pmfScoreSnapshots)
    .where(eq(pmfScoreSnapshots.projectId, projectId))
    .orderBy(desc(pmfScoreSnapshots.snapshotDate))
    .limit(1);

  const [previousSnapshot] = await db
    .select({ score: pmfScoreSnapshots.score })
    .from(pmfScoreSnapshots)
    .where(
      and(
        eq(pmfScoreSnapshots.projectId, projectId),
        sql`${pmfScoreSnapshots.snapshotDate} <= ${sevenDaysAgoDate}`,
      ),
    )
    .orderBy(desc(pmfScoreSnapshots.snapshotDate))
    .limit(1);

  const currentScore = currentSnapshot ? parseFloat(currentSnapshot.score as string) : null;
  const previousScore = previousSnapshot ? parseFloat(previousSnapshot.score as string) : null;
  const scoreChange =
    currentScore !== null && previousScore !== null ? currentScore - previousScore : null;

  // ── 3. Fetch new clusters from the past 7 days ──────────────────────────────
  const newClusters = await db
    .select({
      id: themeClusters.id,
      name: themeClusters.name,
      signalCount: themeClusters.signalCount,
    })
    .from(themeClusters)
    .where(
      and(
        eq(themeClusters.projectId, projectId),
        gte(themeClusters.createdAt, sevenDaysAgo),
      ),
    )
    .orderBy(desc(themeClusters.signalCount))
    .limit(5);

  // ── 4. Build email content ───────────────────────────────────────────────────
  const subject = `Weekly Digest: ${projectLabel}`;

  const signalsHtml = topSignals.length > 0
    ? topSignals
        .map(
          (s, i) => `
    <div style="background: #f9fafb; padding: 15px; border-radius: 6px; margin-bottom: 10px;">
      <p style="margin: 0; font-size: 14px; color: #6b7280;">#${i + 1} · ${s.signalType} · ${s.source} · Relevance: ${s.relevanceScore}</p>
      <p style="margin: 5px 0 0 0; font-size: 14px;">${s.content.substring(0, 200)}${s.content.length > 200 ? "..." : ""}</p>
    </div>
  `,
        )
        .join("")
    : "<p>No new signals this week.</p>";

  const signalsText = topSignals.length > 0
    ? topSignals
        .map(
          (s, i) =>
            `#${i + 1} · ${s.signalType} · ${s.source} · Relevance: ${s.relevanceScore}\n${s.content.substring(0, 200)}${s.content.length > 200 ? "..." : ""}`,
        )
        .join("\n\n")
    : "No new signals this week.";

  const pmfHtml =
    currentScore !== null
      ? `
    <div style="background: #f3f4f6; padding: 15px; border-radius: 6px;">
      <p style="margin: 0; font-size: 14px; color: #6b7280;">Current PMF Score</p>
      <p style="margin: 5px 0 0 0; font-size: 24px; font-weight: bold;">${currentScore.toFixed(1)}%</p>
      ${
        scoreChange !== null
          ? `<p style="margin: 5px 0 0 0; font-size: 14px; color: ${scoreChange >= 0 ? "#10b981" : "#ef4444"};">
          ${scoreChange >= 0 ? "+" : ""}${scoreChange.toFixed(1)} points from last week
        </p>`
          : ""
      }
    </div>
  `
      : "<p>No PMF score data available yet.</p>";

  const pmfText =
    currentScore !== null
      ? `Current PMF Score: ${currentScore.toFixed(1)}%${scoreChange !== null ? ` (${scoreChange >= 0 ? "+" : ""}${scoreChange.toFixed(1)} from last week)` : ""}`
      : "No PMF score data available yet.";

  const clustersHtml = newClusters.length > 0
    ? newClusters
        .map(
          (c) => `
    <div style="background: #f9fafb; padding: 15px; border-radius: 6px; margin-bottom: 10px;">
      <p style="margin: 0; font-size: 14px; font-weight: bold;">${c.name ?? "Unnamed Cluster"}</p>
      <p style="margin: 5px 0 0 0; font-size: 14px; color: #6b7280;">${c.signalCount} signals</p>
    </div>
  `,
        )
        .join("")
    : "<p>No new clusters this week.</p>";

  const clustersText = newClusters.length > 0
    ? newClusters
        .map((c) => `${c.name ?? "Unnamed Cluster"} (${c.signalCount} signals)`)
        .join("\n")
    : "No new clusters this week.";

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <h2>📊 Weekly Digest: ${projectLabel}</h2>
  <p>Hi ${account.name ?? "there"},</p>
  <p>Here's your weekly summary for ${projectLabel}:</p>

  <h3 style="margin-top: 30px;">Top 5 Signals</h3>
  ${signalsHtml}

  <h3 style="margin-top: 30px;">PMF Score</h3>
  ${pmfHtml}

  <h3 style="margin-top: 30px;">New Theme Clusters</h3>
  ${clustersHtml}

  <p style="margin-top: 30px;"><a href="${env.NEXTAUTH_URL}/projects/${projectId}" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">View Dashboard</a></p>
</body>
</html>`.trim();

  const textBody = `
📊 Weekly Digest: ${projectLabel}

Hi ${account.name ?? "there"},

Here's your weekly summary for ${projectLabel}:

TOP 5 SIGNALS
${signalsText}

PMF SCORE
${pmfText}

NEW THEME CLUSTERS
${clustersText}

View your dashboard: ${env.NEXTAUTH_URL}/projects/${projectId}
`.trim();

  await sendEmail(account.email, subject, htmlBody, textBody);

  console.log(`[weekly-digest] Digest sent to ${account.email} for project ${projectId}`);

  return { sent: true };
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes notification jobs.
 *
 * Requirements: 19.1, 19.2, 19.3, 21.3, 21.4, 21.6
 */
export const sendNotificationWorker = new Worker<NotificationJobData>(
  "notifications",
  async (job: Job<NotificationJobData>) => {
    const { type } = job.data;

    console.log(`[send-notification] Processing job ${job.id} of type ${type}`);

    switch (type) {
      case "pmf-alert":
        return await handlePmfAlert(job);
      case "cluster-alert":
        return await handleClusterAlert(job);
      case "quota-warning":
        return await handleQuotaWarning(job);
      case "quota-exceeded":
        return await handleQuotaExceeded(job);
      case "payment-failed":
        return await handlePaymentFailed(job);
      case "weekly-digest":
        return await handleWeeklyDigest(job);
      default:
        console.warn(`[send-notification] Unknown notification type: ${type}`);
        return { sent: false, reason: "unknown_type" };
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
    lockDuration: 60_000, // 1 minute — digest emails can take time to build
  },
);

sendNotificationWorker.on("completed", (job, result) => {
  console.log(
    `[send-notification] Job ${job.id} completed:`,
    JSON.stringify(result),
  );
});

sendNotificationWorker.on("failed", (job, error) => {
  console.error(
    `[send-notification] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

sendNotificationWorker.on("error", (error) => {
  console.error(`[send-notification] Worker error: ${error.message}`);
});
