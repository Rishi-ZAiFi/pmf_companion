/**
 * deliver-webhook.ts
 *
 * BullMQ worker that delivers webhook event payloads to founder-registered
 * endpoints.
 *
 * For each job:
 * 1. Load the webhook endpoint record (url, secret, events, is_active).
 * 2. Skip delivery if the endpoint is inactive or does not subscribe to the event.
 * 3. Serialize the payload to JSON.
 * 4. Compute an HMAC-SHA256 signature over the raw JSON body using the endpoint secret.
 * 5. POST the payload to the endpoint URL with the `X-Signature: sha256=<hex>` header.
 * 6. On failure, BullMQ retries with exponential backoff up to 3 times.
 *
 * Requirements: 20.4
 */

import { Worker, type Job } from "bullmq";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { webhookEndpoints } from "@/db/schema/webhook-endpoints";
import { redisConnection, type DeliverWebhookJobData } from "@/lib/queues";

// ── HMAC signing ──────────────────────────────────────────────────────────────

/**
 * Compute an HMAC-SHA256 signature over `body` using `secret`.
 * Returns the hex digest prefixed with "sha256=".
 *
 * Requirements: 20.4
 */
export function computeHmacSignature(secret: string, body: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body, "utf8");
  return `sha256=${hmac.digest("hex")}`;
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * BullMQ Worker that processes `deliver-webhook` jobs.
 *
 * Retry strategy: BullMQ exponential backoff — 3 attempts total (1 initial + 2 retries).
 * Delays: ~1s, ~2s, ~4s (BullMQ default exponential with base 1000ms).
 *
 * Requirements: 20.4
 */
export const deliverWebhookWorker = new Worker<DeliverWebhookJobData>(
  "deliver-webhook",
  async (job: Job<DeliverWebhookJobData>) => {
    const { webhookEndpointId, eventType, payload } = job.data;

    console.log(
      `[deliver-webhook] Processing job ${job.id} — endpoint ${webhookEndpointId}, event ${eventType}`,
    );

    // ── 1. Load the webhook endpoint ─────────────────────────────────────────
    const [endpoint] = await db
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        secret: webhookEndpoints.secret,
        events: webhookEndpoints.events,
        isActive: webhookEndpoints.isActive,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, webhookEndpointId))
      .limit(1);

    if (!endpoint) {
      // Endpoint was deleted — nothing to do.
      console.warn(
        `[deliver-webhook] Endpoint ${webhookEndpointId} not found — skipping`,
      );
      return { skipped: true, reason: "endpoint_not_found" };
    }

    // ── 2. Skip if inactive or not subscribed to this event ──────────────────
    if (!endpoint.isActive) {
      console.log(
        `[deliver-webhook] Endpoint ${webhookEndpointId} is inactive — skipping`,
      );
      return { skipped: true, reason: "endpoint_inactive" };
    }

    if (!endpoint.events.includes(eventType)) {
      console.log(
        `[deliver-webhook] Endpoint ${webhookEndpointId} does not subscribe to ${eventType} — skipping`,
      );
      return { skipped: true, reason: "event_not_subscribed" };
    }

    // ── 3. Serialize payload ──────────────────────────────────────────────────
    const body = JSON.stringify({
      event: eventType,
      ...payload,
    });

    // ── 4. Compute HMAC-SHA256 signature ──────────────────────────────────────
    const signature = computeHmacSignature(endpoint.secret, body);

    // ── 5. POST to the endpoint URL ───────────────────────────────────────────
    let response: Response;
    try {
      response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": signature,
          "User-Agent": "MarketSignalPlatform/1.0",
        },
        body,
        // 10-second timeout to avoid hanging indefinitely
        signal: AbortSignal.timeout(10_000),
      });
    } catch (fetchError) {
      const message =
        fetchError instanceof Error ? fetchError.message : String(fetchError);
      console.error(
        `[deliver-webhook] Network error delivering to ${endpoint.url}: ${message}`,
      );
      // Re-throw so BullMQ marks the job as failed and retries with backoff
      throw new Error(`Webhook delivery network error: ${message}`);
    }

    if (!response.ok) {
      const statusText = `${response.status} ${response.statusText}`;
      console.error(
        `[deliver-webhook] Endpoint ${endpoint.url} returned ${statusText}`,
      );
      // Re-throw so BullMQ marks the job as failed and retries with backoff
      throw new Error(`Webhook delivery failed with HTTP ${statusText}`);
    }

    console.log(
      `[deliver-webhook] Successfully delivered ${eventType} to ${endpoint.url} (HTTP ${response.status})`,
    );

    return {
      delivered: true,
      endpointId: webhookEndpointId,
      eventType,
      statusCode: response.status,
    };
  },
  {
    connection: redisConnection,
    concurrency: 10,
  },
);

deliverWebhookWorker.on("completed", (job, result) => {
  console.log(
    `[deliver-webhook] Job ${job.id} completed:`,
    JSON.stringify(result),
  );
});

deliverWebhookWorker.on("failed", (job, error) => {
  console.error(
    `[deliver-webhook] Job ${job?.id} failed (attempt ${job?.attemptsMade ?? "?"}): ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
});

deliverWebhookWorker.on("error", (error) => {
  console.error(`[deliver-webhook] Worker error: ${error.message}`);
});
