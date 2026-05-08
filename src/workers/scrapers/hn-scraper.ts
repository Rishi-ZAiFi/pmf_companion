/**
 * hn-scraper.ts
 *
 * BullMQ worker that scrapes Hacker News for market signals relevant to a project.
 *
 * Schedule: every 2 hours (repeatable job per project).
 *
 * Uses the Hacker News Algolia API (https://hn.algolia.com/api) to search for
 * "Ask HN" and "Show HN" posts matching the project's problem space keywords.
 *
 * Flow:
 * 1. Load project keywords from the database.
 * 2. Query the Algolia HN API for Ask HN / Show HN posts matching keywords.
 * 3. Fetch top comments for each matching post.
 * 4. Classify each post/comment via OpenAI (signal type + relevance score).
 * 5. Bulk INSERT ... ON CONFLICT DO NOTHING for deduplication.
 * 6. Enqueue `embed-signal` jobs for newly inserted signals.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */

import { type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { signals } from "@/db/schema/signals";
import {
  hnScraperQueue,
  embedSignalQueue,
  type ScraperJobData,
} from "@/lib/queues";
import { SCRAPER_JOB_OPTIONS, BaseScraper } from "./base-scraper";
import { classifySignal } from "./signal-classifier";

// ── Constants ─────────────────────────────────────────────────────────────────

/** How often the repeatable job runs (2 hours in milliseconds). */
const REPEAT_EVERY_MS = 2 * 60 * 60 * 1000;

/** Algolia HN API base URL. */
const HN_ALGOLIA_BASE = "https://hn.algolia.com/api/v1";

/** Maximum number of posts to fetch per keyword query. */
const MAX_POSTS_PER_QUERY = 20;

/** Maximum number of comments to process per post. */
const MAX_COMMENTS_PER_POST = 10;

/** Minimum number of points (upvotes) for a post to be considered. */
const MIN_POST_POINTS = 1;

// ── Algolia API response types ────────────────────────────────────────────────

interface AlgoliaHit {
  objectID: string;
  title?: string;
  story_text?: string;
  comment_text?: string;
  author: string;
  points?: number;
  num_comments?: number;
  url?: string;
  story_id?: number;
  parent_id?: number;
  created_at: string;
  _tags: string[];
}

interface AlgoliaSearchResponse {
  hits: AlgoliaHit[];
  nbHits: number;
  page: number;
  nbPages: number;
}

interface AlgoliaItemResponse {
  id: number;
  title?: string;
  text?: string;
  author: string;
  points?: number;
  children?: AlgoliaItemResponse[];
  created_at: string;
}

// ── Helper types ──────────────────────────────────────────────────────────────

interface RawSignal {
  content: string;
  sourceUrl: string;
  author: string;
  metadata: Record<string, unknown>;
}

// ── HN scraper implementation ─────────────────────────────────────────────────

class HNScraper extends BaseScraper {
  constructor() {
    super("hn-scraper");
  }

  async scrape(job: Job<ScraperJobData>): Promise<void> {
    const { projectId } = job.data;

    // ── 1. Load project ──────────────────────────────────────────────────────
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      console.warn(`[hn-scraper] Project ${projectId} not found — skipping`);
      return;
    }

    const keywords = project.keywords ?? [];

    if (keywords.length === 0) {
      console.log(
        `[hn-scraper] Project ${projectId} has no keywords yet — skipping`,
      );
      return;
    }

    // ── 2. Check robots.txt for HN Algolia API ───────────────────────────────
    const algoliaAllowed = await this.checkRobots(HN_ALGOLIA_BASE);
    if (!algoliaAllowed) {
      console.warn(
        `[hn-scraper] robots.txt disallows fetching from ${HN_ALGOLIA_BASE}`,
      );
      return;
    }

    // ── 3. Collect raw signals from HN ───────────────────────────────────────
    const rawSignals: RawSignal[] = [];

    // Use the top 3 keywords to avoid overly broad queries
    const queryKeywords = keywords.slice(0, 3);

    for (const keyword of queryKeywords) {
      try {
        // Search for Ask HN and Show HN posts
        const askHnSignals = await this.fetchHNPosts(keyword, "ask_hn");
        const showHnSignals = await this.fetchHNPosts(keyword, "show_hn");

        rawSignals.push(...askHnSignals, ...showHnSignals);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[hn-scraper] Failed to fetch HN posts for keyword "${keyword}": ${msg}`,
        );
      }
    }

    // Also search for general story posts matching the problem space
    try {
      const problemKeyword = project.problemStatement.split(" ").slice(0, 3).join(" ");
      const storySignals = await this.fetchHNPosts(problemKeyword, "story");
      rawSignals.push(...storySignals);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[hn-scraper] Failed to fetch general HN stories: ${msg}`,
      );
    }

    if (rawSignals.length === 0) {
      console.log(`[hn-scraper] No signals found for project ${projectId}`);
      return;
    }

    // Deduplicate by sourceUrl within this batch
    const seen = new Set<string>();
    const uniqueSignals = rawSignals.filter((s) => {
      if (seen.has(s.sourceUrl)) return false;
      seen.add(s.sourceUrl);
      return true;
    });

    console.log(
      `[hn-scraper] Found ${uniqueSignals.length} unique raw signals for project ${projectId}`,
    );

    // ── 4. Classify and insert signals ───────────────────────────────────────
    let insertedCount = 0;

    for (const raw of uniqueSignals) {
      try {
        // Classify the signal via OpenAI
        const classification = await classifySignal({
          content: raw.content,
          icpDescription: project.icpDescription,
          problemStatement: project.problemStatement,
          competitorNames: project.competitorNames,
        });

        // Insert with ON CONFLICT DO NOTHING for deduplication
        const result = await db
          .insert(signals)
          .values({
            projectId,
            source: "hn",
            signalType: classification.signalType,
            signalKind: "passive",
            content: raw.content,
            sourceUrl: raw.sourceUrl,
            author: raw.author,
            relevanceScore: classification.relevanceScore,
            sentiment: classification.sentiment,
            status: "pending_embedding",
            metadata: raw.metadata,
          })
          .onConflictDoNothing()
          .returning({ id: signals.id });

        if (result.length > 0) {
          insertedCount++;
          const signalId = result[0].id;

          // Enqueue embed-signal job for the newly inserted signal
          await embedSignalQueue.add(
            "embed-signal",
            { signalId, projectId },
            { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
          );
        }
      } catch (insertErr) {
        const msg =
          insertErr instanceof Error ? insertErr.message : String(insertErr);
        console.error(
          `[hn-scraper] Failed to insert signal from ${raw.sourceUrl}: ${msg}`,
        );
      }
    }

    console.log(
      `[hn-scraper] Inserted ${insertedCount} new signals for project ${projectId} ` +
        `(${uniqueSignals.length - insertedCount} duplicates skipped)`,
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Fetch HN posts from the Algolia API matching a keyword and post type.
   * Also fetches top comments for each post.
   */
  private async fetchHNPosts(
    keyword: string,
    postType: "ask_hn" | "show_hn" | "story",
  ): Promise<RawSignal[]> {
    const params = new URLSearchParams({
      query: keyword,
      tags: postType,
      hitsPerPage: String(MAX_POSTS_PER_QUERY),
      // Only fetch posts from the last 7 days
      numericFilters: `created_at_i>${Math.floor(Date.now() / 1000) - 7 * 24 * 3600}`,
    });

    const url = `${HN_ALGOLIA_BASE}/search?${params.toString()}`;
    const response = await this.fetchWithBackoff(url);
    const data = (await response.json()) as AlgoliaSearchResponse;

    const rawSignals: RawSignal[] = [];

    for (const hit of data.hits) {
      if ((hit.points ?? 0) < MIN_POST_POINTS) continue;

      const postContent = [hit.title, hit.story_text]
        .filter(Boolean)
        .join("\n\n")
        .trim();

      if (!postContent) continue;

      const postUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;

      rawSignals.push({
        content: postContent,
        sourceUrl: postUrl,
        author: hit.author,
        metadata: {
          hnId: hit.objectID,
          points: hit.points ?? 0,
          numComments: hit.num_comments ?? 0,
          type: postType,
          createdAt: hit.created_at,
        },
      });

      // Fetch comments for this post
      try {
        const commentSignals = await this.fetchHNComments(
          hit.objectID,
          postUrl,
        );
        rawSignals.push(...commentSignals);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[hn-scraper] Failed to fetch comments for HN item ${hit.objectID}: ${msg}`,
        );
      }
    }

    return rawSignals;
  }

  /**
   * Fetch top-level comments for a HN post using the Algolia items API.
   */
  private async fetchHNComments(
    itemId: string,
    postUrl: string,
  ): Promise<RawSignal[]> {
    const url = `${HN_ALGOLIA_BASE}/items/${itemId}`;
    const response = await this.fetchWithBackoff(url);
    const data = (await response.json()) as AlgoliaItemResponse;

    const rawSignals: RawSignal[] = [];
    const children = data.children ?? [];

    for (const comment of children.slice(0, MAX_COMMENTS_PER_POST)) {
      if (!comment.text || comment.text.length < 20) continue;

      // Strip HTML tags from comment text
      const cleanText = comment.text
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (cleanText.length < 20) continue;

      rawSignals.push({
        content: cleanText,
        sourceUrl: `${postUrl}&comment=${comment.id}`,
        author: comment.author,
        metadata: {
          hnId: String(comment.id),
          parentId: itemId,
          type: "comment",
          createdAt: comment.created_at,
        },
      });
    }

    return rawSignals;
  }
}

// ── Worker instance ───────────────────────────────────────────────────────────

const scraperInstance = new HNScraper();

/**
 * The BullMQ worker for the `hn-scraper` queue.
 * Export this so `src/workers/index.ts` can register it.
 */
export const hnScraperWorker = scraperInstance.createWorker(hnScraperQueue, 1);

// ── Repeatable job registration ───────────────────────────────────────────────

/**
 * scheduleHNScraper
 *
 * Registers a repeatable BullMQ job for the given project on the
 * `hn-scraper` queue. Safe to call multiple times — BullMQ deduplicates
 * repeatable jobs by their repeat key.
 *
 * @param projectId  The project to scrape for.
 */
export async function scheduleHNScraper(projectId: string): Promise<void> {
  await hnScraperQueue.add(
    "hn-scraper",
    { projectId },
    {
      ...SCRAPER_JOB_OPTIONS,
      repeat: {
        every: REPEAT_EVERY_MS,
        key: `hn-scraper:${projectId}`,
      },
      jobId: `hn-scraper:${projectId}`,
    },
  );

  console.log(
    `[hn-scraper] Scheduled repeatable job for project ${projectId} (every 2h)`,
  );
}
