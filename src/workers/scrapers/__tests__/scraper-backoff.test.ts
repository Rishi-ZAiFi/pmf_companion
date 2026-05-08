/**
 * Tests for the scraper backoff strategy and Retry-After header parsing.
 *
 * Requirements: 23.5
 */

import { describe, it, expect, vi } from "vitest";

// Mock the modules that have side effects (env validation, Redis connection)
// before importing the module under test.
vi.mock("@/lib/queues", () => ({
  redisConnection: {},
  ScraperJobData: {},
}));

vi.mock("@/lib/project-lifecycle", () => ({
  isProjectSuspended: vi.fn().mockResolvedValue(false),
}));

import { scraperBackoff, parseRetryAfter } from "../base-scraper";

describe("scraperBackoff", () => {
  it("returns 60 seconds for the first attempt", () => {
    expect(scraperBackoff(1)).toBe(60_000);
  });

  it("doubles the delay on each subsequent attempt", () => {
    expect(scraperBackoff(2)).toBe(120_000);
    expect(scraperBackoff(3)).toBe(240_000);
    expect(scraperBackoff(4)).toBe(480_000);
  });

  it("caps the delay at 1 hour (3,600,000 ms)", () => {
    // attempt 6 would be 60_000 * 2^5 = 1,920,000 — still under cap
    expect(scraperBackoff(6)).toBe(1_920_000);
    // attempt 7 would be 60_000 * 2^6 = 3,840,000 — exceeds cap
    expect(scraperBackoff(7)).toBe(3_600_000);
    // Higher attempts stay at the cap
    expect(scraperBackoff(10)).toBe(3_600_000);
    expect(scraperBackoff(100)).toBe(3_600_000);
  });

  it("never returns a value below the initial 60 seconds", () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(scraperBackoff(attempt)).toBeGreaterThanOrEqual(60_000);
    }
  });

  it("never returns a value above 1 hour", () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(scraperBackoff(attempt)).toBeLessThanOrEqual(3_600_000);
    }
  });

  it("is monotonically non-decreasing", () => {
    let prev = 0;
    for (let attempt = 1; attempt <= 15; attempt++) {
      const current = scraperBackoff(attempt);
      expect(current).toBeGreaterThanOrEqual(prev);
      prev = current;
    }
  });
});

describe("parseRetryAfter", () => {
  it("returns undefined for null input", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseRetryAfter("")).toBeUndefined();
  });

  it("parses a plain integer as seconds and converts to milliseconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("60")).toBe(60_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("handles whitespace around the integer value", () => {
    expect(parseRetryAfter("  45  ")).toBe(45_000);
  });

  it("parses a future HTTP-date and returns a positive delay", () => {
    // Set a date 2 minutes in the future
    const futureDate = new Date(Date.now() + 120_000);
    const result = parseRetryAfter(futureDate.toUTCString());
    // Allow ±2 seconds of tolerance for test execution time
    expect(result).toBeGreaterThan(118_000);
    expect(result).toBeLessThan(122_000);
  });

  it("returns 0 for a past HTTP-date", () => {
    const pastDate = new Date(Date.now() - 60_000);
    const result = parseRetryAfter(pastDate.toUTCString());
    expect(result).toBe(0);
  });

  it("returns undefined for an unparseable string", () => {
    expect(parseRetryAfter("not-a-number")).toBeUndefined();
    expect(parseRetryAfter("abc")).toBeUndefined();
  });

  it("handles decimal seconds by rounding to milliseconds", () => {
    // "30.5" seconds → 30500 ms (rounded)
    expect(parseRetryAfter("30.5")).toBe(30_500);
  });
});
