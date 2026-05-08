/**
 * base-scraper.ts
 *
 * Abstract base class for all BullMQ scraper workers.
 *
 * Provides:
 * - Exponential backoff: initial 60 s delay, doubling on each retry, max 1 hour.
 * - `Retry-After` header handling: when a fetch returns 429, the delay is taken
 *   from the `Retry-After` header (if present) rather than the default backoff.
 * - robots.txt compliance: every URL is checked against the site's robots.txt
 *   before fetching.
 * - `isProjectSuspended` guard: jobs for suspended/archived projects are skipped.
 *
 * Requirements: 23.4, 23.5
 */

import { Worker, type Job, type Queue } from "bullmq";
import { redisConnection, type ScraperJobData } from "@/lib/queues";
import { isProjectSuspended } from "@/lib/project-lifecycle";
import { isAllowed, DEFAULT_USER_AGENT } from "./robots-checker";

// ─── Backoff constants ────────────────────────────────────────────────────────

/** Initial retry delay in milliseconds (60 seconds). */
const INITIAL_BACKOFF_MS = 60_000;

/** Maximum retry delay in milliseconds (1 hour). */
const MAX_BACKOFF_MS = 3_600_000;

// ─── Custom error types ───────────────────────────────────────────────────────

/**
 * ScraperError
 *
 * Thrown by `fetchWithBackoff` when the remote server returns a 429 response.
 * The `retryAfterMs` field carries the delay (in milliseconds) that BullMQ
 * should wait before retrying the job.
 *
 * When `retryAfterMs` is undefined the standard exponential backoff applies.
 */
export class ScraperError extends Error {
  /** Delay in milliseconds before the job should be retried. */
  public readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ScraperError";
    this.retryAfterMs = retryAfterMs;
  }
}

// ─── BullMQ backoff function ──────────────────────────────────────────────────

/**
 * Custom BullMQ backoff function.
 *
 * Returns the delay (in ms) for the given attempt number:
 *   delay = min(60_000 * 2^(attemptsMade - 1), 3_600_000)
 *
 * Examples:
 *   attempt 1 →  60 s
 *   attempt 2 → 120 s
 *   attempt 3 → 240 s
 *   attempt 4 → 480 s
 *   attempt 5 → 960 s  (capped at 3600 s for higher attempts)
 *
 * Requirements: 23.5
 */
export function scraperBackoff(attemptsMade: number): number {
  return Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attemptsMade - 1), MAX_BACKOFF_MS);
}

// ─── Default job options for scraper queues ───────────────────────────────────

/**
 * Default BullMQ job options applied to all scraper jobs.
 * Subclasses may override these when enqueuing jobs.
 */
export const SCRAPER_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: "custom" as const,
  },
} as const;

// ─── Abstract base class ──────────────────────────────────────────────────────

/**
 * BaseScraper
 *
 * Abstract base class that all scraper workers extend.
 *
 * Subclasses must implement:
 *   - `scrape(job: Job<ScraperJobData>): Promise<void>`
 *
 * The base class handles:
 *   - Suspended-project guard (skips the job if the project is archived).
 *   - robots.txt compliance via `checkRobots()`.
 *   - HTTP fetching with 429 / 5xx handling via `fetchWithBackoff()`.
 *   - Exponential backoff wiring for BullMQ.
 */
export abstract class BaseScraper {
  /** Human-readable name used in log messages. */
  protected readonly workerName: string;

  constructor(workerName: string) {
    this.workerName = workerName;
  }

  // ── Abstract interface ──────────────────────────────────────────────────────

  /**
   * Perform the actual scraping work for a single job.
   * Subclasses implement this method; the base class calls it after running
   * the suspended-project guard.
   */
  abstract scrape(job: Job<ScraperJobData>): Promise<void>;

  // ── Worker factory ──────────────────────────────────────────────────────────

