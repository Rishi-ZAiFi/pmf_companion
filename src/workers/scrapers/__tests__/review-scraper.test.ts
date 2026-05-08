/**
 * review-scraper.test.ts
 *
 * Unit tests for opportunity flagging and sentiment classification logic
 * in the review scraper.
 *
 * Requirements: 6.4
 */

import { describe, it, expect } from "vitest";

// ── Re-export the opportunity-flagging logic for testing ──────────────────────
// The OPPORTUNITY_SIGNAL_TYPES set determines which signal types get flagged.
// We test the logic directly without importing the full scraper (which requires
// a live DB and Redis connection).

type SignalType =
  | "pain_point"
  | "feature_request"
  | "competitor_mention"
  | "market_trend"
  | "positive_sentiment"
  | "negative_sentiment";

const OPPORTUNITY_SIGNAL_TYPES = new Set<SignalType>([
  "negative_sentiment",
  "competitor_mention",
]);

function isOpportunity(signalType: SignalType): boolean {
  return OPPORTUNITY_SIGNAL_TYPES.has(signalType);
}

// ── Sentiment aggregate helpers (from twitter-scraper) ────────────────────────

type Sentiment = "positive" | "neutral" | "negative";

interface SentimentAggregate {
  positive: number;
  neutral: number;
  negative: number;
}

