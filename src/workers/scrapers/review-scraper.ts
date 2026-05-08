/**
 * review-scraper.ts
 *
 * BullMQ worker that scrapes competitor reviews from G2, Trustpilot, Product Hunt,
 * Apple App Store, and Google Play Store.
 *
 * Schedule: every 7 days (repeatable job per project).
 *
 * Flow:
 * 1. Load project competitor names from the database.
 * 2. For each competitor, scrape reviews from each review platform.
 * 3. Classify each review via OpenAI (signal type + relevance score).
 * 4. Flag reviews classified as negative_sentiment or competitor_mention as
 *    `is_opportunity = true` (Requirement 6.4).
 * 5. Bulk INSERT ... ON CONFLICT DO NOTHING for deduplication.
 * 6. Enqueue `embed-signal` jobs for newly inserted signals.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { signals } from "@/db/schema/signals";
import {
  reviewScraperQueue,
  embedSignalQueue,
  type ScraperJobData,
} from "@/lib/queues";
import { SCRAPER_JOB_OPTIONS, BaseScraper } from "./base-scraper";
import { classifySignal, type SignalType } from "./signal-classifier";

// ── Constants ─────────────────────────────────────────────────────────────────

/** How often the repeatable job runs (7 days in milliseconds). */
const REPEAT_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum reviews to collect per competitor per platform. */
const MAX_REVIEWS_PER_PLATFORM = 20;

/** Minimum review text length to consider worth classifying. */
const MIN_REVIEW_LENGTH = 20;

/** Signal types that should be flagged as opportunities. */
const OPPORTUNITY_SIGNAL_TYPES = new Set<SignalType>([
  "negative_sentiment",
  "competitor_mention",
]);

// ── Helper types ──────────────────────────────────────────────────────────────

interface RawSignal {
  content: string;
  sourceUrl: string;
  author: string;
  metadata: Record<string, unknown>;
}

// ── Review scraper implementation ─────────────────────────────────────────────

class ReviewScraper extends BaseScraper {
  constructor() {
    super("review-scraper");
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
      console.warn(`[review-scraper] Project ${projectId} not found — skipping`);
      return;
    }

    const competitorNames = project.competitorNames ?? [];

    if (competitorNames.length === 0) {
      console.log(
        `[review-scraper] Project ${projectId} has no competitors defined — skipping`,
      );
      return;
    }

    // ── 2. Collect raw signals from all review platforms ─────────────────────
    const rawSignals: RawSignal[] = [];

    for (const competitor of competitorNames) {
      console.log(
        `[review-scraper] Scraping reviews for competitor "${competitor}" (project ${projectId})`,
      );

      // Scrape each platform in parallel with error isolation
      const platformResults = await Promise.allSettled([
        this.scrapeG2(competitor),
        this.scrapeTrustpilot(competitor),
        this.scrapeProductHunt(competitor),
        this.scrapeAppStore(competitor),
        this.scrapePlayStore(competitor),
      ]);

      for (const result of platformResults) {
        if (result.status === "fulfilled") {
          rawSignals.push(...result.value);
        } else {
          console.warn(
            `[review-scraper] Platform scrape failed for "${competitor}": ${result.reason}`,
          );
        }
      }
    }

    if (rawSignals.length === 0) {
      console.log(`[review-scraper] No reviews found for project ${projectId}`);
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
      `[review-scraper] Found ${uniqueSignals.length} unique reviews for project ${projectId}`,
    );

    // ── 3. Classify and insert signals ───────────────────────────────────────
    let insertedCount = 0;
    let opportunityCount = 0;

    for (const raw of uniqueSignals) {
      try {
        // Classify the signal via OpenAI
        const classification = await classifySignal({
          content: raw.content,
          icpDescription: project.icpDescription,
          problemStatement: project.problemStatement,
          competitorNames: project.competitorNames,
        });

        // Flag as opportunity if negative_sentiment or competitor_mention (Requirement 6.4)
        const isOpportunity = OPPORTUNITY_SIGNAL_TYPES.has(classification.signalType);

        if (isOpportunity) {
          opportunityCount++;
        }

        // Insert with ON CONFLICT DO NOTHING for deduplication
        const result = await db
          .insert(signals)
          .values({
            projectId,
            source: "review",
            signalType: classification.signalType,
            signalKind: "passive",
            content: raw.content,
            sourceUrl: raw.sourceUrl,
            author: raw.author,
            relevanceScore: classification.relevanceScore,
            sentiment: classification.sentiment,
            isOpportunity,
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
          `[review-scraper] Failed to insert signal from ${raw.sourceUrl}: ${msg}`,
        );
      }
    }

    console.log(
      `[review-scraper] Inserted ${insertedCount} new signals for project ${projectId} ` +
        `(${opportunityCount} flagged as opportunities, ` +
        `${uniqueSignals.length - insertedCount} duplicates skipped)`,
    );
  }