  /**
   * createWorker
   *
   * Creates and returns a BullMQ Worker bound to the given queue.
   * The worker wraps `scrape()` with the suspended-project guard and
   * registers standard event listeners for logging.
   *
   * @param queue       The BullMQ Queue this worker should consume from.
   * @param concurrency Number of concurrent jobs (default: 1).
   */
  createWorker(queue: Queue<ScraperJobData>, concurrency = 1): Worker<ScraperJobData> {
    const worker = new Worker<ScraperJobData>(
      queue.name,
      async (job: Job<ScraperJobData>) => {
        const { projectId } = job.data;

        // ── Suspended-project guard ──────────────────────────────────────────
        const suspended = await isProjectSuspended(projectId);
        if (suspended) {
          console.log(
            `[${this.workerName}] Project ${projectId} is suspended — skipping job ${job.id}`,
          );
          // Return without throwing so BullMQ marks the job as completed (not failed).
          return;
        }

        // ── Delegate to subclass ─────────────────────────────────────────────
        await this.scrape(job);
      },
      {
        connection: redisConnection,
        concurrency,
        // Register the custom backoff function so BullMQ uses it when a job
        // is retried with `backoff: { type: 'custom' }`.
        settings: {
          backoffStrategy: scraperBackoff,
        },
      },
    );

    // ── Standard event listeners ─────────────────────────────────────────────
    worker.on("completed", (job) => {
      console.log(`[${this.workerName}] Job ${job.id} completed`);
    });

    worker.on("failed", (job, error) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[${this.workerName}] Job ${job?.id} failed: ${msg}`);
    });

    worker.on("error", (error) => {
      console.error(`[${this.workerName}] Worker error: ${error.message}`);
    });

    return worker;
  }

  // ── robots.txt helper ───────────────────────────────────────────────────────

  /**
   * checkRobots
   *
   * Returns true if the given URL is allowed by the site's robots.txt.
   * Logs a warning and returns false if the URL is disallowed.
   *
   * Requirements: 23.4
   */
  protected async checkRobots(
    url: string,
    userAgent: string = DEFAULT_USER_AGENT,
  ): Promise<boolean> {
    const allowed = await isAllowed(url, userAgent);
    if (!allowed) {
      console.warn(
        `[${this.workerName}] robots.txt disallows fetching ${url} — skipping`,
      );
    }
    return allowed;
  }

  // ── HTTP helper ─────────────────────────────────────────────────────────────

  /**
   * fetchWithBackoff
   *
   * Fetches the given URL and handles rate-limit and server-error responses:
   *
   * - **200–299**: Returns the Response object.
   * - **429 (Too Many Requests)**: Reads the `Retry-After` header (seconds or
   *   HTTP-date) and throws a `ScraperError` with `retryAfterMs` set.
   *   BullMQ will re-queue the job after that delay.
   * - **5xx**: Throws a plain `Error` so BullMQ retries with the standard
   *   exponential backoff.
   * - **Other 4xx**: Throws a plain `Error` (not retried by default).
   *
   * Does NOT check robots.txt — call `checkRobots()` before this method.
   *
   * Requirements: 23.4, 23.5
   *
   * @param url     The URL to fetch.
   * @param options Optional `fetch` RequestInit options.
   * @returns       The successful Response object.
   */
  protected async fetchWithBackoff(
    url: string,
    options?: RequestInit,
  ): Promise<Response> {
    const mergedOptions: RequestInit = {
      ...options,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        ...(options?.headers as Record<string, string> | undefined),
      },
    };

    const response = await fetch(url, mergedOptions);

    if (response.ok) {
      return response;
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      throw new ScraperError(
        `Rate limited by ${url} (HTTP 429)`,
        retryAfterMs,
      );
    }

    if (response.status >= 500) {
      throw new Error(
        `Server error from ${url}: HTTP ${response.status} ${response.statusText}`,
      );
    }

    // Other 4xx — not retried
    throw new Error(
      `Unexpected response from ${url}: HTTP ${response.status} ${response.statusText}`,
    );
  }
}

// ─── Retry-After header parser ────────────────────────────────────────────────

/**
 * parseRetryAfter
 *
 * Parses the value of a `Retry-After` HTTP header and returns the delay in
 * milliseconds.
 *
 * The header can be:
 * - A non-negative integer (number of seconds to wait).
 * - An HTTP-date string (absolute point in time).
 *
 * Returns `undefined` if the header is absent or cannot be parsed, in which
 * case the caller should fall back to the standard exponential backoff.
 */
export function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;

  const trimmed = headerValue.trim();

  // Try parsing as a plain integer (seconds)
  const seconds = Number(trimmed);
  if (!isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  // Try parsing as an HTTP-date
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return delayMs > 0 ? delayMs : 0;
  }

  return undefined;
}