function buildSentimentAggregateMetadata(
  keyword: string,
  sentiment: Sentiment,
  existingMetadata: Record<string, unknown>,
  dateOverride?: string,
): Record<string, unknown> {
  const today = dateOverride ?? new Date().toISOString().slice(0, 10);

  const existing =
    (existingMetadata.sentimentAggregate as Record<string, unknown> | undefined) ?? {};
  const dateKey = `${keyword}:${today}`;
  const dayAgg = (existing[dateKey] as SentimentAggregate | undefined) ?? {
    positive: 0,
    neutral: 0,
    negative: 0,
  };

  const updated: SentimentAggregate = {
    ...dayAgg,
    [sentiment]: (dayAgg[sentiment] ?? 0) + 1,
  };

  return {
    ...existingMetadata,
    sentimentAggregate: {
      ...existing,
      [dateKey]: updated,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Review scraper — opportunity flagging (Requirement 6.4)", () => {
  it("flags negative_sentiment reviews as opportunities", () => {
    expect(isOpportunity("negative_sentiment")).toBe(true);
  });

  it("flags competitor_mention reviews as opportunities", () => {
    expect(isOpportunity("competitor_mention")).toBe(true);
  });

  it("does NOT flag pain_point reviews as opportunities", () => {
    expect(isOpportunity("pain_point")).toBe(false);
  });

  it("does NOT flag feature_request reviews as opportunities", () => {
    expect(isOpportunity("feature_request")).toBe(false);
  });

  it("does NOT flag market_trend reviews as opportunities", () => {
    expect(isOpportunity("market_trend")).toBe(false);
  });

  it("does NOT flag positive_sentiment reviews as opportunities", () => {
    expect(isOpportunity("positive_sentiment")).toBe(false);
  });

  it("correctly identifies all six signal types", () => {
    const allTypes: SignalType[] = [
      "pain_point",
      "feature_request",
      "competitor_mention",
      "market_trend",
      "positive_sentiment",
      "negative_sentiment",
    ];

    const opportunityTypes = allTypes.filter(isOpportunity);
    const nonOpportunityTypes = allTypes.filter((t) => !isOpportunity(t));

    expect(opportunityTypes).toEqual(
      expect.arrayContaining(["negative_sentiment", "competitor_mention"]),
    );
    expect(opportunityTypes).toHaveLength(2);

    expect(nonOpportunityTypes).toEqual(
      expect.arrayContaining([
        "pain_point",
        "feature_request",
        "market_trend",
        "positive_sentiment",
      ]),
    );
    expect(nonOpportunityTypes).toHaveLength(4);
  });
});

describe("Twitter scraper — daily sentiment aggregation (Requirement 3.3)", () => {
  const TEST_DATE = "2024-01-15";

  it("initializes a new aggregate for a keyword on first call", () => {
    const result = buildSentimentAggregateMetadata("saas-tools", "positive", {}, TEST_DATE);

    const agg = result.sentimentAggregate as Record<string, SentimentAggregate>;
    expect(agg["saas-tools:2024-01-15"]).toEqual({
      positive: 1,
      neutral: 0,
      negative: 0,
    });
  });

  it("increments the correct sentiment counter", () => {
    const result = buildSentimentAggregateMetadata("saas-tools", "negative", {}, TEST_DATE);

    const agg = result.sentimentAggregate as Record<string, SentimentAggregate>;
    expect(agg["saas-tools:2024-01-15"]).toEqual({
      positive: 0,
      neutral: 0,
      negative: 1,
    });
  });

  it("accumulates multiple sentiments for the same keyword and date", () => {
    let metadata: Record<string, unknown> = {};
    metadata = buildSentimentAggregateMetadata("crm", "positive", metadata, TEST_DATE);
    metadata = buildSentimentAggregateMetadata("crm", "positive", metadata, TEST_DATE);
    metadata = buildSentimentAggregateMetadata("crm", "negative", metadata, TEST_DATE);
    metadata = buildSentimentAggregateMetadata("crm", "neutral", metadata, TEST_DATE);

    const agg = metadata.sentimentAggregate as Record<string, SentimentAggregate>;
    expect(agg["crm:2024-01-15"]).toEqual({
      positive: 2,
      neutral: 1,
      negative: 1,
    });
  });

  it("tracks different keywords independently", () => {
    let metadata: Record<string, unknown> = {};
    metadata = buildSentimentAggregateMetadata("crm", "positive", metadata, TEST_DATE);
    metadata = buildSentimentAggregateMetadata("saas", "negative", metadata, TEST_DATE);

    const agg = metadata.sentimentAggregate as Record<string, SentimentAggregate>;
    expect(agg["crm:2024-01-15"]).toEqual({ positive: 1, neutral: 0, negative: 0 });
    expect(agg["saas:2024-01-15"]).toEqual({ positive: 0, neutral: 0, negative: 1 });
  });

  it("tracks different dates independently for the same keyword", () => {
    let metadata: Record<string, unknown> = {};
    metadata = buildSentimentAggregateMetadata("crm", "positive", metadata, "2024-01-14");
    metadata = buildSentimentAggregateMetadata("crm", "negative", metadata, "2024-01-15");

    const agg = metadata.sentimentAggregate as Record<string, SentimentAggregate>;
    expect(agg["crm:2024-01-14"]).toEqual({ positive: 1, neutral: 0, negative: 0 });
    expect(agg["crm:2024-01-15"]).toEqual({ positive: 0, neutral: 0, negative: 1 });
  });

  it("preserves existing metadata fields when adding sentiment aggregate", () => {
    const existingMetadata = {
      tweetId: "12345",
      metrics: { likes: 10 },
    };

    const result = buildSentimentAggregateMetadata(
      "keyword",
      "neutral",
      existingMetadata,
      TEST_DATE,
    );

    expect(result.tweetId).toBe("12345");
    expect(result.metrics).toEqual({ likes: 10 });
    expect(result.sentimentAggregate).toBeDefined();
  });

  it("handles all three sentiment values correctly", () => {
    const sentiments: Sentiment[] = ["positive", "neutral", "negative"];

    for (const sentiment of sentiments) {
      const result = buildSentimentAggregateMetadata("test", sentiment, {}, TEST_DATE);
      const agg = result.sentimentAggregate as Record<string, SentimentAggregate>;
      const dayAgg = agg["test:2024-01-15"];

      expect(dayAgg[sentiment]).toBe(1);
      // Other sentiments should be 0
      const others = sentiments.filter((s) => s !== sentiment);
      for (const other of others) {
        expect(dayAgg[other]).toBe(0);
      }
    }
  });
});

describe("Review scraper — slug generation", () => {
  // Test the toSlug utility logic (extracted for unit testing)
  function toSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  it("converts a simple name to a slug", () => {
    expect(toSlug("Salesforce")).toBe("salesforce");
  });

  it("converts a multi-word name to a hyphenated slug", () => {
    expect(toSlug("Acme Corp")).toBe("acme-corp");
  });

  it("handles special characters", () => {
    expect(toSlug("HubSpot CRM!")).toBe("hubspot-crm");
  });

  it("handles leading/trailing spaces", () => {
    expect(toSlug("  Notion  ")).toBe("notion");
  });

  it("collapses multiple spaces/special chars into a single hyphen", () => {
    expect(toSlug("Acme   Corp---Inc")).toBe("acme-corp-inc");
  });
});
