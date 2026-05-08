/**
 * POST /api/projects/:id/contacts/sync
 *
 * Syncs contacts from a connected CRM (HubSpot, Intercom, or Mailchimp) into
 * the platform's contacts table for the given project.
 *
 * Request body (JSON):
 *   {
 *     provider: "hubspot" | "intercom" | "mailchimp"
 *   }
 *
 * The endpoint:
 * 1. Verifies the integration exists for the account and decrypts the token.
 * 2. Fetches contacts from the CRM API (first page, up to 100).
 * 3. Upserts contacts into the database (insert new, skip existing by crm_id).
 * 4. Optionally pushes any existing segment tags back to the CRM.
 *
 * Responses:
 *   200 — { synced: number, skipped: number, message: string }
 *   400 — Validation error or missing integration.
 *   401 — Not authenticated.
 *   404 — Project not found.
 *   500 — Unexpected server error or CRM API error.
 *
 * Requirements: 8.4, 20.2
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { contacts, type NewContact } from "@/db/schema/contacts";
import { projects } from "@/db/schema/projects";
import { integrations } from "@/db/schema/integrations";
import { withAuth } from "@/lib/require-auth";
import { decrypt } from "@/lib/encryption";
import { bulkPushTagsToHubSpot, pushTagsToIntercom } from "@/lib/crm-tags";
import { sql } from "drizzle-orm";

// ── Validation schemas ───────────────────────────────────────────────────────

const syncRequestSchema = z.object({
  provider: z.enum(["hubspot", "intercom", "mailchimp"], {
    errorMap: () => ({ message: "Provider must be one of: hubspot, intercom, mailchimp" }),
  }),
});

// ── Types ────────────────────────────────────────────────────────────────────

interface HubSpotContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone?: string;
  };
}

interface HubSpotContactsResponse {
  results?: HubSpotContact[];
  paging?: {
    next?: { after?: string; link?: string };
  };
}

interface IntercomContact {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
}

interface IntercomContactsResponse {
  data?: IntercomContact[];
  pages?: {
    next?: string;
  };
}

interface MailchimpMember {
  id: string;
  email_address: string;
  merge_fields?: {
    FNAME?: string;
    LNAME?: string;
    PHONE?: string;
  };
}

// ── CRM API Helpers ──────────────────────────────────────────────────────────

/**
 * Fetches the first page of contacts from HubSpot CRM (up to 100).
 */
async function fetchHubSpotContacts(
  accessToken: string,
): Promise<Array<Omit<NewContact, "projectId">>> {
  const response = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=firstname,lastname,email,phone",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HubSpot API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as HubSpotContactsResponse;
  const results: HubSpotContact[] = data.results ?? [];

  return results
    .filter((c) => c.properties.email || c.properties.phone)
    .map((c) => ({
      firstName: c.properties.firstname || "Unknown",
      lastName: c.properties.lastname ?? undefined,
      email: c.properties.email ?? undefined,
      phone: c.properties.phone ?? undefined,
      segmentTags: [],
      crmSource: "hubspot" as const,
      crmId: c.id,
    }));
}

/**
 * Fetches the first page of contacts from Intercom (up to 100).
 */
