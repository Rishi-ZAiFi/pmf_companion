/**
 * signal-classifier.ts
 *
 * Shared OpenAI-based signal classification utility used by all scraper workers.
 *
 * Assigns one of the six signal types and a Relevance Score 0–100 to a piece
 * of scraped content based on its semantic similarity to the project's ICP
 * and problem statement.
 *
 * Requirements: 2.4, 2.5, 4.3
 */

import OpenAI from "openai";

// ── Types ─────────────────────────────────────────────────────────────────────

/** The six signal types supported by the platform. */
export type SignalType =
  | "pain_point"
  | "feature_request"
  | "competitor_mention"
  | "market_trend"
  | "positive_sentiment"
  | "negative_sentiment";

/** Result returned by the classifier. */
export interface ClassificationResult {
  signalType: SignalType;
  /** 0–100 relevance score based on semantic similarity to the project's ICP. */
  relevanceScore: number;
  /** Derived sentiment from the signal type. */
  sentiment: "positive" | "neutral" | "negative";
}

/** Input context for classification. */
export interface ClassificationInput {
  /** The text content to classify (post title + body, or comment body). */
  content: string;
  /** The project's ICP description. */
  icpDescription: string;
  /** The project's primary problem statement. */
  problemStatement: string;
  /** Optional competitor names to help detect competitor_mention signals. */
  competitorNames?: string[];
}

// ── OpenAI client ─────────────────────────────────────────────────────────────

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildClassificationPrompt(input: ClassificationInput): string {
  const competitorSection =
    input.competitorNames && input.competitorNames.length > 0
      ? `\nKnown competitors: ${input.competitorNames.join(", ")}`
      : "";

  return `You are a market intelligence analyst. Classify the following piece of content for a startup.

Project context:
- ICP (Ideal Customer Profile): ${input.icpDescription}
- Problem being solved: ${input.problemStatement}${competitorSection}

Content to classify:
"""
${input.content.slice(0, 2000)}
"""

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "signal_type": "pain_point" | "feature_request" | "competitor_mention" | "market_trend" | "positive_sentiment" | "negative_sentiment",
  "relevance_score": <integer 0-100>,
  "reasoning": "<one sentence>"
}

Signal type definitions:
- pain_point: The author describes a problem, frustration, or unmet need relevant to the ICP
- feature_request: The author requests or wishes for a specific capability or improvement
- competitor_mention: The content explicitly mentions or compares a known competitor
- market_trend: The content describes a broader market shift, adoption pattern, or industry trend
- positive_sentiment: The content expresses satisfaction, praise, or positive experience relevant to the problem space
- negative_sentiment: The content expresses dissatisfaction, criticism, or negative experience relevant to the problem space

Relevance score (0-100):
- 0-19: Not relevant to the ICP or problem space
- 20-49: Tangentially relevant
- 50-79: Moderately relevant — the ICP would find this useful
- 80-100: Highly relevant — directly addresses the ICP's core problem`;
}

// ── Response parser ───────────────────────────────────────────────────────────

const VALID_SIGNAL_TYPES = new Set<SignalType>([
  "pain_point",
  "feature_request",
  "competitor_mention",
  "market_trend",
  "positive_sentiment",
  "negative_sentiment",
]);

function isValidSignalType(value: unknown): value is SignalType {
  return typeof value === "string" && VALID_SIGNAL_TYPES.has(value as SignalType);
}

function parseClassificationResponse(
  content: string,
): ClassificationResult | null {
  try {
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as unknown;

    if (typeof parsed !== "object" || parsed === null) return null;

    const obj = parsed as Record<string, unknown>;

    if (!isValidSignalType(obj.signal_type)) return null;

    const score = Number(obj.relevance_score);
    if (isNaN(score) || score < 0 || score > 100) return null;

    const signalType = obj.signal_type;
    const relevanceScore = Math.round(score);

    // Derive sentiment from signal type
    let sentiment: "positive" | "neutral" | "negative";
    if (signalType === "positive_sentiment") {
      sentiment = "positive";
    } else if (
      signalType === "pain_point" ||
      signalType === "negative_sentiment"
    ) {
      sentiment = "negative";
    } else {
      sentiment = "neutral";
    }

    return { signalType, relevanceScore, sentiment };
  } catch {
    return null;
  }
}

// ── Main classifier function ──────────────────────────────────────────────────

/**
 * classifySignal
 *
 * Calls OpenAI to classify a piece of scraped content and assign a relevance
 * score. Returns a default classification on failure so that scraping is not
 * blocked by classification errors.
 *
 * Requirements: 2.4, 2.5, 4.3
 */
export async function classifySignal(
  input: ClassificationInput,
): Promise<ClassificationResult> {
  const prompt = buildClassificationPrompt(input);

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 256,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI returned an empty response");
    }

    const result = parseClassificationResponse(content);
    if (!result) {
      throw new Error(`Failed to parse classification response: ${content}`);
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[signal-classifier] Classification failed: ${message}`);

    // Return a safe default so scraping continues even if classification fails
    return {
      signalType: "market_trend",
      relevanceScore: 0,
      sentiment: "neutral",
    };
  }
}
