/**
 * slack.ts
 *
 * Slack notification service for the Market Signal Platform.
 *
 * Provides:
 *   - `sendSignalSummary`  — posts a Block Kit signal summary to a Slack channel
 *   - `sendPmfAlert`       — posts a Block Kit PMF score alert to a Slack channel
 *   - `getSlackIntegration` — loads and decrypts the Slack integration for an account
 *
 * The Slack Web API `chat.postMessage` method is used for all messages.
 * Block Kit formatting is used to produce rich, structured messages.
 *
 * Requirements: 20.1
 */

import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { decrypt } from "@/lib/encryption";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Slack Block Kit block (simplified union for the blocks we use). */
type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji?: boolean } }
  | { type: "section"; text: { type: "mrkdwn"; text: string }; fields?: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "section"; text?: { type: "mrkdwn"; text: string }; fields: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "divider" }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "actions"; elements: Array<{ type: "button"; text: { type: "plain_text"; text: string }; url?: string; style?: "primary" | "danger" }> };

/** Payload for a signal summary notification. */
export interface SignalSummaryPayload {
  /** The Slack channel ID to post to (from integrations.config.channel_id). */
  channelId: string;
  /** Decrypted Slack bot access token. */
  accessToken: string;
  /** Signal details. */
  signal: {
    id: string;
    content: string;
    signalType: string;
    source: string;
    relevanceScore: number;
    sentiment?: string | null;
    sourceUrl?: string | null;
  };
  /** Project name for context. */
  projectName: string;
  /** Base URL of the platform (e.g. https://app.marketsignal.io). */
  appBaseUrl: string;
  /** Project ID for deep-link. */
  projectId: string;
}

/** Payload for a PMF alert notification. */
export interface PmfAlertPayload {
  /** The Slack channel ID to post to. */
  channelId: string;
  /** Decrypted Slack bot access token. */
  accessToken: string;
  /** PMF score details. */
  newScore: number;
  previousScore: number;
  change: number;
  /** Project name for context. */
  projectName: string;
  /** Base URL of the platform. */
  appBaseUrl: string;
  /** Project ID for deep-link. */
  projectId: string;
}

/** Resolved Slack integration config for an account. */
export interface SlackIntegration {
  accessToken: string;
  channelId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map a signal type to a human-readable label and emoji.
 */
function signalTypeLabel(type: string): string {
  const map: Record<string, string> = {
    pain_point: "🔴 Pain Point",
    feature_request: "💡 Feature Request",
    competitor_mention: "🏁 Competitor Mention",
    market_trend: "📈 Market Trend",
    positive_sentiment: "✅ Positive Sentiment",
    negative_sentiment: "⚠️ Negative Sentiment",
  };
  return map[type] ?? type;
}

/**
 * Map a source to a human-readable label.
 */
function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    reddit: "Reddit",
    twitter: "Twitter/X",
    hn: "Hacker News",
    linkedin: "LinkedIn",
    review: "Review Site",
    email: "Email",
    sms: "SMS",
    voice: "Voice Call",
    widget: "Chat Widget",
  };
  return map[source] ?? source;
}

/**
 * Call the Slack Web API `chat.postMessage` endpoint.
 *
 * @throws If the Slack API returns an error response.
 */
async function callChatPostMessage(
  accessToken: string,
  channelId: string,
  blocks: SlackBlock[],
  fallbackText: string,
): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      channel: channelId,
      text: fallbackText, // Fallback for notifications / accessibility
      blocks,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `[slack] chat.postMessage HTTP error: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    throw new Error(`[slack] chat.postMessage API error: ${body.error ?? "unknown"}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load and decrypt the Slack integration for an account.
 *
 * Returns `null` if no Slack integration is connected for the account.
 */