  // ── Platform scrapers ───────────────────────────────────────────────────────

  /**
   * Scrape G2 reviews for a competitor.
   * G2 has public review pages accessible without login.
   */
  private async scrapeG2(competitor: string): Promise<RawSignal[]> {
    const slug = this.toSlug(competitor);
    const url = `https://www.g2.com/products/${slug}/reviews`;

    const allowed = await this.checkRobots(url);
    if (!allowed) {
      console.warn(`[review-scraper] robots.txt disallows G2 scraping for ${competitor}`);
      return [];
    }

    try {
      const response = await this.fetchWithBackoff(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const html = await response.text();
      return this.parseG2Reviews(html, competitor, url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[review-scraper] G2 scrape failed for "${competitor}": ${msg}`);
      return [];
    }
  }

  /**
   * Parse G2 review HTML and extract review content.
   */
  private parseG2Reviews(
    html: string,
    competitor: string,
    baseUrl: string,
  ): RawSignal[] {
    const rawSignals: RawSignal[] = [];

    // Extract review blocks using regex patterns for G2's HTML structure
    // G2 review content is in elements with class "formatted-text" or similar
    const reviewPattern =
      /<div[^>]*class="[^"]*formatted-text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    const ratingPattern = /data-rating="(\d+(?:\.\d+)?)"/i;
    const reviewerPattern = /class="[^"]*reviewer-name[^"]*"[^>]*>([^<]+)</i;

    let match: RegExpExecArray | null;
    let count = 0;

    while ((match = reviewPattern.exec(html)) !== null && count < MAX_REVIEWS_PER_PLATFORM) {
      const rawText = match[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();

      if (rawText.length < MIN_REVIEW_LENGTH) continue;

      // Try to extract rating from surrounding context
      const contextStart = Math.max(0, match.index - 500);
      const context = html.slice(contextStart, match.index + match[0].length + 200);
      const ratingMatch = ratingPattern.exec(context);
      const reviewerMatch = reviewerPattern.exec(context);

      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
      const reviewer = reviewerMatch ? reviewerMatch[1].trim() : "G2 Reviewer";

      rawSignals.push({
        content: `G2 Review of ${competitor}: ${rawText}`,
        sourceUrl: `${baseUrl}#review-${count + 1}`,
        author: reviewer,
        metadata: {
          platform: "g2",
          competitor,
          rating,
          type: "review",
          scrapedAt: new Date().toISOString(),
        },
      });

      count++;
    }

    return rawSignals;
  }

  /**
   * Scrape Trustpilot reviews for a competitor.
   */
  private async scrapeTrustpilot(competitor: string): Promise<RawSignal[]> {
    const slug = this.toSlug(competitor);
    const url = `https://www.trustpilot.com/review/${slug}.com`;

    const allowed = await this.checkRobots(url);
    if (!allowed) {
      console.warn(`[review-scraper] robots.txt disallows Trustpilot scraping for ${competitor}`);
      return [];
    }

    try {
      const response = await this.fetchWithBackoff(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const html = await response.text();
      return this.parseTrustpilotReviews(html, competitor, url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[review-scraper] Trustpilot scrape failed for "${competitor}": ${msg}`);
      return [];
    }
  }

  /**
   * Parse Trustpilot review HTML.
   */
  private parseTrustpilotReviews(
    html: string,
    competitor: string,
    baseUrl: string,
  ): RawSignal[] {
    const rawSignals: RawSignal[] = [];

    // Trustpilot embeds review data in JSON-LD or data attributes
    // Extract review text from <p> tags within review sections
    const reviewPattern =
      /<p[^>]*data-service-review-text-typography[^>]*>([\s\S]*?)<\/p>/gi;
    const ratingPattern = /data-service-review-rating="(\d+)"/i;
    const consumerPattern =
      /<span[^>]*data-consumer-name-typography[^>]*>([^<]+)<\/span>/i;

    let match: RegExpExecArray | null;
    let count = 0;

    while ((match = reviewPattern.exec(html)) !== null && count < MAX_REVIEWS_PER_PLATFORM) {
      const rawText = match[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();

      if (rawText.length < MIN_REVIEW_LENGTH) continue;

      const contextStart = Math.max(0, match.index - 1000);
      const context = html.slice(contextStart, match.index + match[0].length + 200);
      const ratingMatch = ratingPattern.exec(context);
      const consumerMatch = consumerPattern.exec(context);

      const rating = ratingMatch ? parseInt(ratingMatch[1], 10) : null;
      const reviewer = consumerMatch ? consumerMatch[1].trim() : "Trustpilot Reviewer";

      rawSignals.push({
        content: `Trustpilot Review of ${competitor}: ${rawText}`,
        sourceUrl: `${baseUrl}#review-${count + 1}`,
        author: reviewer,
        metadata: {
          platform: "trustpilot",
          competitor,
          rating,
          type: "review",
          scrapedAt: new Date().toISOString(),
        },
      });

      count++;
    }

    return rawSignals;
  }

