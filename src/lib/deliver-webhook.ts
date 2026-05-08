/**
 * deliver-webhook.ts
 *
 * Helper functions for enqueuing webhook delivery jobs when platform events occur.
 *
 * Usage:
 *   import { enqueueWebhookDelivery } from "@/lib/deliver-webhook";
 *   await enqueueWebhookDelivery("signal.created", projectId, payload);
 *
 * Requirements: 20.4
 */

import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { webhookEndpoints } from "@/db/schema/webhook-endpoints";
import { deliverWebhookQueue, type DeliverWebhookJobData } from "@/lib/queues";

/**
 * Enqueue a `deliver-webhook` job for every active webhook endpoint registered
 * for the given project that subscribes to the given event type.
 *
 * This function is called by:
 *   - The signal ingestion path (embed-signal worker) for `signal.created`
 *   - The PMF score calculation worker for `pmf_score.changed`
 *
 * @param eventType  The event type: "signal.created" | "pmf_score.changed"
 * @param projectId  The project whose webhook endpoints should be notified
 * @param payload    The event payload to POST to each endpoint
 */
export async function enqueueWebhookDelivery(
  eventType: "signal.created" | "pmf_score.changed",
  projectId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Load all active webhook endpoints for this project that subscribe to this event
  const endpoints = await db
    .select({
      id: webhookEndpoints.id,
    })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.projectId, projectId),
        eq(webhookEndpoints.isActive, true),
      ),
    );

  if (endpoints.length === 0) {
    return;
  }

  // Enqueue one delivery job per matching endpoint
  const jobs = endpoints.map((endpoint) => ({
    name: "deliver-webhook",
    data: {
      webhookEndpointId: endpoint.id,
      projectId,
      eventType,
      payload,
    } satisfies DeliverWebhookJobData,
  }));

  await deliverWebhookQueue.addBulk(jobs);
}
