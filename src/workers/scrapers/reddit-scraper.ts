/**
 * reddit-scraper.ts
 *
 * BullMQ worker that scrapes Reddit for market signals relevant to a project.
 *
 * Schedule: every 6 hours (repeatable job per project).
 *
 * Flow:
 * 1. Load project keywords and monitored subreddits from the database.
 * 2. For each subreddit, search for posts matching the project's keywords.
 * 3. Fetch top-level comments for each matching post.
 * 4. Classify each post/comment via OpenAI (signal type + relevance score).
 * 5. Bulk INSERT ... ON CONFLICT DO NOTHING for deduplication.
 * 6. Enqueue `embed-signal` jobs for newly inserted signals.
 *
 * Requirements: 2.1, 2.2, 2.4, 2.5, 2.6
 */

import { type Job } from "bullmq";
import Snoowrap from "snoowrap";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { signals } from "@/db/schema/signals";
import {
  redditScraperQueue,
  embedSignalQueue,
  type ScraperJobData,
} from "@/lib/queues";
import { SCRAPER_JOB_OPTIONS, BaseScraper } from "./base-scraper";
import { classifySignal } from "./signal-classifier";

// ── Constants ─────────────────────────────────────────────────────────────────

/** How often the repeatable job runs (6 hours in milliseconds). */
const REPEAT_EVERY_MS = 6 * 60 * 60 * 1000;

/** Maximum number of posts to fetch per subreddit per run. */
const MAX_POSTS_PER_SUBREDDIT = 25;

/** Maximum number of comments to fetch per post. */
const MAX_COMMENTS_PER_POST = 10;

/** Minimum post score (upvotes) to consider a post worth ingesting. */
const MIN_POST_SCORE = 1;

// ── Snoowrap client factory ───────────────────────────────────────────────────

/**
 * Create a snoowrap client using environment credentials.
 * Throws if required env vars are missing.
 */
function createRedditClient(): Snoowrap {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;

  if (!clientId || !clientSecret || !username || !password) {
    throw new Error(
      "Missing Reddit credentials: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, " +
        "REDDIT_USERNAME, and REDDIT_PASSWORD must all be set",
    );
  }

  return new Snoowrap({
    userAgent: "MarketSignalBot/1.0 (by /u/" + username + ")",
    clientId,
    clientSecret,
    username,
    password,
  });
}

// ── Helper types ──────────────────────────────────────────────────────────────

interface RawSignal {
  content: string;
  sourceUrl: string;
  author: string;
  metadata: Record<string, unknown>;
}

// ── Reddit scraper implementation ─────────────────────────────────────────────

class RedditScraper extends BaseScraper {
  constructor() {
    super("reddit-scraper");
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
      console.warn(
        `[reddit-scraper] Project ${projectId} not found — skipping`,
      );
      return;
    }

    const keywords = project.keywords ?? [];
    const subreddits = project.subredditCandidates ?? [];

    if (keywords.length === 0) {
      console.log(
        `[reddit-scraper] Project ${projectId} has no keywords yet — skipping`,
      );
      return;
    }

    if (subreddits.length === 0) {
      console.log(
        `[reddit-scraper] Project ${projectId} has no subreddits yet — skipping`,
      );
      return;
    }