  /**
   * Scrape Product Hunt reviews/comments for a competitor.
   */
  private async scrapeProductHunt(competitor: string): Promise<RawSignal[]> {
    const slug = this.toSlug(competitor);
    const url = `https://www.producthunt.com/products/${slug}/reviews`;

    const allowed = await this.checkRobots(url);
    if (!allowed) {
      console.warn(`[review-scraper] robots.txt disallows Product Hunt scraping for ${competitor}`);
      return [];
    }

    try {
      const response = await this.fetchWithBackoff(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const html = await response.text();
      return this.parseProductHuntReviews(html, competitor, url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[review-scraper] Product Hunt scrape failed for "${competitor}": ${msg}`);
      return [];
    }
  }

  /**
   * Parse Product Hunt review HTML.
   */
  private parseProductHuntReviews(
    html: string,
    competitor: string,
    baseUrl: string,
  ): RawSignal[] {
    const rawSignals: RawSignal[] = [];

    // Product Hunt review content is in structured sections
    // Look for review body text in common patterns
    const reviewPattern =
      /<div[^>]*class="[^"]*styles_body[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;

    let match: RegExpExecArray | null;
    let count = 0;

    while ((match = reviewPattern.exec(html)) !== null && count < MAX_REVIEWS_PER_PLATFORM) {
      const rawText = match[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();

      if (rawText.length < MIN_REVIEW_LENGTH) continue;

      rawSignals.push({
        content: `Product Hunt Review of ${competitor}: ${rawText}`,
        sourceUrl: `${baseUrl}#review-${count + 1}`,
        author: "Product Hunt User",
        metadata: {
          platform: "product_hunt",
          competitor,
          type: "review",
          scrapedAt: new Date().toISOString(),
        },
      });

      count++;
    }

    return rawSignals;
  }

