/**
 * POST /api/webhooks/segment
 *
 * Segment source webhook receiver.
 *
 * Segment sends POST requests to this endpoint when user behavior events
 * occur (track, identify, page). The payload is signed with HMAC-SHA256
 * using a shared secret stored in the integration's `access_token` field.
 *
 * Processing flow:
 *   1. Read the raw body and verify the `x-signature` HMAC-SHA256 header.
 *   2. Look up the Segment integration by `writeKey` (from the payload).
 *   3. Find the project mapped to this integration.
 *   4. Check whether the event type is in the integration's `trigger_events` list.
 *   5. Find the active widget campaign for the project.
 *   6. Look up or create a contact record for the identified user.
 *   7. Enqueue a `send-chat` job to trigger a widget conversation.
 *
 * Segment webhook signature:
 *   Header: `x-signature`
 *   Value:  HMAC-SHA256(rawBody, sharedSecret) as hex digest
 *
 * Requirements: 20.5
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema/integrations";
import { campaigns } from "@/db/schema/campaigns";
import { contacts } from "@/db/schema/contacts";
import { sendChatQueue } from "@/lib/queues";
import { decrypt } from "@/lib/encryption";

// ── Segment payload types ─────────────────────────────────────────────────────

interface SegmentTrackEvent {
  type: "track";
  event: string;
  userId?: string;
  anonymousId?: string;
  writeKey?: string;
  properties?: Record<string, unknown>;
  traits?: Record<string, unknown>;
  context?: {
    traits?: {
      email?: string;
      firstName?: string;
      first_name?: string;
      lastName?: string;
      last_name?: string;
      name?: string;
      phone?: string;
    };
  };
}

interface SegmentIdentifyEvent {
  type: "identify";
  userId?: string;
  anonymousId?: string;
  writeKey?: string;
  traits?: {
    email?: string;
    firstName?: string;
    first_name?: string;
    lastName?: string;
    last_name?: string;
    name?: string;
    phone?: string;
  };
}

interface SegmentPageEvent {
  type: "page";
  name?: string;
  userId?: string;
  anonymousId?: string;
  writeKey?: string;
  properties?: Record<string, unknown>;
  context?: {
    traits?: {
      email?: string;
      firstName?: string;
      first_name?: string;
      lastName?: string;
      last_name?: string;
      name?: string;
      phone?: string;
    };
  };
}

type SegmentEvent = SegmentTrackEvent | SegmentIdentifyEvent | SegmentPageEvent;

// ── Integration config type ───────────────────────────────────────────────────

interface SegmentIntegrationConfig {
  project_id: string;
  trigger_events: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Verify the Segment HMAC-SHA256 signature.
 *
 * Segment signs the raw request body with the shared secret and sends the
 * hex digest in the `x-signature` header.
 *
 * Uses `timingSafeEqual` to prevent timing attacks.
 */
