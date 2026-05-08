import { Worker, type Job } from "bullmq";
import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema/projects";
import { redisConnection, type GenerateKeywordsJobData } from "@/lib/queues";

/**
 * Expected shape of the structured JSON response from OpenAI.
 */
interface KeywordGenerationResult {
  keywords: string[];
  subreddits: string[];
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Build the prompt for OpenAI to generate keywords and subreddit candidates.
 */
function buildPrompt(data: GenerateKeywordsJobData): string {
  const competitorSection =
    data.competitorNames.length > 0
      ? `\nCompetitor names to consider: ${data.competitorNames.join(", ")}`
      : "";

  return `You are a market research assistant helping a startup founder identify where their target customers discuss their problems online.

Given the following product context, generate a list of search keywords and relevant subreddits.

ICP Description: ${data.icpDescription}
Problem Statement: ${data.problemStatement}${competitorSection}

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "keywords": ["keyword1", "keyword2", ...],
  "subreddits": ["subreddit1", "subreddit2", ...]
}

Requirements:
- keywords: 10-20 relevant search terms that the target audience would use when discussing this problem. Include variations, synonyms, and related concepts. Do NOT include the r/ prefix for subreddits here.
- subreddits: 5-10 relevant subreddit names (WITHOUT the r/ prefix) where the target audience is likely to discuss this problem or related topics.
- If competitor names are provided, include keywords related to those competitors and subreddits where they are discussed.`;
}

/**
 * Parse and validate the OpenAI response JSON.
 * Returns null if the response cannot be parsed or is missing required fields.
 */
function parseOpenAIResponse(content: string): KeywordGenerationResult | null {
  try {
    // Strip any accidental markdown code fences
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).keywords) ||
      !Array.isArray((parsed as Record<string, unknown>).subreddits)
    ) {
      return null;
    }

    const result = parsed as KeywordGenerationResult;

    // Ensure all entries are strings
    const keywords = result.keywords.filter((k): k is string => typeof k === "string");
    const subreddits = result.subreddits
      .filter((s): s is string => typeof s === "string")
      // Strip any accidental r/ prefixes
      .map((s) => s.replace(/^r\//i, "").trim());

    return { keywords, subreddits };
  } catch {
    return null;
  }
}

/**
 * BullMQ Worker that processes `generate-keywords` jobs.
 *
 * For each job:
 * 1. Calls OpenAI Chat Completions with the project's ICP description and problem statement.
 * 2. Parses the structured JSON response.
 * 3. Writes the resulting keywords and subreddit candidates back to the project record.
 *
 * Requirements: 1.4, 2.1
 */
export const generateKeywordsWorker = new Worker<GenerateKeywordsJobData>(
  "generate-keywords",
  async (job: Job<GenerateKeywordsJobData>) => {
    const { projectId, icpDescription, problemStatement, competitorNames } = job.data;

    console.log(`[generate-keywords] Processing job ${job.id} for project ${projectId}`);

    // Call OpenAI Chat Completions
    const prompt = buildPrompt({ projectId, icpDescription, problemStatement, competitorNames });

    let result: KeywordGenerationResult;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 1024,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("OpenAI returned an empty response");
      }

      const parsed = parseOpenAIResponse(content);
      if (!parsed) {
        throw new Error(`Failed to parse OpenAI response: ${content}`);
      }

      result = parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[generate-keywords] OpenAI call failed for project ${projectId}: ${message}`);
      throw error; // Re-throw so BullMQ marks the job as failed
    }

    // Write keywords and subreddit candidates back to the project record
    try {
      await db
        .update(projects)
        .set({
          keywords: result.keywords,
          subredditCandidates: result.subreddits,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));

      console.log(
        `[generate-keywords] Successfully updated project ${projectId} with ` +
          `${result.keywords.length} keywords and ${result.subreddits.length} subreddits`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[generate-keywords] DB update failed for project ${projectId}: ${message}`,
      );
      throw error; // Re-throw so BullMQ marks the job as failed
    }

    return {
      projectId,
      keywordCount: result.keywords.length,
      subredditCount: result.subreddits.length,
    };
  },
  {
    connection: redisConnection,
    // Enforce the 60-second requirement from Requirement 1.4
    lockDuration: 60_000,
    concurrency: 5,
  },
);

generateKeywordsWorker.on("completed", (job) => {
  console.log(`[generate-keywords] Job ${job.id} completed successfully`);
});

generateKeywordsWorker.on("failed", (job, error) => {
  console.error(
    `[generate-keywords] Job ${job?.id} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

// Prevent unhandled promise rejections from crashing the process
generateKeywordsWorker.on("error", (error) => {
  console.error(`[generate-keywords] Worker error: ${error.message}`);
});