    // ── 2. Create Reddit client ──────────────────────────────────────────────
    let reddit: Snoowrap;
    try {
      reddit = createRedditClient();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[reddit-scraper] Cannot create Reddit client: ${msg}`);
      throw error;
    }

    // ── 3. Collect raw signals from each subreddit ───────────────────────────
    const rawSignals: RawSignal[] = [];
    const searchQuery = keywords.slice(0, 5).join(" OR ");

    for (const subreddit of subreddits) {
      try {
        // Check robots.txt for the subreddit URL
        const subredditUrl = `https://www.reddit.com/r/${subreddit}`;
        const allowed = await this.checkRobots(subredditUrl);
        if (!allowed) {
          console.log(
            `[reddit-scraper] robots.txt disallows r/${subreddit} — skipping`,
          );
          continue;
        }

        console.log(
          `[reddit-scraper] Searching r/${subreddit} for: ${searchQuery}`,
        );

        // Search for posts in the subreddit matching keywords
        const searchResults = await reddit
          .getSubreddit(subreddit)
          .search({
            query: searchQuery,
            sort: "new",
            time: "week",
            limit: MAX_POSTS_PER_SUBREDDIT,
          });

        for (const post of searchResults) {
          if (post.score < MIN_POST_SCORE) continue;

          // Add the post itself as a signal
          const postContent = [post.title, post.selftext]
            .filter(Boolean)
            .join("\n\n")
            .trim();

          if (postContent) {
            rawSignals.push({
              content: postContent,
              sourceUrl: `https://www.reddit.com${post.permalink}`,
              author: post.author?.name ?? "[deleted]",
              metadata: {
                postId: post.id,
                subreddit,
                score: post.score,
                numComments: post.num_comments,
                type: "post",
              },
            });
          }

          // Fetch top comments for the post
          try {
            const comments = await post.comments.fetchMore({
              amount: MAX_COMMENTS_PER_POST,
            });

            for (const comment of comments) {
              // Skip deleted/removed comments and very short ones
              if (
                !comment.body ||
                comment.body === "[deleted]" ||
                comment.body === "[removed]" ||
                comment.body.length < 20
              ) {
                continue;
              }

              rawSignals.push({
                content: comment.body,
                sourceUrl: `https://www.reddit.com${comment.permalink}`,
                author: comment.author?.name ?? "[deleted]",
                metadata: {
                  commentId: comment.id,
                  postId: post.id,
                  subreddit,
                  score: comment.score,
                  type: "comment",
                },
              });
            }
          } catch (commentErr) {
            const msg =
              commentErr instanceof Error
                ? commentErr.message
                : String(commentErr);
            console.warn(
              `[reddit-scraper] Failed to fetch comments for post ${post.id}: ${msg}`,
            );
          }
        }
      } catch (subredditErr) {
        const msg =
          subredditErr instanceof Error
            ? subredditErr.message
            : String(subredditErr);
        console.warn(
          `[reddit-scraper] Failed to scrape r/${subreddit}: ${msg}`,
        );
      }
    }

    if (rawSignals.length === 0) {
      console.log(
        `[reddit-scraper] No signals found for project ${projectId}`,
      );
      return;
    }

    console.log(
      `[reddit-scraper] Found ${rawSignals.length} raw signals for project ${projectId}`,
    );

    // ── 4. Classify and insert signals ───────────────────────────────────────
    let insertedCount = 0;

    for (const raw of rawSignals) {
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
            source: "reddit",
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
          `[reddit-scraper] Failed to insert signal from ${raw.sourceUrl}: ${msg}`,
        );
      }
    }

    console.log(
      `[reddit-scraper] Inserted ${insertedCount} new signals for project ${projectId} ` +
        `(${rawSignals.length - insertedCount} duplicates skipped)`,
    );
  }
}

// ── Worker instance ───────────────────────────────────────────────────────────

const scraperInstance = new RedditScraper();

/**
 * The BullMQ worker for the `reddit-scraper` queue.
 * Export this so `src/workers/index.ts` can register it.
 */
export const redditScraperWorker = scraperInstance.createWorker(
  redditScraperQueue,
  1,
);

// ── Repeatable job registration ───────────────────────────────────────────────

/**
 * scheduleRedditScraper
 *
 * Registers a repeatable BullMQ job for the given project on the
 * `reddit-scraper` queue. Safe to call multiple times — BullMQ deduplicates
 * repeatable jobs by their repeat key.
 *
 * @param projectId  The project to scrape for.
 */
export async function scheduleRedditScraper(projectId: string): Promise<void> {
  await redditScraperQueue.add(
    "reddit-scraper",
    { projectId },
    {
      ...SCRAPER_JOB_OPTIONS,
      repeat: {
        every: REPEAT_EVERY_MS,
        key: `reddit-scraper:${projectId}`,
      },
      jobId: `reddit-scraper:${projectId}`,
    },
  );

  console.log(
    `[reddit-scraper] Scheduled repeatable job for project ${projectId} (every 6h)`,
  );
}