  /**
   * Scrape Apple App Store reviews for a competitor app.
   * Uses the iTunes Search API to find the app, then the RSS feed for reviews.
   */
  private async scrapeAppStore(competitor: string): Promise<RawSignal[]> {
    try {
      // Step 1: Find the app ID via iTunes Search API
      const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(competitor)}&entity=software&limit=1&country=us`;

      const allowed = await this.checkRobots("https://itunes.apple.com");
      if (!allowed) {
        return [];
      }

      const searchResponse = await this.fetchWithBackoff(searchUrl);
      const searchData = (await searchResponse.json()) as {
        results?: Array<{ trackId: number; trackName: string }>;
      };

      if (!searchData.results || searchData.results.length === 0) {
        return [];
      }

      const appId = searchData.results[0].trackId;
      const appName = searchData.results[0].trackName;

      // Step 2: Fetch reviews via the RSS feed
      const reviewsUrl = `https://itunes.apple.com/us/rss/customerreviews/id=${appId}/sortBy=mostRecent/json`;
      const reviewsResponse = await this.fetchWithBackoff(reviewsUrl);
      const reviewsData = (await reviewsResponse.json()) as {
        feed?: {
          entry?: Array<{
            id?: { label?: string };
            title?: { label?: string };
            content?: { label?: string };
            "im:rating"?: { label?: string };
            author?: { name?: { label?: string } };
          }>;
        };
      };

      const entries = reviewsData.feed?.entry ?? [];
      const rawSignals: RawSignal[] = [];

      for (const entry of entries.slice(0, MAX_REVIEWS_PER_PLATFORM)) {
        const title = entry.title?.label ?? "";
        const body = entry.content?.label ?? "";
        const rating = entry["im:rating"]?.label;
        const author = entry.author?.name?.label ?? "App Store User";
        const reviewId = entry.id?.label ?? "";

        const content = [title, body].filter(Boolean).join(": ");
        if (content.length < MIN_REVIEW_LENGTH) continue;

        rawSignals.push({
          content: `App Store Review of ${appName} (${competitor}): ${content}`,
          sourceUrl: `https://apps.apple.com/us/app/id${appId}#review-${reviewId}`,
          author,
          metadata: {
            platform: "app_store",
            competitor,
            appId,
            appName,
            rating: rating ? parseInt(rating, 10) : null,
            type: "review",
            scrapedAt: new Date().toISOString(),
          },
        });
      }

      return rawSignals;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[review-scraper] App Store scrape failed for "${competitor}": ${msg}`);
      return [];
    }
  }

  /**
   * Scrape Google Play Store reviews for a competitor app.
   * Uses the public Play Store web page.
   */
  private async scrapePlayStore(competitor: string): Promise<RawSignal[]> {
    try {
      // Search for the app on Play Store
      const searchUrl = `https://play.google.com/store/search?q=${encodeURIComponent(competitor)}&c=apps&hl=en`;

      const allowed = await this.checkRobots("https://play.google.com");
      if (!allowed) {
        return [];
      }

      const searchResponse = await this.fetchWithBackoff(searchUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const searchHtml = await searchResponse.text();

      // Extract app ID from search results
      const appIdMatch = searchHtml.match(/\/store\/apps\/details\?id=([\w.]+)/);
      if (!appIdMatch) {
        return [];
      }

      const appId = appIdMatch[1];
      const appPageUrl = `https://play.google.com/store/apps/details?id=${appId}&hl=en`;

      const appResponse = await this.fetchWithBackoff(appPageUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const appHtml = await appResponse.text();
      return this.parsePlayStoreReviews(appHtml, competitor, appId, appPageUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[review-scraper] Play Store scrape failed for "${competitor}": ${msg}`);
      return [];
    }
  }

  /**
   * Parse Google Play Store review HTML.
   */
  private parsePlayStoreReviews(
    html: string,
    competitor: string,
    appId: string,
    baseUrl: string,
  ): RawSignal[] {
    const rawSignals: RawSignal[] = [];

    // Play Store embeds review data in JSON within script tags
    // Look for review snippets in the structured data
    const jsonPattern = /\[\[null,null,"([^"]{20,})",null,\[(\d+)\]/g;

    let match: RegExpExecArray | null;
    let count = 0;

    while ((match = jsonPattern.exec(html)) !== null && count < MAX_REVIEWS_PER_PLATFORM) {
      const reviewText = match[1]
        .replace(/\\n/g, " ")
        .replace(/\\"/g, '"')
        .replace(/\s+/g, " ")
        .trim();

      const rating = parseInt(match[2], 10);

      if (reviewText.length < MIN_REVIEW_LENGTH) continue;
      if (isNaN(rating) || rating < 1 || rating > 5) continue;

      rawSignals.push({
        content: `Google Play Review of ${competitor}: ${reviewText}`,
        sourceUrl: `${baseUrl}#review-${count + 1}`,
        author: "Play Store User",
        metadata: {
          platform: "play_store",
          competitor,
          appId,
          rating,
          type: "review",
          scrapedAt: new Date().toISOString(),
        },
      });

      count++;
    }

    return rawSignals;
  }

  // ── Utility helpers ─────────────────────────────────────────────────────────

  /**
   * Convert a competitor name to a URL slug.
   * e.g. "Acme Corp" → "acme-corp"
   */
  private toSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
}

// ── Worker instance ───────────────────────────────────────────────────────────

const scraperInstance = new ReviewScraper();

/**
 * The BullMQ worker for the `review-scraper` queue.
 * Export this so `src/workers/index.ts` can register it.
 */
export const reviewScraperWorker = scraperInstance.createWorker(
  reviewScraperQueue,
  1,
);

// ── Repeatable job registration ───────────────────────────────────────────────

/**
 * scheduleReviewScraper
 *
 * Registers a repeatable BullMQ job for the given project on the
 * `review-scraper` queue. Safe to call multiple times — BullMQ deduplicates
 * repeatable jobs by their repeat key.
 *
 * @param projectId  The project to scrape for.
 */
export async function scheduleReviewScraper(projectId: string): Promise<void> {
  await reviewScraperQueue.add(
    "review-scraper",
    { projectId },
    {
      ...SCRAPER_JOB_OPTIONS,
      repeat: {
        every: REPEAT_EVERY_MS,
        key: `review-scraper:${projectId}`,
      },
      jobId: `review-scraper:${projectId}`,
    },
  );

  console.log(
    `[review-scraper] Scheduled repeatable job for project ${projectId} (every 7d)`,
  );
}