export async function getSlackIntegration(
  accountId: string,
): Promise<SlackIntegration | null> {
  const [row] = await db
    .select({
      accessToken: integrations.accessToken,
      config: integrations.config,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.accountId, accountId),
        eq(integrations.provider, "slack"),
      ),
    )
    .limit(1);

  if (!row) return null;

  const config = row.config as Record<string, unknown> | null;
  const channelId = config?.channel_id as string | undefined;

  if (!channelId) {
    console.warn(`[slack] Slack integration for account ${accountId} has no channel_id configured`);
    return null;
  }

  let accessToken: string;
  try {
    accessToken = decrypt(row.accessToken);
  } catch (err) {
    console.error(`[slack] Failed to decrypt access token for account ${accountId}:`, err);
    return null;
  }

  return { accessToken, channelId };
}

/**
 * Post a signal summary to the configured Slack channel using Block Kit formatting.
 *
 * Requirements: 20.1
 */
export async function sendSignalSummary(payload: SignalSummaryPayload): Promise<void> {
  const { channelId, accessToken, signal, projectName, appBaseUrl, projectId } = payload;

  const typeLabel = signalTypeLabel(signal.signalType);
  const src = sourceLabel(signal.source);
  const truncatedContent =
    signal.content.length > 300
      ? signal.content.substring(0, 297) + "..."
      : signal.content;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `New Signal: ${typeLabel}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Project:* ${projectName}\n\n${truncatedContent}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Type:*\n${typeLabel}` },
        { type: "mrkdwn", text: `*Source:*\n${src}` },
        { type: "mrkdwn", text: `*Relevance Score:*\n${signal.relevanceScore}/100` },
        ...(signal.sentiment
          ? [{ type: "mrkdwn" as const, text: `*Sentiment:*\n${signal.sentiment}` }]
          : []),
      ],
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Signal Feed" },
          url: `${appBaseUrl}/projects/${projectId}/signals`,
          style: "primary",
        },
        ...(signal.sourceUrl
          ? [
              {
                type: "button" as const,
                text: { type: "plain_text" as const, text: "View Source" },
                url: signal.sourceUrl,
              },
            ]
          : []),
      ],
    },
  ];

  const fallbackText = `New ${typeLabel} signal from ${src} for ${projectName}: ${truncatedContent}`;

  await callChatPostMessage(accessToken, channelId, blocks, fallbackText);

  console.log(
    `[slack] Signal summary posted to channel ${channelId} for project ${projectId}`,
  );
}

/**
 * Post a PMF score alert to the configured Slack channel using Block Kit formatting.
 *
 * Requirements: 20.1
 */
export async function sendPmfAlert(payload: PmfAlertPayload): Promise<void> {
  const { channelId, accessToken, newScore, previousScore, change, projectName, appBaseUrl, projectId } =
    payload;

  const direction = change > 0 ? "increased" : "decreased";
  const emoji = change > 0 ? "📈" : "📉";
  const changeFormatted = `${change > 0 ? "+" : ""}${change.toFixed(1)}`;
  const colorIndicator = change > 0 ? "🟢" : "🔴";

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} PMF Score Alert: ${projectName}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Your PMF score for *${projectName}* has *${direction}* by *${Math.abs(change).toFixed(1)} points* in the past 24 hours.`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Previous Score:*\n${previousScore.toFixed(1)}%` },
        { type: "mrkdwn", text: `*Current Score:*\n${colorIndicator} ${newScore.toFixed(1)}%` },
        { type: "mrkdwn", text: `*Change:*\n${changeFormatted} points` },
      ],
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View PMF Dashboard" },
          url: `${appBaseUrl}/projects/${projectId}/pmf-score`,
          style: "primary",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Sent by <${appBaseUrl}|Market Signal Platform> · <${appBaseUrl}/settings/integrations|Manage Slack integration>`,
        },
      ],
    },
  ];

  const fallbackText = `${emoji} PMF Score Alert for ${projectName}: ${direction} from ${previousScore.toFixed(1)}% to ${newScore.toFixed(1)}% (${changeFormatted} points)`;

  await callChatPostMessage(accessToken, channelId, blocks, fallbackText);

  console.log(
    `[slack] PMF alert posted to channel ${channelId} for project ${projectId}`,
  );
}
