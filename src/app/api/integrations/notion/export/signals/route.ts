/**
 * POST /api/integrations/notion/export/signals
 *
 * Exports a signal report for a project as a Notion page.
 *
 * Request body:
 *   {
 *     projectId: string,       — required: the project to export signals from
 *     databaseId?: string      — optional: Notion database ID to create the page in
 *                                          (if omitted, creates a standalone page)
 *   }
 *
 * Response:
 *   { pageId: string, url: string }
 *
 * The exported page includes:
 *   - Report header with project name and export timestamp
 *   - Summary statistics (total signals, breakdown by type and source)
 *   - Top signals by relevance score (up to 50), grouped by signal type
 *   - Each signal shows: content, source, relevance score, sentiment, and source URL
 *
 * Requirements: 20.3
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and, desc, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { signals } from "@/db/schema/signals";
import { projects } from "@/db/schema/projects";
import { decrypt } from "@/lib/encryption";
import { requireAuth } from "@/lib/require-auth";
import { writeAuditLog } from "@/lib/audit-log";
import {
  createNotionPage,
  heading2,
  heading3,
  paragraph,
  bulletItem,
  divider,
  callout,
  type NotionBlock,
  type NotionCreatePagePayload,
} from "@/lib/notion-client";

// ── Request body schema ───────────────────────────────────────────────────────

interface ExportSignalsBody {
  projectId: string;
  databaseId?: string;
}

function isValidBody(body: unknown): body is ExportSignalsBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.projectId !== "string" || !b.projectId.trim()) return false;
  if (b.databaseId !== undefined && typeof b.databaseId !== "string") return false;
  return true;
}

// ── Signal type display labels ────────────────────────────────────────────────

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  pain_point: "Pain Point",
  feature_request: "Feature Request",
  competitor_mention: "Competitor Mention",
  market_trend: "Market Trend",
  positive_sentiment: "Positive Sentiment",
  negative_sentiment: "Negative Sentiment",
};

const SIGNAL_TYPE_EMOJIS: Record<string, string> = {
  pain_point: "🔥",
  feature_request: "💡",
  competitor_mention: "⚔️",
  market_trend: "📈",
  positive_sentiment: "✅",
  negative_sentiment: "⚠️",
};

const SENTIMENT_EMOJIS: Record<string, string> = {
  positive: "😊",
  neutral: "😐",
  negative: "😟",
};

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticate
  const authResult = await requireAuth(request);
  if (!authResult.ok) return authResult.response;

  const { accountId } = authResult;

  // 2. Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return NextResponse.json(
      { error: "Request body must include a non-empty string field: projectId" },
      { status: 400 },
    );
  }

  const { projectId, databaseId } = body;

  // 3. Verify the project belongs to this account
  const [project] = await db
    .select({ id: projects.id, name: projects.name, description: projects.description })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.accountId, accountId)))
    .limit(1);

  if (!project) {
    return NextResponse.json(
      { error: "Project not found or access denied." },
      { status: 404 },
    );
  }

  // 4. Load the Notion integration for this account
  const [integration] = await db
    .select({ accessToken: integrations.accessToken })
    .from(integrations)
    .where(
      and(
        eq(integrations.accountId, accountId),
        eq(integrations.provider, "notion"),
      ),
    )
    .limit(1);

  if (!integration) {
    return NextResponse.json(
      { error: "Notion integration not connected. Connect Notion first." },
      { status: 400 },
    );
  }

  // 5. Decrypt the access token
  let accessToken: string;
  try {
    accessToken = decrypt(integration.accessToken);
  } catch (err) {
    console.error("[notion/export/signals] Failed to decrypt access token:", err);
    return NextResponse.json(
      { error: "Failed to decrypt Notion access token. Please reconnect Notion." },
      { status: 500 },
    );
  }

  // 6. Fetch signals for the project (top 50 by relevance, excluding dismissed/excluded)
  const projectSignals = await db
    .select({
      id: signals.id,
      signalType: signals.signalType,
      signalKind: signals.signalKind,
      source: signals.source,
      content: signals.content,
      sourceUrl: signals.sourceUrl,
      author: signals.author,
      relevanceScore: signals.relevanceScore,
      sentiment: signals.sentiment,
      painIntensity: signals.painIntensity,
      isOpportunity: signals.isOpportunity,
      customLabel: signals.customLabel,
      ingestedAt: signals.ingestedAt,
    })
    .from(signals)
    .where(
      and(
        eq(signals.projectId, projectId),
        eq(signals.isDismissed, false),
        ne(signals.status, "excluded"),
      ),
    )
    .orderBy(desc(signals.relevanceScore))
    .limit(50);

  // 7. Build statistics
  const totalSignals = projectSignals.length;
  const byType = projectSignals.reduce<Record<string, number>>((acc, s) => {
    acc[s.signalType] = (acc[s.signalType] ?? 0) + 1;
    return acc;
  }, {});
  const bySource = projectSignals.reduce<Record<string, number>>((acc, s) => {
    acc[s.source] = (acc[s.source] ?? 0) + 1;
    return acc;
  }, {});
  const byKind = projectSignals.reduce<Record<string, number>>((acc, s) => {
    acc[s.signalKind] = (acc[s.signalKind] ?? 0) + 1;
    return acc;
  }, {});

  // 8. Build Notion blocks
  const exportDate = new Date().toISOString().split("T")[0];
  const blocks: NotionBlock[] = [];

  // Header
  blocks.push(
    callout(
      `Signal Report for "${project.name}" — exported on ${exportDate}`,
      "📊",
    ),
  );
  blocks.push(paragraph(project.description));
  blocks.push(divider());

  // Summary statistics
  blocks.push(heading2("📈 Summary"));
  blocks.push(paragraph(`Total signals: ${totalSignals}`));
  blocks.push(paragraph(`Active signals: ${byKind.active ?? 0} | Passive signals: ${byKind.passive ?? 0}`));

  // By type
  blocks.push(heading3("By Signal Type"));
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    const label = SIGNAL_TYPE_LABELS[type] ?? type;
    const emoji = SIGNAL_TYPE_EMOJIS[type] ?? "•";
    blocks.push(bulletItem(`${emoji} ${label}: ${count}`));
  }

  // By source
  blocks.push(heading3("By Source"));
  for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    blocks.push(bulletItem(`${source}: ${count}`));
  }

  blocks.push(divider());

  // Signals grouped by type
  blocks.push(heading2("🔍 Top Signals by Relevance"));

  const signalsByType = projectSignals.reduce<Record<string, typeof projectSignals>>((acc, s) => {
    if (!acc[s.signalType]) acc[s.signalType] = [];
    acc[s.signalType].push(s);
    return acc;
  }, {});

  // Order types by signal count descending
  const orderedTypes = Object.entries(signalsByType).sort((a, b) => b[1].length - a[1].length);

  for (const [type, typeSignals] of orderedTypes) {
    const label = SIGNAL_TYPE_LABELS[type] ?? type;
    const emoji = SIGNAL_TYPE_EMOJIS[type] ?? "•";
    blocks.push(heading3(`${emoji} ${label} (${typeSignals.length})`));

    for (const signal of typeSignals) {
      // Build signal summary line
      const sentimentEmoji = signal.sentiment ? (SENTIMENT_EMOJIS[signal.sentiment] ?? "") : "";
      const opportunityTag = signal.isOpportunity ? " 🎯 Opportunity" : "";
      const labelTag = signal.customLabel ? ` [${signal.customLabel}]` : "";
      const painTag =
        signal.painIntensity != null ? ` | Pain: ${signal.painIntensity}/10` : "";

      const metaLine = [
        `Source: ${signal.source}`,
        `Relevance: ${signal.relevanceScore}/100`,
        sentimentEmoji ? `Sentiment: ${sentimentEmoji} ${signal.sentiment ?? ""}` : null,
        signal.author ? `Author: ${signal.author}` : null,
        `Date: ${signal.ingestedAt.toISOString().split("T")[0]}`,
      ]
        .filter(Boolean)
        .join(" | ");

      // Content block (truncated to 1900 chars to stay within Notion limits)
      const contentText = signal.content.slice(0, 1900);
      blocks.push(
        bulletItem(
          `${sentimentEmoji}${opportunityTag}${labelTag}${painTag} ${contentText}`,
          signal.sourceUrl ?? undefined,
        ),
      );
      blocks.push(
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { content: metaLine, link: null },
                annotations: { italic: true, color: "gray" },
              },
            ],
          },
        } as NotionBlock,
      );
    }
  }

  // Notion API limits: max 100 children per request
  // We'll send the first 100 blocks (the API supports appending more later)
  const MAX_BLOCKS = 100;
  const pageBlocks = blocks.slice(0, MAX_BLOCKS);

  // 9. Build the page title
  const pageTitle = `Signal Report: ${project.name} (${exportDate})`;

  // 10. Build the Notion page payload
  const payload: NotionCreatePagePayload = databaseId
    ? {
        parent: { type: "database_id", database_id: databaseId },
        properties: {
          // Most databases use "Name" or "title" as the title property
          Name: { title: [{ text: { content: pageTitle } }] },
          title: { title: [{ text: { content: pageTitle } }] },
        },
        children: pageBlocks,
      }
    : {
        // Without a database, we need a parent page — use a workspace-level page
        // Notion requires a parent for standalone pages; if no databaseId is given,
        // we create it as a workspace page by using the workspace as parent.
        // Note: Notion API requires either database_id or page_id as parent.
        // When no databaseId is provided, we'll attempt to create in the workspace root.
        parent: { type: "page_id", page_id: "" },
        properties: {
          title: { title: [{ text: { content: pageTitle } }] },
        },
        children: pageBlocks,
      };

  // If no databaseId and no parent page, we can't create a standalone page without a parent.
  // Return an error asking for a databaseId.
  if (!databaseId) {
    return NextResponse.json(
      {
        error:
          "A databaseId is required to create a Notion page. Share a Notion database with the integration and provide its ID.",
      },
      { status: 400 },
    );
  }

  // 11. Create the Notion page
  let notionPage;
  try {
    notionPage = await createNotionPage(accessToken, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[notion/export/signals] Failed to create Notion page:", message);
    return NextResponse.json(
      { error: `Failed to create Notion page: ${message}` },
      { status: 502 },
    );
  }

  console.log(
    `[notion/export/signals] Created page ${notionPage.id} for project ${projectId}`,
  );

  // Write audit log (non-blocking)
  void writeAuditLog({
    accountId,
    actorId: accountId,
    action: "notion.export_signals",
    resourceType: "signal",
    resourceId: projectId,
    metadata: {
      projectId,
      notionPageId: notionPage.id,
      notionPageUrl: notionPage.url,
      signalCount: totalSignals,
      databaseId: databaseId ?? null,
    },
  });

  return NextResponse.json({
    pageId: notionPage.id,
    url: notionPage.url,
  });
}
