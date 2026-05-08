/**
 * linkedin-scraper.ts
 *
 * BullMQ worker that scrapes LinkedIn for market signals relevant to a project.
 *
 * Schedule: every 24 hours (repeatable job per project).
 *
 * Uses Playwright (headless Chromium) to scrape public LinkedIn posts, articles,
 * and job postings matching the project's ICP and problem space.
 *
 * Flow:
 * 1. Load project keywords, ICP description, and competitor names from the database.
 * 2. Use Playwright to search LinkedIn for public posts and articles.
 * 3. Scrape job postings from companies matching the project's ICP as hiring signals.
 * 4. Classify each item via OpenAI (signal type + relevance score).
 * 5. Bulk INSERT ... ON CONFLICT DO NOTHING for deduplication.
 * 6. Enqueue `embed-signal` jobs for newly inserted signals.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 *
 * NOTE: LinkedIn scraping is done on public pages only (no login required).
 * The scraper respects robots.txt and rate limits per Requirement 23.4.
 */

import { type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { signals } from "@/db/schema/signals";
import {
  linkedinScraperQueue,
  embedSignalQueue,
  type ScraperJobData,
} from "@/lib/queues";
import { SCRAPER_JOB_OPTIONS, BaseScraper } from "./base-scraper";
import { classifySignal } from "./signal-classifier";

// ── Constants ─────────────────────────────────────────────────────────────────

/** How often the repeatable job runs (24 hours in milliseconds). */
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000;

/** LinkedIn base URL. */
const LINKEDIN_BASE = "https://www.linkedin.com";

/** Maximum posts to collect per keyword search. */
const MAX_POSTS_PER_KEYWORD = 10;

/** Maximum job postings to collect per competitor/ICP company. */
const MAX_JOBS_PER_COMPANY = 5;

/** Maximum number of keywords to search for. */
const MAX_KEYWORDS = 3;

/** Minimum content length to consider worth classifying. */
const MIN_CONTENT_LENGTH = 30;

/** Delay between page navigations to avoid rate limiting (ms). */
const NAV_DELAY_MS = 2000;

// ── Helper types ──────────────────────────────────────────────────────────────

interface RawSignal {
  content: string;
  sourceUrl: string;
  author: string;
  metadata: Record<string, unknown>;
}

// ── LinkedIn scraper implementation ──────────────────────────────────────────

class LinkedInScraper extends BaseScraper {
  constructor() {
    super("linkedin-scraper");
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
      console.warn(`[linkedin-scraper] Project ${projectId} not found — skipping`);
      return;
    }

    const keywords = project.keywords ?? [];
    const competitorNames = project.competitorNames ?? [];

    if (keywords.length === 0) {
      console.log(
        `[linkedin-scraper] Project ${projectId} has no keywords yet — skipping`,
      );
      return;
    }

    // ── 2. Check robots.txt for LinkedIn ────────────────────────────────────
    const linkedinAllowed = await this.checkRobots(LINKEDIN_BASE);
    if (!linkedinAllowed) {
      console.warn(
        `[linkedin-scraper] robots.txt disallows fetching from ${LINKEDIN_BASE} — skipping`,
      );
      return;
    }

    // ── 3. Collect raw signals via Playwright ────────────────────────────────
    const rawSignals: RawSignal[] = [];

    let browser: import("playwright").Browser | null = null;

    try {
      // Dynamically import Playwright to avoid hard dependency at module load time
      const { chromium } = await import("playwright");

      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
      });

      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (compatible; MarketSignalBot/1.0; +https://marketsignal.io/bot)",
        viewport: { width: 1280, height: 800 },
        // Disable images and fonts to speed up scraping
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      // Block images, fonts, and media to speed up scraping
      await context.route("**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,otf,mp4,mp3}", (route) =>
        route.abort(),
      );

      const page = await context.newPage();

      // ── 3a. Scrape public LinkedIn posts for each keyword ────────────────
      const topKeywords = keywords.slice(0, MAX_KEYWORDS);

      for (const keyword of topKeywords) {
        try {
          const postSignals = await this.scrapeLinkedInPosts(page, keyword);
          rawSignals.push(...postSignals);

          // Polite delay between requests
          await this.delay(NAV_DELAY_MS);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[linkedin-scraper] Failed to scrape posts for keyword "${keyword}": ${msg}`,
          );
        }
      }

      // ── 3b. Scrape job postings for competitor companies ─────────────────
      for (const company of competitorNames.slice(0, 3)) {
        try {
          const jobSignals = await this.scrapeLinkedInJobs(page, company);
          rawSignals.push(...jobSignals);

          await this.delay(NAV_DELAY_MS);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[linkedin-scraper] Failed to scrape jobs for company "${company}": ${msg}`,
          );
        }
      }

      // ── 3c. Scrape job postings matching ICP keywords ────────────────────
      try {
        const icpJobSignals = await this.scrapeLinkedInJobs(
          page,
          topKeywords[0] ?? project.problemStatement.split(" ").slice(0, 3).join(" "),
        );
        rawSignals.push(...icpJobSignals);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[linkedin-scraper] Failed to scrape ICP job postings: ${msg}`,
        );
      }

      await context.close();
    } catch (playwrightErr) {
      const msg =
        playwrightErr instanceof Error ? playwrightErr.message : String(playwrightErr);
      console.error(`[linkedin-scraper] Playwright error: ${msg}`);
      // Don't rethrow — allow the job to complete with whatever signals were collected
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }

    if (rawSignals.length === 0) {
      console.log(`[linkedin-scraper] No signals found for project ${projectId}`);
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
      `[linkedin-scraper] Found ${uniqueSignals.length} unique raw signals for project ${projectId}`,
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
            source: "linkedin",
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
          `[linkedin-scraper] Failed to insert signal from ${raw.sourceUrl}: ${msg}`,
        );
      }
    }

    console.log(
      `[linkedin-scraper] Inserted ${insertedCount} new signals for project ${projectId} ` +
        `(${uniqueSignals.length - insertedCount} duplicates skipped)`,
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Scrape public LinkedIn posts matching a keyword using the public search page.
   * LinkedIn's public search shows posts without requiring login.
   */
  private async scrapeLinkedInPosts(
    page: import("playwright").Page,
    keyword: string,
  ): Promise<RawSignal[]> {
    const searchUrl = `${LINKEDIN_BASE}/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=GLOBAL_SEARCH_HEADER`;

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Wait for search results to load
    await page.waitForTimeout(2000);

    const rawSignals: RawSignal[] = [];

    // Extract post cards from the search results
    // LinkedIn public search shows post previews without login
    const postCards = await page.$$eval(
      '[data-entity-urn], .search-results__list article, .feed-shared-update-v2',
      (elements: Element[]) => {
        return elements.slice(0, 10).map((el) => {
          const textEl = el.querySelector(
            '.feed-shared-text, .search-result__info, p, .break-words',
          );
          const linkEl = el.querySelector('a[href*="/posts/"], a[href*="/pulse/"], a[href*="/feed/update/"]');
          const authorEl = el.querySelector('.actor-name, .feed-shared-actor__name, .app-aware-link');

          return {
            text: textEl?.textContent?.trim() ?? "",
            url: linkEl?.getAttribute("href") ?? "",
            author: authorEl?.textContent?.trim() ?? "LinkedIn User",
          };
        });
      },
    ).catch(() => [] as Array<{ text: string; url: string; author: string }>);

    for (const card of postCards.slice(0, MAX_POSTS_PER_KEYWORD)) {
      if (!card.text || card.text.length < MIN_CONTENT_LENGTH) continue;

      // Normalize the URL
      let sourceUrl = card.url;
      if (sourceUrl && !sourceUrl.startsWith("http")) {
        sourceUrl = `${LINKEDIN_BASE}${sourceUrl}`;
      }

      // Generate a stable URL if none found (use search URL + content hash)
      if (!sourceUrl) {
        const hash = Buffer.from(card.text.slice(0, 100)).toString("base64").slice(0, 16);
        sourceUrl = `${searchUrl}#post-${hash}`;
      }

      rawSignals.push({
        content: card.text,
        sourceUrl,
        author: card.author,
        metadata: {
          type: "post",
          keyword,
          scrapedAt: new Date().toISOString(),
        },
      });
    }

    return rawSignals;
  }

  /**
   * Scrape LinkedIn job postings for a company or keyword.
   * Job postings are public and accessible without login.
   * These serve as hiring/growth signals (Requirement 5.2).
   */
  private async scrapeLinkedInJobs(
    page: import("playwright").Page,
    companyOrKeyword: string,
  ): Promise<RawSignal[]> {
    const jobSearchUrl = `${LINKEDIN_BASE}/jobs/search/?keywords=${encodeURIComponent(companyOrKeyword)}&origin=GLOBAL_SEARCH_HEADER`;

    await page.goto(jobSearchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    await page.waitForTimeout(2000);

    const rawSignals: RawSignal[] = [];

    // Extract job cards from the public jobs search page
    const jobCards = await page.$$eval(
      '.jobs-search__results-list li, .job-search-card, [data-entity-urn*="jobPosting"]',
      (elements: Element[]) => {
        return elements.slice(0, 5).map((el) => {
          const titleEl = el.querySelector('.base-search-card__title, h3, .job-result-card__title');
          const companyEl = el.querySelector('.base-search-card__subtitle, h4, .job-result-card__subtitle');
          const locationEl = el.querySelector('.job-search-card__location, .job-result-card__location');
          const linkEl = el.querySelector('a[href*="/jobs/view/"]');

          const title = titleEl?.textContent?.trim() ?? "";
          const company = companyEl?.textContent?.trim() ?? "";
          const location = locationEl?.textContent?.trim() ?? "";

          return {
            title,
            company,
            location,
            url: linkEl?.getAttribute("href") ?? "",
          };
        });
      },
    ).catch(() => [] as Array<{ title: string; company: string; location: string; url: string }>);

    for (const job of jobCards.slice(0, MAX_JOBS_PER_COMPANY)) {
      if (!job.title || job.title.length < 5) continue;

      // Compose a meaningful content string for classification
      const content = [
        `Job Posting: ${job.title}`,
        job.company ? `Company: ${job.company}` : "",
        job.location ? `Location: ${job.location}` : "",
        `This company is hiring for ${job.title}, indicating growth in this area.`,
      ]
        .filter(Boolean)
        .join("\n");

      let sourceUrl = job.url;
      if (sourceUrl && !sourceUrl.startsWith("http")) {
        sourceUrl = `${LINKEDIN_BASE}${sourceUrl}`;
      }

      if (!sourceUrl) {
        const hash = Buffer.from(content.slice(0, 100)).toString("base64").slice(0, 16);
        sourceUrl = `${jobSearchUrl}#job-${hash}`;
      }

      rawSignals.push({
        content,
        sourceUrl,
        author: job.company || "LinkedIn",
        metadata: {
          type: "job_posting",
          jobTitle: job.title,
          company: job.company,
          location: job.location,
          searchKeyword: companyOrKeyword,
          scrapedAt: new Date().toISOString(),
        },
      });
    }

    return rawSignals;
  }

  /** Simple delay helper. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ── Worker instance ───────────────────────────────────────────────────────────

const scraperInstance = new LinkedInScraper();

/**
 * The BullMQ worker for the `linkedin-scraper` queue.
 * Export this so `src/workers/index.ts` can register it.
 */
export const linkedinScraperWorker = scraperInstance.createWorker(
  linkedinScraperQueue,
  1,
);

// ── Repeatable job registration ───────────────────────────────────────────────

/**
 * scheduleLinkedInScraper
 *
 * Registers a repeatable BullMQ job for the given project on the
 * `linkedin-scraper` queue. Safe to call multiple times — BullMQ deduplicates
 * repeatable jobs by their repeat key.
 *
 * @param projectId  The project to scrape for.
 */
export async function scheduleLinkedInScraper(projectId: string): Promise<void> {
  await linkedinScraperQueue.add(
    "linkedin-scraper",
    { projectId },
    {
      ...SCRAPER_JOB_OPTIONS,
      repeat: {
        every: REPEAT_EVERY_MS,
        key: `linkedin-scraper:${projectId}`,
      },
      jobId: `linkedin-scraper:${projectId}`,
    },
  );

  console.log(
    `[linkedin-scraper] Scheduled repeatable job for project ${projectId} (every 24h)`,
  );
}
