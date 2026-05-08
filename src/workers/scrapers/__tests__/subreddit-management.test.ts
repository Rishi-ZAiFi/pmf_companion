/**
 * Tests for subreddit monitoring list management via PATCH /api/projects/:id.
 *
 * These tests verify the add/remove subreddit logic in isolation by testing
 * the normalization and deduplication logic directly.
 *
 * Requirements: 2.3
 */

import { describe, it, expect } from "vitest";

// ── Inline the subreddit merge logic for unit testing ─────────────────────────
// This mirrors the logic in src/app/api/projects/[id]/route.ts

function mergeSubreddits(
  current: string[],
  add: string[] | undefined,
  remove: string[] | undefined,
): string[] {
  let result = [...current];

  if (add && add.length > 0) {
    const normalized = add.map((s) => s.replace(/^r\//i, "").trim());
    const existing = new Set(result.map((s) => s.toLowerCase()));
    for (const sub of normalized) {
      if (!existing.has(sub.toLowerCase())) {
        result = [...result, sub];
        existing.add(sub.toLowerCase());
      }
    }
  }

  if (remove && remove.length > 0) {
    const toRemove = new Set(
      remove.map((s) => s.replace(/^r\//i, "").trim().toLowerCase()),
    );
    result = result.filter((s) => !toRemove.has(s.toLowerCase()));
  }

  return result;
}

describe("subreddit monitoring list management", () => {
  describe("adding subreddits", () => {
    it("adds new subreddits to an empty list", () => {
      const result = mergeSubreddits([], ["startups", "SaaS"], undefined);
      expect(result).toEqual(["startups", "SaaS"]);
    });

    it("adds new subreddits to an existing list", () => {
      const result = mergeSubreddits(
        ["startups"],
        ["SaaS", "entrepreneur"],
        undefined,
      );
      expect(result).toContain("startups");
      expect(result).toContain("SaaS");
      expect(result).toContain("entrepreneur");
      expect(result).toHaveLength(3);
    });

    it("does not add duplicate subreddits (case-insensitive)", () => {
      const result = mergeSubreddits(
        ["startups"],
        ["Startups", "STARTUPS"],
        undefined,
      );
      // Should still only have one entry for startups
      const lower = result.map((s) => s.toLowerCase());
      const startupCount = lower.filter((s) => s === "startups").length;
      expect(startupCount).toBe(1);
    });

    it("strips the r/ prefix when adding subreddits", () => {
      const result = mergeSubreddits([], ["r/startups", "r/SaaS"], undefined);
      expect(result).toContain("startups");
      expect(result).toContain("SaaS");
      expect(result.some((s) => s.startsWith("r/"))).toBe(false);
    });

    it("handles mixed r/ prefix and no prefix in the same request", () => {
      const result = mergeSubreddits(
        [],
        ["r/startups", "SaaS", "r/entrepreneur"],
        undefined,
      );
      expect(result).toHaveLength(3);
      expect(result.some((s) => s.startsWith("r/"))).toBe(false);
    });
  });

  describe("removing subreddits", () => {
    it("removes a subreddit from the list", () => {
      const result = mergeSubreddits(
        ["startups", "SaaS", "entrepreneur"],
        undefined,
        ["SaaS"],
      );
      expect(result).not.toContain("SaaS");
      expect(result).toContain("startups");
      expect(result).toContain("entrepreneur");
    });

    it("removes subreddits case-insensitively", () => {
      const result = mergeSubreddits(
        ["startups", "SaaS"],
        undefined,
        ["SAAS"],
      );
      expect(result).not.toContain("SaaS");
      expect(result).toContain("startups");
    });

    it("strips r/ prefix when removing subreddits", () => {
      const result = mergeSubreddits(
        ["startups", "SaaS"],
        undefined,
        ["r/startups"],
      );
      expect(result).not.toContain("startups");
      expect(result).toContain("SaaS");
    });

    it("is a no-op when removing a subreddit that is not in the list", () => {
      const current = ["startups", "SaaS"];
      const result = mergeSubreddits(current, undefined, ["entrepreneur"]);
      expect(result).toEqual(current);
    });

    it("returns an empty list when all subreddits are removed", () => {
      const result = mergeSubreddits(
        ["startups", "SaaS"],
        undefined,
        ["startups", "SaaS"],
      );
      expect(result).toHaveLength(0);
    });
  });

  describe("combined add and remove", () => {
    it("can add and remove in the same operation", () => {
      const result = mergeSubreddits(
        ["startups", "SaaS"],
        ["entrepreneur"],
        ["SaaS"],
      );
      expect(result).toContain("startups");
      expect(result).toContain("entrepreneur");
      expect(result).not.toContain("SaaS");
    });

    it("does not add a subreddit that is also in the remove list", () => {
      // Add and remove the same subreddit — remove wins (add runs first, then remove)
      const result = mergeSubreddits([], ["startups"], ["startups"]);
      expect(result).not.toContain("startups");
    });
  });

  describe("no-op cases", () => {
    it("returns the original list when both add and remove are undefined", () => {
      const current = ["startups", "SaaS"];
      const result = mergeSubreddits(current, undefined, undefined);
      expect(result).toEqual(current);
    });

    it("returns the original list when both add and remove are empty arrays", () => {
      const current = ["startups", "SaaS"];
      const result = mergeSubreddits(current, [], []);
      expect(result).toEqual(current);
    });
  });
});
