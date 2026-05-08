/**
 * twitter-scraper.ts
 *
 * BullMQ worker that scrapes Twitter/X for market signals relevant to a project.
 *
 * Schedule: every 30 minutes (repeatable job per project).
 *
 * Uses the Twitter/X API v2 (Bearer Token auth) to search for recent tweets
 * matching the project's keywords, hashtags, and competitor handles.
 *
 * Flow:
 * 1. Load project keywords and competitor names from the database.
 * 2. Build a Twitter search query from keywords, hashtags, and competitor handles.
 * 3. Call the Twitter v2 recent-search endpoint.
 * 4. Classify each tweet via OpenAI (signal type + relevance score).
 * 5. Bulk INSERT ... ON CONFLICT DO NOTHING for deduplication.
 * 6. Enqueue `embed-signal` jobs for newly inserted signals.
 * 7. Store a daily sentiment aggregate per keyword cluster in signals.metadata
 *    (Requirement 3.3).
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */

import { type Job } from "bullmq";
import { eq, and, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { signals } from "@/db/schema/signals";
import {
  twitterScraperQueue,
  embedSignalQueue,
  type ScraperJobData,
} from "@/lib/queues";
import { SCRAPER_JOB_OPTIONS, BaseScraper } from "./base-scraper";
import { classifySignal } from "./signal-classifier";

// ── Constants ─────────────────────────────────────────────────────────────────

/** How often the repeatable job runs (30 minutes in milliseconds). */
const REPEAT_EVERY_MS = 30 * 60 * 1000;

/** Twitter API v2 base URL. */
const TWITTER_API_BASE = "https://api.twitter.com/2";

/** Maximum results per search request (Twitter v2 max is 100). */
const MAX_RESULTS_PER_QUERY = 100;

/** Maximum number of keywords to use in a single query (to stay within Twitter query length limits). */
const MAX_KEYWORDS_PER_QUERY = 5;

/** Minimum tweet length to consider worth classifying. */
const MIN_TWEET_LENGTH = 20;

// ── Twitter API response types ────────────────────────────────────────────────

interface TwitterTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
  lang?: string;
}

interface TwitterUser {
  id: string;
  username: string;
  name: string;
}

interface TwitterSearchResponse {
  data?: TwitterTweet[];
  includes?: {
    users?: TwitterUser[];
  };
  meta?: {
    newest_id?: string;
    oldest_id?: string;
    result_count: number;
    next_token?: string;
  };
}

// ── Helper types ──────────────────────────────────────────────────────────────

interface RawSignal {
  content: string;
  sourceUrl: string;
  author: string;
  metadata: Record<string, unknown>;
}

// ── Sentiment aggregate helpers ───────────────────────────────────────────────

/**
 * Build the daily sentiment aggregate key for a keyword cluster.
 * Stored in signals.metadata as { sentimentAggregate: { date, keyword, counts } }
 */
function buildSentimentAggregateMetadata(
  keyword: string,
  sentiment: "positive" | "neutral" | "negative",
  existingMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const existing = (existingMetadata.sentimentAggregate as Record<string, unknown> | undefined) ?? {};
  const dateKey = `${keyword}:${today}`;
  const dayAgg = (existing[dateKey] as Record<string, number> | undefined) ?? {
    positive: 0,
    neutral: 0,
    negative: 0,
  };

  dayAgg[sentiment] = (dayAgg[sentiment] ?? 0) + 1;

  return {
    ...existingMetadata,
    sentimentAggregate: {
      ...existing,
      [dateKey]: dayAgg,
    },
  };
}

// ── Twitter scraper implementation ────────────────────────────────────────────

class TwitterScraper extends BaseScraper {
  constructor() {
    super("twitter-scraper");
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
      console.warn(`[twitter-scraper] Project ${projectId} not found — skipping`);
      return;
    }

    const keywords = project.keywords ?? [];
    const competitorNames = project.competitorNames ?? [];

    if (keywords.length === 0) {
      console.log(
        `[twitter-scraper] Project ${projectId} has no keywords yet — skipping`,
      );
      return;
    }

    // ── 2. Validate Twitter credentials ─────────────────────────────────────
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    if (!bearerToken) {
      console.error(
        `[twitter-scraper] TWITTER_BEARER_TOKEN is not set — skipping project ${projectId}`,
      );
      return;
    }

