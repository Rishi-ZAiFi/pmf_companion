/**
 * POST /api/integrations/notion/export/clusters
 *
 * Exports theme cluster summaries for a project as a Notion page.
 *
 * Request body:
 *   {
 *     projectId: string,       — required: the project to export clusters from
 *     databaseId?: string      — optional: Notion database ID to create the page in
 *   }
 *
 * Response:
 *   { pageId: string, url: string }
 *
 * The exported page includes:
 *   - Report header with project name and export timestamp
 *   - Summary statistics (total clusters, total signals across clusters)
 *   - Each cluster as a section with: name, summary, signal count, trend direction,
 *     and up to 3 representative signal excerpts
 *
 * Requirements: 20.3
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { themeClusters, signalClusterMemberships } from "@/db/schema/theme-clusters";
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

interface ExportClustersBody {
  projectId: string;
  databaseId?: string;
}

function isValidBody(body: unknown): body is ExportClustersBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.projectId !== "string" || !b.projectId.trim()) return false;
  if (b.databaseId !== undefined && typeof b.databaseId !== "string") return false;
  return true;
}

// ── Trend direction display ───────────────────────────────────────────────────

const TREND_EMOJIS: Record<string, string> = {
  growing: "📈",
  stable: "➡️",
  declining: "📉",
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

  // 3. Require databaseId (Notion pages need a parent)
  if (!databaseId) {
    return NextResponse.json(
      {
        error:
          "A databaseId is required to create a Notion page. Share a Notion database with the integration and provide its ID.",
      },
      { status: 400 },
    );
  }

  // 4. Verify the project belongs to this account
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

  // 5. Load the Notion integration for this account
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

  // 6. Decrypt the access token
  let accessToken: string;
  try {
    accessToken = decrypt(integration.accessToken);
  } catch (err) {
    console.error("[notion/export/clusters] Failed to decrypt access token:", err);
    return NextResponse.json(
      { error: "Failed to decrypt Notion access token. Please reconnect Notion." },
      { status: 500 },
    );
  }

  // 7. Fetch all non-dismissed clusters for the project, sorted by signal count
  const clusters = await db
    .select({
      id: themeClusters.id,
      name: themeClusters.name,
      summary: themeClusters.summary,
      signalCount: themeClusters.signalCount,
      trendDirection: themeClusters.trendDirection,
      createdAt: themeClusters.createdAt,
      updatedAt: themeClusters.updatedAt,
    })
    .from(themeClusters)
    .where(
      and(
        eq(themeClusters.projectId, projectId),
        eq(themeClusters.isDismissed, false),
      ),
    )
    .orderBy(desc(themeClusters.signalCount));

  // 8. For each cluster, fetch up to 3 representative signal excerpts
  const clusterSignalMap = new Map<string, string[]>();

  for (const cluster of clusters) {
    const memberSignals = await db
      .select({ content: signals.content, source: signals.source })
      .from(signalClusterMemberships)
      .innerJoin(signals, eq(signalClusterMemberships.signalId, signals.id))
      .where(eq(signalClusterMemberships.clusterId, cluster.id))
      .orderBy(desc(signals.relevanceScore))
      .limit(3);

    clusterSignalMap.set(
      cluster.id,
      memberSignals.map((s) => `[${s.source}] ${s.content.slice(0, 300)}`),
    );
  }

  // 9. Build Notion blocks
  const exportDate = new Date().toISOString().split("T")[0];
  const blocks: NotionBlock[] = [];

  // Header
  blocks.push(
    callout(
      `Theme Cluster Report for "${project.name}" — exported on ${exportDate}`,
      "🗂️",
    ),
  );
  blocks.push(paragraph(project.description));
  blocks.push(divider());

  // Summary statistics
  const totalSignals = clusters.reduce((sum, c) => sum + c.signalCount, 0);
  const growingCount = clusters.filter((c) => c.trendDirection === "growing").length;
  const decliningCount = clusters.filter((c) => c.trendDirection === "declining").length;

  blocks.push(heading2("📊 Summary"));
  blocks.push(paragraph(`Total clusters: ${clusters.length} | Total signals: ${totalSignals}`));
  blocks.push(
    paragraph(
      `Trend: ${growingCount} growing 📈 | ${clusters.length - growingCount - decliningCount} stable ➡️ | ${decliningCount} declining 📉`,
    ),
  );
  blocks.push(divider());

  // Individual clusters
  blocks.push(heading2("🗂️ Theme Clusters"));

  if (clusters.length === 0) {
    blocks.push(
      callout(
        "No theme clusters have been generated yet. Clusters are created automatically as signals are ingested and embedded.",
        "ℹ️",
      ),
    );
  }

  for (const cluster of clusters) {
    const clusterName = cluster.name ?? "Unnamed Cluster";
    const trendEmoji = TREND_EMOJIS[cluster.trendDirection] ?? "➡️";

    // Cluster heading
    blocks.push(heading3(`${trendEmoji} ${clusterName}`));

    // Metadata line
    blocks.push(
      paragraph(
        `Signals: ${cluster.signalCount} | Trend: ${cluster.trendDirection} ${trendEmoji} | Last updated: ${cluster.updatedAt.toISOString().split("T")[0]}`,
      ),
    );

    // Summary
    if (cluster.summary) {
      blocks.push(paragraph(cluster.summary));
    } else {
      blocks.push(paragraph("Summary not yet generated."));
    }

    // Representative signal excerpts
    const excerpts = clusterSignalMap.get(cluster.id) ?? [];
    if (excerpts.length > 0) {
      blocks.push(
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { content: "Representative signals:", link: null },
                annotations: { bold: true },
              },
            ],
          },
        } as NotionBlock,
      );
      for (const excerpt of excerpts) {
        blocks.push(bulletItem(excerpt));
      }
    }

    blocks.push(divider());
  }

  // Notion API limits: max 100 children per request
  const MAX_BLOCKS = 100;
  const pageBlocks = blocks.slice(0, MAX_BLOCKS);

  // 10. Build the page title
  const pageTitle = `Theme Clusters: ${project.name} (${exportDate})`;

  // 11. Build the Notion page payload
  const payload: NotionCreatePagePayload = {
    parent: { type: "database_id", database_id: databaseId },
    properties: {
      Name: { title: [{ text: { content: pageTitle } }] },
      title: { title: [{ text: { content: pageTitle } }] },
    },
    children: pageBlocks,
  };

  // 12. Create the Notion page
  let notionPage;
  try {
    notionPage = await createNotionPage(accessToken, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[notion/export/clusters] Failed to create Notion page:", message);
    return NextResponse.json(
      { error: `Failed to create Notion page: ${message}` },
      { status: 502 },
    );
  }

  console.log(
    `[notion/export/clusters] Created page ${notionPage.id} for project ${projectId}`,
  );

  // Write audit log (non-blocking)
  void writeAuditLog({
    accountId,
    actorId: accountId,
    action: "notion.export_clusters",
    resourceType: "theme_cluster",
    resourceId: projectId,
    metadata: {
      projectId,
      notionPageId: notionPage.id,
      notionPageUrl: notionPage.url,
      clusterCount: clusters.length,
      totalSignals,
      databaseId,
    },
  });

  return NextResponse.json({
    pageId: notionPage.id,
    url: notionPage.url,
  });
}