async function fetchIntercomContacts(
  accessToken: string,
): Promise<Array<Omit<NewContact, "projectId">>> {
  const response = await fetch("https://api.intercom.io/contacts?per_page=100", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Intercom API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as IntercomContactsResponse;
  const results: IntercomContact[] = data.data ?? [];

  return results
    .filter((c) => c.email || c.phone)
    .map((c) => {
      // Intercom may return a full name; split into first/last
      const nameParts = (c.name ?? "Unknown").split(" ");
      const firstName = nameParts[0] || "Unknown";
      const lastName = nameParts.slice(1).join(" ") || undefined;

      return {
        firstName,
        lastName,
        email: c.email ?? undefined,
        phone: c.phone ?? undefined,
        segmentTags: [],
        crmSource: "intercom" as const,
        crmId: c.id,
      };
    });
}

/**
 * Fetches the first page of contacts from Mailchimp (up to 100).
 * Requires a list ID in the integration config.
 */
async function fetchMailchimpContacts(
  accessToken: string,
  config: Record<string, unknown>,
): Promise<Array<Omit<NewContact, "projectId">>> {
  const listId = config.list_id as string | undefined;
  if (!listId) {
    throw new Error("Mailchimp integration is missing required config: list_id");
  }

  // Extract data center from access token (format: "token-dc")
  const dc = accessToken.split("-").pop();
  if (!dc) {
    throw new Error("Invalid Mailchimp access token format");
  }

  const response = await fetch(
    `https://${dc}.api.mailchimp.com/3.0/lists/${listId}/members?count=100`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Mailchimp API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as { members?: MailchimpMember[] };
  const members: MailchimpMember[] = data.members ?? [];

  return members
    .filter((m) => m.email_address)
    .map((m) => ({
      firstName: m.merge_fields?.FNAME || "Unknown",
      lastName: m.merge_fields?.LNAME ?? undefined,
      email: m.email_address,
      phone: m.merge_fields?.PHONE ?? undefined,
      segmentTags: [],
      crmSource: "mailchimp" as const,
      crmId: m.id,
    }));
}

// ── POST /api/projects/:id/contacts/sync ─────────────────────────────────────

export const POST = withAuth<{ id: string }>(async (request: NextRequest, { params, auth }) => {
  const { accountId } = auth;
  const { id: projectId } = await params;

  try {
    // Verify project ownership
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project || project.accountId !== accountId) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Parse and validate request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = syncRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parsed.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const { provider } = parsed.data;

    // Load integration for the account
    const [integration] = await db
      .select()
      .from(integrations)
      .where(
        and(eq(integrations.accountId, accountId), eq(integrations.provider, provider)),
      )
      .limit(1);

    if (!integration) {
      return NextResponse.json(
        {
          error: `No ${provider} integration found. Please connect your ${provider} account first.`,
        },
        { status: 400 },
      );
    }

    // Decrypt the access token before using it
    let accessToken: string;
    try {
      accessToken = decrypt(integration.accessToken);
    } catch (err) {
      console.error(`[CRM Sync] Failed to decrypt ${provider} access token:`, err);
      return NextResponse.json(
        { error: `Failed to decrypt ${provider} access token. Please reconnect the integration.` },
        { status: 500 },
      );
    }

    // Fetch contacts from the CRM
    let crmContacts: Array<Omit<NewContact, "projectId">>;
    try {
      switch (provider) {
        case "hubspot":
          crmContacts = await fetchHubSpotContacts(accessToken);
          break;
        case "intercom":
          crmContacts = await fetchIntercomContacts(accessToken);
          break;
        case "mailchimp":
          crmContacts = await fetchMailchimpContacts(
            accessToken,
            (integration.config as Record<string, unknown>) ?? {},
          );
          break;
        default:
          throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (err) {
      console.error(`[CRM Sync] ${provider} API error:`, err);
      return NextResponse.json(
        {
          error: `Failed to fetch contacts from ${provider}`,
          details: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }

    if (crmContacts.length === 0) {
      return NextResponse.json({
        synced: 0,
        skipped: 0,
        message: `No contacts found in ${provider}`,
      });
    }

    // Determine which CRM IDs already exist in the project to avoid duplicates
    const incomingCrmIds = crmContacts
      .map((c) => c.crmId)
      .filter((id): id is string => !!id);

    const existingContacts = await db
      .select({ crmId: contacts.crmId, id: contacts.id, segmentTags: contacts.segmentTags })
      .from(contacts)
      .where(
        and(
          eq(contacts.projectId, projectId),
          eq(contacts.crmSource, provider),
          inArray(contacts.crmId, incomingCrmIds),
        ),
      );

    const existingCrmIdSet = new Set(existingContacts.map((c) => c.crmId));

    // Only insert contacts that don't already exist
    const newContacts = crmContacts.filter(
      (c) => c.crmId && !existingCrmIdSet.has(c.crmId),
    );

    let insertedCount = 0;
    if (newContacts.length > 0) {
      const insertValues = newContacts.map((c) => ({
        ...c,
        projectId,
      }));

      const inserted = await db
        .insert(contacts)
        .values(insertValues)
        .returning({ id: contacts.id });

      insertedCount = inserted.length;
    }

    const skippedCount = crmContacts.length - newContacts.length;

    // Push existing segment tags back to the CRM for contacts that already exist
    // and have tags set in the platform.
    const contactsWithTags = existingContacts.filter(
      (c) => c.segmentTags && c.segmentTags.length > 0 && c.crmId,
    );

    if (contactsWithTags.length > 0) {
      try {
        if (provider === "hubspot") {
          await bulkPushTagsToHubSpot(
            accessToken,
            contactsWithTags.map((c) => ({
              hubspotContactId: c.crmId!,
              tags: c.segmentTags,
            })),
          );
        } else if (provider === "intercom") {
          // Push tags to each Intercom contact individually
          for (const contact of contactsWithTags) {
            await pushTagsToIntercom(accessToken, contact.crmId!, contact.segmentTags);
          }
        }
      } catch (err) {
        // Non-fatal: log but don't fail the sync
        console.warn(`[CRM Sync] Failed to push tags back to ${provider}:`, err);
      }
    }

    // Update the integration's updatedAt timestamp
    await db
      .update(integrations)
      .set({ updatedAt: sql`now()` })
      .where(eq(integrations.id, integration.id));

    return NextResponse.json({
      synced: insertedCount,
      skipped: skippedCount,
      message:
        insertedCount > 0
          ? `Successfully synced ${insertedCount} new contact(s) from ${provider}` +
            (skippedCount > 0 ? ` (${skippedCount} already existed)` : "")
          : `All ${skippedCount} contact(s) from ${provider} already exist in this project`,
    });
  } catch (err) {
    console.error("[POST /api/projects/:id/contacts/sync] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
});
