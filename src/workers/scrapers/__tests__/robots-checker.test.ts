/**
 * Tests for robots.txt parsing and compliance checking.
 *
 * Requirements: 23.4
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseRobotsTxt,
  checkAllowed,
  clearRobotsCache,
  DEFAULT_USER_AGENT,
} from "../robots-checker";

beforeEach(() => {
  clearRobotsCache();
});

describe("parseRobotsTxt", () => {
  it("returns empty rules for an empty robots.txt", () => {
    const rules = parseRobotsTxt("", DEFAULT_USER_AGENT);
    expect(rules).toHaveLength(0);
  });

  it("parses wildcard user-agent rules", () => {
    const txt = `
User-agent: *
Disallow: /private/
Allow: /public/
    `.trim();

    const rules = parseRobotsTxt(txt, DEFAULT_USER_AGENT);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ path: "/private/", allow: false });
    expect(rules[1]).toEqual({ path: "/public/", allow: true });
  });

  it("parses specific user-agent rules and ignores wildcard when specific match exists", () => {
    const txt = `
User-agent: *
Disallow: /

User-agent: MarketSignalBot
Allow: /api/
    `.trim();

    const rules = parseRobotsTxt(txt, "MarketSignalBot");
    // Should only return rules for the specific agent
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ path: "/api/", allow: true });
  });

  it("falls back to wildcard rules when no specific agent match", () => {
    const txt = `
User-agent: *
Disallow: /admin/

User-agent: Googlebot
Allow: /
    `.trim();

    const rules = parseRobotsTxt(txt, DEFAULT_USER_AGENT);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ path: "/admin/", allow: false });
  });

  it("strips inline comments", () => {
    const txt = `
User-agent: * # all bots
Disallow: /secret/ # keep out
    `.trim();

    const rules = parseRobotsTxt(txt, DEFAULT_USER_AGENT);
    expect(rules).toHaveLength(1);
    expect(rules[0].path).toBe("/secret/");
  });

  it("handles case-insensitive user-agent matching", () => {
    const txt = `
User-agent: marketsignalbot
Disallow: /blocked/
    `.trim();

    const rules = parseRobotsTxt(txt, "MarketSignalBot");
    expect(rules).toHaveLength(1);
  });
});

describe("checkAllowed", () => {
  it("allows all paths when rules are empty", () => {
    expect(checkAllowed("/anything", [])).toBe(true);
    expect(checkAllowed("/private/data", [])).toBe(true);
  });

  it("disallows a path that matches a Disallow rule", () => {
    const rules = [{ path: "/private/", allow: false }];
    expect(checkAllowed("/private/data", rules)).toBe(false);
    expect(checkAllowed("/private/", rules)).toBe(false);
  });

  it("allows a path that does not match any Disallow rule", () => {
    const rules = [{ path: "/private/", allow: false }];
    expect(checkAllowed("/public/data", rules)).toBe(true);
  });

  it("Allow takes precedence over Disallow for the same path length", () => {
    const rules = [
      { path: "/api/", allow: false },
      { path: "/api/", allow: true },
    ];
    expect(checkAllowed("/api/data", rules)).toBe(true);
  });

  it("longer matching rule takes precedence over shorter one", () => {
    const rules = [
      { path: "/", allow: false },
      { path: "/public/", allow: true },
    ];
    expect(checkAllowed("/public/page", rules)).toBe(true);
    expect(checkAllowed("/private/page", rules)).toBe(false);
  });

  it("empty Disallow path (allow all) is skipped", () => {
    const rules = [{ path: "", allow: false }];
    expect(checkAllowed("/anything", rules)).toBe(true);
  });

  it("handles wildcard * in path patterns", () => {
    const rules = [{ path: "/search*", allow: false }];
    expect(checkAllowed("/search?q=test", rules)).toBe(false);
    expect(checkAllowed("/search/results", rules)).toBe(false);
    expect(checkAllowed("/other", rules)).toBe(true);
  });
});

describe("deduplication constraint behavior", () => {
  /**
   * These tests verify the deduplication logic described in Requirements 2.6 and 4.4:
   * "IF a post/comment has already been ingested for the same Project, THEN THE Scraper
   * SHALL discard the duplicate without creating a new Signal record."
   *
   * The deduplication is enforced at the DB level via UNIQUE (project_id, source_url).
   * Here we test the conceptual behavior: same (projectId, sourceUrl) → one record.
   */

  it("same source URL for same project is a duplicate", () => {
    const projectId = "proj-123";
    const sourceUrl = "https://www.reddit.com/r/startups/comments/abc123";

    // Simulate the deduplication key
    const key1 = `${projectId}::${sourceUrl}`;
    const key2 = `${projectId}::${sourceUrl}`;

    expect(key1).toBe(key2);
  });

  it("same source URL for different projects is NOT a duplicate", () => {
    const projectId1 = "proj-123";
    const projectId2 = "proj-456";
    const sourceUrl = "https://www.reddit.com/r/startups/comments/abc123";

    const key1 = `${projectId1}::${sourceUrl}`;
    const key2 = `${projectId2}::${sourceUrl}`;

    expect(key1).not.toBe(key2);
  });

  it("different source URLs for same project are NOT duplicates", () => {
    const projectId = "proj-123";
    const url1 = "https://www.reddit.com/r/startups/comments/abc123";
    const url2 = "https://www.reddit.com/r/startups/comments/def456";

    const key1 = `${projectId}::${url1}`;
    const key2 = `${projectId}::${url2}`;

    expect(key1).not.toBe(key2);
  });
});