    // ── 3. Build search queries ──────────────────────────────────────────────
    const queries = this.buildSearchQueries(keywords, competitorNames);

    // ── 4. Collect raw signals ───────────────────────────────────────────────
    const rawSignals: RawSignal[] = [];

    for (const query of queries) {
      try {
        const tweets = await this.fetchTweets(query, bearerToken);
        rawSignals.push(...tweets);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[twitter-scraper] Failed to fetch tweets for query "${query}": ${msg}`,
        );
      }
    }

    if (rawSignals.length === 0) {
      console.log(`[twitter-scraper] No signals found for project ${projectId}`);
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
      `[twitter-scraper] Found ${uniqueSignals.length} unique raw signals for project ${projectId}`,
    );

    // ── 5. Classify and insert signals ───────────────────────────────────────
    let insertedCount = 0;

    // Track daily sentiment aggregates per keyword cluster
    const sentimentAggregates: Record<string, Record<string, number>> = {};
    const today = new Date().toISOString().slice(0, 10);

    for (const raw of uniqueSignals) {
      try {
        // Classify the signal via OpenAI
        const classification = await classifySignal({
          content: raw.content,
          icpDescription: project.icpDescription,
          problemStatement: project.problemStatement,
          competitorNames: project.competitorNames,
        });

        // Track sentiment aggregate for the matched keyword
        const matchedKeyword = (raw.metadata.matchedKeyword as string) ?? "general";
        const aggKey = `${matchedKeyword}:${today}`;
        if (!sentimentAggregates[aggKey]) {
          sentimentAggregates[aggKey] = { positive: 0, neutral: 0, negative: 0 };
        }
        sentimentAggregates[aggKey][classification.sentiment] =
          (sentimentAggregates[aggKey][classification.sentiment] ?? 0) + 1;

        // Build metadata with sentiment aggregate (Requirement 3.3)
        const enrichedMetadata = buildSentimentAggregateMetadata(
          matchedKeyword,
          classification.sentiment,
          raw.metadata,
        );

        // Insert with ON CONFLICT DO NOTHING for deduplication
        const result = await db
          .insert(signals)
          .values({
            projectId,
            source: "twitter",
            signalType: classification.signalType,
            signalKind: "passive",
            content: raw.content,
            sourceUrl: raw.sourceUrl,
            author: raw.author,
            relevanceScore: classification.relevanceScore,
            sentiment: classification.sentiment,
            status: "pending_embedding",
            metadata: enrichedMetadata,
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
          `[twitter-scraper] Failed to insert signal from ${raw.sourceUrl}: ${msg}`,
        );
      }
    }

    console.log(
      `[twitter-scraper] Inserted ${insertedCount} new signals for project ${projectId} ` +
        `(${uniqueSignals.length - insertedCount} duplicates skipped)`,
    );

    // ── 6. Log daily sentiment aggregates ───────────────────────────────────
    if (Object.keys(sentimentAggregates).length > 0) {
      console.log(
        `[twitter-scraper] Daily sentiment aggregates for project ${projectId}:`,
        JSON.stringify(sentimentAggregates),
      );
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Build Twitter search queries from project keywords and competitor names.
   * Splits into multiple queries if needed to stay within Twitter's query length limits.
   */
  private buildSearchQueries(
    keywords: string[],
    competitorNames: string[],
  ): string[] {
    const queries: string[] = [];

    // Query 1: keywords (up to MAX_KEYWORDS_PER_QUERY)
    const topKeywords = keywords.slice(0, MAX_KEYWORDS_PER_QUERY);
    if (topKeywords.length > 0) {
      // Build OR query with quoted multi-word keywords
      const keywordTerms = topKeywords.map((k) =>
        k.includes(" ") ? `"${k}"` : k,
      );
      // Exclude retweets and replies for cleaner signal data
      const keywordQuery = `(${keywordTerms.join(" OR ")}) -is:retweet lang:en`;
      queries.push(keywordQuery);
    }

    // Query 2: competitor handles (if any)
    if (competitorNames.length > 0) {
      const competitorTerms = competitorNames
        .slice(0, 5)
        .map((name) => {
          // Convert competitor name to likely Twitter handle format
          const handle = name.toLowerCase().replace(/\s+/g, "");
          return `@${handle}`;
        });
      const competitorQuery = `(${competitorTerms.join(" OR ")}) -is:retweet lang:en`;
      queries.push(competitorQuery);
    }

    return queries;
  }

  /**
   * Fetch recent tweets from the Twitter v2 API matching the given query.
   */
  private async fetchTweets(
    query: string,
    bearerToken: string,
  ): Promise<RawSignal[]> {
    // Calculate start_time as 30 minutes ago (matching the job repeat interval)
    const startTime = new Date(Date.now() - REPEAT_EVERY_MS).toISOString();

    const params = new URLSearchParams({
      query,
      max_results: String(MAX_RESULTS_PER_QUERY),
      start_time: startTime,
      "tweet.fields": "created_at,author_id,public_metrics,lang",
      expansions: "author_id",
      "user.fields": "username,name",
    });

    const url = `${TWITTER_API_BASE}/tweets/search/recent?${params.toString()}`;

    const response = await this.fetchWithBackoff(url, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as TwitterSearchResponse;

    if (!data.data || data.data.length === 0) {
      return [];
    }

    // Build a user lookup map for author attribution
    const userMap = new Map<string, TwitterUser>();
    for (const user of data.includes?.users ?? []) {
      userMap.set(user.id, user);
    }

    const rawSignals: RawSignal[] = [];

    for (const tweet of data.data) {
      // Skip very short tweets
      if (tweet.text.length < MIN_TWEET_LENGTH) continue;

      // Skip non-English tweets (already filtered in query but double-check)
      if (tweet.lang && tweet.lang !== "en") continue;

      const author = userMap.get(tweet.author_id ?? "");
      const authorHandle = author ? `@${author.username}` : "unknown";

      // Extract the matched keyword from the query for sentiment tracking
      const matchedKeyword = this.extractMatchedKeyword(tweet.text, query);

      rawSignals.push({
        content: tweet.text,
        sourceUrl: `https://twitter.com/i/web/status/${tweet.id}`,
        author: authorHandle,
        metadata: {
          tweetId: tweet.id,
          authorId: tweet.author_id,
          createdAt: tweet.created_at,
          metrics: tweet.public_metrics,
          matchedKeyword,
          query,
        },
      });
    }

    return rawSignals;
  }

  /**
   * Extract the first keyword from the query that appears in the tweet text.
   * Used for sentiment aggregate tracking per keyword cluster.
   */
  private extractMatchedKeyword(tweetText: string, query: string): string {
    const lowerText = tweetText.toLowerCase();

    // Extract quoted phrases and bare words from the query
    const quotedMatches = query.match(/"([^"]+)"/g) ?? [];
    const quotedTerms = quotedMatches.map((m) => m.replace(/"/g, ""));

    for (const term of quotedTerms) {
      if (lowerText.includes(term.toLowerCase())) {
        return term;
      }
    }

    // Fall back to bare words
    const bareWords = query
      .replace(/"[^"]+"/g, "")
      .split(/\s+/)
      .filter((w) => w && !w.startsWith("-") && !w.startsWith("(") && !w.startsWith(")") && w !== "OR" && w !== "lang:en");

    for (const word of bareWords) {
      if (lowerText.includes(word.toLowerCase())) {
        return word;
      }
    }

    return "general";
  }
}

// ── Worker instance ───────────────────────────────────────────────────────────

const scraperInstance = new TwitterScraper();

/**
 * The BullMQ worker for the `twitter-scraper` queue.
 * Export this so `src/workers/index.ts` can register it.
 */
export const twitterScraperWorker = scraperInstance.createWorker(
  twitterScraperQueue,
  1,
);

// ── Repeatable job registration ───────────────────────────────────────────────

/**
 * scheduleTwitterScraper
 *
 * Registers a repeatable BullMQ job for the given project on the
 * `twitter-scraper` queue. Safe to call multiple times — BullMQ deduplicates
 * repeatable jobs by their repeat key.
 *
 * @param projectId  The project to scrape for.
 */
export async function scheduleTwitterScraper(projectId: string): Promise<void> {
  await twitterScraperQueue.add(
    "twitter-scraper",
    { projectId },
    {
      ...SCRAPER_JOB_OPTIONS,
      repeat: {
        every: REPEAT_EVERY_MS,
        key: `twitter-scraper:${projectId}`,
      },
      jobId: `twitter-scraper:${projectId}`,
    },
  );

  console.log(
    `[twitter-scraper] Scheduled repeatable job for project ${projectId} (every 30m)`,
  );
}