function verifySignature(rawBody: string, secret: string, signature: string): boolean {
  try {
    const expected = createHmac("sha256", secret)
      .update(rawBody, "utf8")
      .digest("hex");

    const expectedBuf = Buffer.from(expected, "hex");
    const receivedBuf = Buffer.from(signature, "hex");

    if (expectedBuf.length !== receivedBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

/**
 * Extract the event name from a Segment event.
 * For `track` events this is the event name; for `identify` and `page` it is
 * the event type itself.
 */
function getEventName(event: SegmentEvent): string {
  if (event.type === "track") {
    return event.event;
  }
  return event.type;
}

/**
 * Extract contact traits from a Segment event.
 * Segment can send traits in different locations depending on event type.
 */
function extractTraits(event: SegmentEvent): {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
} {
  let traits: Record<string, unknown> = {};

  if (event.type === "identify" && event.traits) {
    traits = event.traits as Record<string, unknown>;
  } else if (
    (event.type === "track" || event.type === "page") &&
    event.context?.traits
  ) {
    traits = event.context.traits as Record<string, unknown>;
  }

  const email = typeof traits.email === "string" ? traits.email : undefined;
  const phone = typeof traits.phone === "string" ? traits.phone : undefined;

  // Support both camelCase and snake_case trait names
  const firstName =
    typeof traits.firstName === "string"
      ? traits.firstName
      : typeof traits.first_name === "string"
        ? traits.first_name
        : undefined;

  const lastName =
    typeof traits.lastName === "string"
      ? traits.lastName
      : typeof traits.last_name === "string"
        ? traits.last_name
        : undefined;

  return { email, firstName, lastName, phone };
}

// ── Webhook Handler ───────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/segment
 *
 * Receives Segment source events and triggers in-app widget campaign
 * conversations for matching projects.
 *
 * Requirements: 20.5
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Read raw body ──────────────────────────────────────────────────────
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-signature");

  if (!signatureHeader) {
    console.warn("[segment-webhook] Missing x-signature header");
    return NextResponse.json({ error: "Missing x-signature header" }, { status: 400 });
  }

  // ── 2. Parse the payload ──────────────────────────────────────────────────
  let event: SegmentEvent;
  try {
    event = JSON.parse(rawBody) as SegmentEvent;
  } catch {
    console.warn("[segment-webhook] Invalid JSON payload");
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!event.type) {
    return NextResponse.json({ error: "Missing event type" }, { status: 400 });
  }

  // ── 3. Find all Segment integrations ─────────────────────────────────────
  // We need to find the integration whose shared secret matches the signature.
  // Segment doesn't include the write key in the webhook payload by default,
  // so we verify against all active Segment integrations and find the match.
  const allSegmentIntegrations = await db
    .select({
      id: integrations.id,
      accountId: integrations.accountId,
      accessToken: integrations.accessToken,
      config: integrations.config,
    })
    .from(integrations)
    .where(eq(integrations.provider, "segment"));

  if (allSegmentIntegrations.length === 0) {
    console.warn("[segment-webhook] No Segment integrations configured");
    return NextResponse.json({ received: true });
  }

  // ── 4. Find the matching integration by verifying the signature ───────────
  let matchedIntegration: (typeof allSegmentIntegrations)[0] | null = null;

  for (const integration of allSegmentIntegrations) {
    let secret: string;
    try {
      secret = decrypt(integration.accessToken);
    } catch {
      console.warn(
        `[segment-webhook] Failed to decrypt access token for integration ${integration.id}`,
      );
      continue;
    }

    if (verifySignature(rawBody, secret, signatureHeader)) {
      matchedIntegration = integration;
      break;
    }
  }

  if (!matchedIntegration) {
    console.warn("[segment-webhook] Signature verification failed for all integrations");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  console.log(
    `[segment-webhook] Verified event '${event.type}' for integration ${matchedIntegration.id}`,
  );

  // ── 5. Parse integration config ───────────────────────────────────────────
  const config = matchedIntegration.config as SegmentIntegrationConfig | null;

  if (!config?.project_id) {
    console.warn(
      `[segment-webhook] Integration ${matchedIntegration.id} has no project_id in config`,
    );
    return NextResponse.json({ received: true });
  }

  const projectId = config.project_id;
  const triggerEvents: string[] = config.trigger_events ?? [];

  // ── 6. Check if this event should trigger a widget conversation ───────────
  const eventName = getEventName(event);

  if (triggerEvents.length > 0 && !triggerEvents.includes(eventName)) {
    console.log(
      `[segment-webhook] Event '${eventName}' is not in trigger_events for integration ${matchedIntegration.id} — skipping`,
    );
    return NextResponse.json({ received: true });
  }

  // ── 7. Find the active widget campaign for this project ───────────────────
  const [activeCampaign] = await db
    .select({
      id: campaigns.id,
      projectId: campaigns.projectId,
      channels: campaigns.channels,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.projectId, projectId),
        inArray(campaigns.status, ["active", "launching"]),
      ),
    )
    .limit(1);

  if (!activeCampaign) {
    console.log(
      `[segment-webhook] No active widget campaign found for project ${projectId}`,
    );
    return NextResponse.json({ received: true });
  }

  // Ensure the campaign supports the widget channel
  if (!activeCampaign.channels.includes("widget")) {
    console.log(
      `[segment-webhook] Active campaign ${activeCampaign.id} does not include widget channel — skipping`,
    );
    return NextResponse.json({ received: true });
  }

  // ── 8. Look up or create a contact for the identified user ────────────────
  const traits = extractTraits(event);
  const userId = event.userId ?? event.anonymousId;

  if (!traits.email && !traits.phone) {
    console.log(
      `[segment-webhook] Event has no email or phone in traits — cannot create contact (userId: ${userId ?? "unknown"})`,
    );
    return NextResponse.json({ received: true });
  }

  // Try to find an existing contact by email (preferred) or phone
  let contactId: string;

  const existingContactConditions = [];
  if (traits.email) {
    existingContactConditions.push(
      and(eq(contacts.projectId, projectId), eq(contacts.email, traits.email)),
    );
  }

  let existingContact: { id: string; optedOutEmail: boolean } | undefined;

  if (traits.email) {
    const [found] = await db
      .select({ id: contacts.id, optedOutEmail: contacts.optedOutEmail })
      .from(contacts)
      .where(and(eq(contacts.projectId, projectId), eq(contacts.email, traits.email)))
      .limit(1);
    existingContact = found;
  }

  if (!existingContact && traits.phone) {
    const [found] = await db
      .select({ id: contacts.id, optedOutEmail: contacts.optedOutEmail })
      .from(contacts)
      .where(and(eq(contacts.projectId, projectId), eq(contacts.phone, traits.phone)))
      .limit(1);
    existingContact = found;
  }

  if (existingContact) {
    contactId = existingContact.id;
    console.log(
      `[segment-webhook] Found existing contact ${contactId} for project ${projectId}`,
    );
  } else {
    // Create a new contact from the Segment traits
    const firstName = traits.firstName ?? "Unknown";
    const lastName = traits.lastName;

    const [created] = await db
      .insert(contacts)
      .values({
        projectId,
        firstName,
        lastName,
        email: traits.email,
        phone: traits.phone,
        crmSource: "segment",
        crmId: userId,
      })
      .returning({ id: contacts.id });

    contactId = created.id;
    console.log(
      `[segment-webhook] Created new contact ${contactId} for project ${projectId} (Segment userId: ${userId ?? "anonymous"})`,
    );
  }

  // ── 9. Enqueue a send-chat job to trigger the widget conversation ─────────
  const jobId = `send-chat:${activeCampaign.id}:${contactId}`;

  await sendChatQueue.add(
    "send-chat",
    {
      conversationId: jobId, // placeholder — the worker creates the conversation record
      campaignId: activeCampaign.id,
      contactId,
      projectId,
      channel: "widget",
    },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      // Deduplicate: one pending chat job per contact per campaign
      jobId,
    },
  );

  console.log(
    `[segment-webhook] Enqueued send-chat job for contact ${contactId} in campaign ${activeCampaign.id} (event: ${eventName})`,
  );

  return NextResponse.json({
    received: true,
    event: eventName,
    campaignId: activeCampaign.id,
    contactId,
  });
}
