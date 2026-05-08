import { z } from "zod";

/**
 * Environment variable schema with Zod validation.
 * All required secrets are validated at startup to fail fast on misconfiguration.
 */
const envSchema = z.object({
  // ── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .url()
    .describe("PostgreSQL connection string (with pgvector extension enabled)"),

  // ── Redis / BullMQ ────────────────────────────────────────────────────────
  REDIS_URL: z.string().url().describe("Redis connection string for BullMQ and caching"),

  // ── OpenAI ────────────────────────────────────────────────────────────────
  OPENAI_API_KEY: z.string().min(1).describe("OpenAI API key for embeddings and LLM calls"),

  // ── NextAuth ──────────────────────────────────────────────────────────────
  NEXTAUTH_SECRET: z
    .string()
    .min(32)
    .describe("Secret used to sign and encrypt NextAuth JWTs (min 32 chars)"),
  NEXTAUTH_URL: z.string().url().describe("Canonical URL of the application for NextAuth"),

  // ── Google OAuth ──────────────────────────────────────────────────────────
  GOOGLE_CLIENT_ID: z.string().min(1).describe("Google OAuth 2.0 client ID"),
  GOOGLE_CLIENT_SECRET: z.string().min(1).describe("Google OAuth 2.0 client secret"),

  // ── SendGrid ──────────────────────────────────────────────────────────────
  SENDGRID_API_KEY: z.string().min(1).describe("SendGrid API key for transactional email"),

  // ── Twilio ────────────────────────────────────────────────────────────────
  TWILIO_ACCOUNT_SID: z
    .string()
    .regex(/^AC[a-f0-9]{32}$/, "Must be a valid Twilio Account SID (starts with AC)")
    .describe("Twilio Account SID"),
  TWILIO_AUTH_TOKEN: z.string().min(1).describe("Twilio Auth Token"),
  TWILIO_PHONE_NUMBER: z
    .string()
    .regex(/^\+[1-9]\d{1,14}$/, "Must be a valid E.164 phone number")
    .describe("Twilio provisioned phone number in E.164 format"),

  // ── Vapi ──────────────────────────────────────────────────────────────────
  VAPI_API_KEY: z.string().min(1).describe("Vapi API key for voice agent integration"),
  VAPI_PHONE_NUMBER_ID: z
    .string()
    .min(1)
    .describe("Vapi-provisioned phone number ID used as the caller for outbound voice campaigns"),

  // ── Stripe ────────────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^sk_(test|live)_/, "Must be a valid Stripe secret key")
    .describe("Stripe secret key for subscription billing"),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_/, "Must be a valid Stripe webhook signing secret")
    .describe("Stripe webhook signing secret for verifying webhook payloads"),
  /** Stripe price IDs for each paid plan tier. Optional — only required when
   *  the billing checkout flow is used. */
  STRIPE_PRICE_STARTER: z
    .string()
    .min(1)
    .optional()
    .describe("Stripe price ID for the Starter plan ($49/month)"),
  STRIPE_PRICE_GROWTH: z
    .string()
    .min(1)
    .optional()
    .describe("Stripe price ID for the Growth plan ($149/month)"),
  STRIPE_PRICE_ENTERPRISE: z
    .string()
    .min(1)
    .optional()
    .describe("Stripe price ID for the Enterprise plan (custom pricing)"),

  // ── AWS ───────────────────────────────────────────────────────────────────
  AWS_ACCESS_KEY_ID: z.string().min(16).describe("AWS IAM access key ID"),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).describe("AWS IAM secret access key"),
  AWS_S3_BUCKET: z.string().min(1).describe("S3 bucket name for call recordings and exports"),
  AWS_REGION: z
    .string()
    .regex(/^[a-z]{2}-[a-z]+-\d$/, "Must be a valid AWS region (e.g. us-east-1)")
    .describe("AWS region where the S3 bucket is located"),

  // ── Optional / runtime ────────────────────────────────────────────────────
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // ── Reddit (snoowrap) ─────────────────────────────────────────────────────
  REDDIT_CLIENT_ID: z.string().min(1).optional().describe("Reddit OAuth2 client ID"),
  REDDIT_CLIENT_SECRET: z.string().min(1).optional().describe("Reddit OAuth2 client secret"),
  REDDIT_USERNAME: z.string().min(1).optional().describe("Reddit account username for snoowrap"),
  REDDIT_PASSWORD: z.string().min(1).optional().describe("Reddit account password for snoowrap"),

  // ── Twitter/X API v2 ──────────────────────────────────────────────────────
  TWITTER_BEARER_TOKEN: z
    .string()
    .min(1)
    .optional()
    .describe("Twitter/X API v2 Bearer Token for read-only tweet search"),

  // ── Slack ─────────────────────────────────────────────────────────────────
  SLACK_CLIENT_ID: z
    .string()
    .min(1)
    .optional()
    .describe("Slack OAuth 2.0 client ID for workspace integration"),
  SLACK_CLIENT_SECRET: z
    .string()
    .min(1)
    .optional()
    .describe("Slack OAuth 2.0 client secret for workspace integration"),

  // ── HubSpot ───────────────────────────────────────────────────────────────
  HUBSPOT_CLIENT_ID: z
    .string()
    .min(1)
    .optional()
    .describe("HubSpot OAuth 2.0 client ID for CRM integration"),
  HUBSPOT_CLIENT_SECRET: z
    .string()
    .min(1)
    .optional()
    .describe("HubSpot OAuth 2.0 client secret for CRM integration"),

  // ── Intercom ──────────────────────────────────────────────────────────────
  INTERCOM_CLIENT_ID: z
    .string()
    .min(1)
    .optional()
    .describe("Intercom OAuth 2.0 client ID for CRM integration"),
  INTERCOM_CLIENT_SECRET: z
    .string()
    .min(1)
    .optional()
    .describe("Intercom OAuth 2.0 client secret for CRM integration"),

  // ── Notion ────────────────────────────────────────────────────────────────
  NOTION_CLIENT_ID: z
    .string()
    .min(1)
    .optional()
    .describe("Notion OAuth 2.0 client ID for workspace integration"),
  NOTION_CLIENT_SECRET: z
    .string()
    .min(1)
    .optional()
    .describe("Notion OAuth 2.0 client secret for workspace integration"),

  // ── Encryption ────────────────────────────────────────────────────────────
  /** 32-byte hex-encoded key (64 hex chars) used for AES-256-GCM encryption
   *  of integration access tokens at rest. Generate with:
   *  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" */
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "Must be a 64-character hex string (32 bytes)")
    .optional()
    .describe("AES-256-GCM encryption key for integration access tokens (64 hex chars)"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parsed and validated environment variables.
 * Throws a descriptive error at module load time if any required variable is missing or invalid.
 */
function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  • ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `❌ Invalid environment variables:\n${formatted}\n\nCheck your .env file against .env.example`,
    );
  }

  return result.data;
}

// Singleton — parsed once at module load time.
// In test environments, individual tests can override process.env before importing.
export const env = parseEnv();
