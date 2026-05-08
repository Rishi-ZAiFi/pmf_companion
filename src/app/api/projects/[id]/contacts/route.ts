import { NextRequest, NextResponse } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { contacts } from "@/db/schema/contacts";
import { projects } from "@/db/schema/projects";
import { withAuth } from "@/lib/require-auth";
import { writeAuditLog } from "@/lib/audit-log";

// ── Validation schemas ───────────────────────────────────────────────────────

const createContactSchema = z.object({
  first_name: z.string().min(1, "First name is required").max(255),
  last_name: z.string().max(255).optional(),
  email: z.string().email("Invalid email address").optional(),
  phone: z.string().min(1).max(50).optional(),
  segment_tags: z.array(z.string().min(1)).optional().default([]),
  crm_source: z.enum(["hubspot", "intercom", "mailchimp", "csv"]).optional(),
  crm_id: z.string().optional(),
}).refine(
  (data) => data.email || data.phone,
  {
    message: "At least one of email or phone is required",
    path: ["email"],
  }
);

// ── Shared helper: verify project ownership ──────────────────────────────────

async function verifyProjectOwnership(projectId: string, accountId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project || project.accountId !== accountId) {
    return null;
  }

  return project;
}

// ── GET /api/projects/:id/contacts ───────────────────────────────────────────

/**
 * Lists all contacts for a project with pagination.
 *
 * Query parameters:
 *   page?: number (default 1)
 *   limit?: number (default 50, max 100)
 *   segment?: string (filter by segment tag)
 *
 * Responses:
 *   200 — { contacts: Contact[], total: number, page: number, limit: number }
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 */
export const GET = withAuth<{ id: string }>(async (request, { params, auth }) => {
  const { accountId } = auth;
  const { id: projectId } = await params;

  try {
    // Verify project ownership
    const project = await verifyProjectOwnership(projectId, accountId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
    const segmentFilter = searchParams.get("segment");

    const offset = (page - 1) * limit;

    // Build query
    let query = db
      .select()
      .from(contacts)
      .where(eq(contacts.projectId, projectId))
      .orderBy(desc(contacts.createdAt))
      .limit(limit)
      .offset(offset);

    // Apply segment filter if provided
    if (segmentFilter) {
      query = db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.projectId, projectId),
            sql`${segmentFilter} = ANY(${contacts.segmentTags})`
          )
        )
        .orderBy(desc(contacts.createdAt))
        .limit(limit)
        .offset(offset);
    }

    const contactsList = await query;

    // Get total count
    const [{ value: total }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(contacts)
      .where(eq(contacts.projectId, projectId));

    // Write audit log (non-blocking)
    void writeAuditLog({
      accountId,
      actorId: accountId,
      action: "contact.read",
      resourceType: "contact",
      resourceId: projectId,
      metadata: {
        projectId,
        page,
        limit,
        total,
        segmentFilter: segmentFilter ?? null,
      },
    });

    return NextResponse.json({
      contacts: contactsList,
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error("[GET /api/projects/:id/contacts] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    );
  }
});

// ── POST /api/projects/:id/contacts ──────────────────────────────────────────

/**
 * Creates a single contact for a project.
 *
 * Request body (JSON):
 *   {
 *     first_name: string,
 *     last_name?: string,
 *     email?: string,
 *     phone?: string,
 *     segment_tags?: string[],
 *     crm_source?: "hubspot" | "intercom" | "mailchimp" | "csv",
 *     crm_id?: string
 *   }
 *
 * At least one of email or phone is required.
 *
 * Responses:
 *   201 — Created contact object.
 *   400 — Validation error.
 *   401 — Not authenticated.
 *   404 — Project not found or does not belong to account.
 *   500 — Unexpected server error.
 */
export const POST = withAuth<{ id: string }>(async (request, { params, auth }) => {
  const { accountId } = auth;
  const { id: projectId } = await params;

  try {
    // Verify project ownership
    const project = await verifyProjectOwnership(projectId, accountId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Parse and validate request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = createContactSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parsed.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 }
      );
    }

    const {
      first_name,
      last_name,
      email,
      phone,
      segment_tags,
      crm_source,
      crm_id,
    } = parsed.data;

    // Insert contact
    const [created] = await db
      .insert(contacts)
      .values({
        projectId,
        firstName: first_name,
        lastName: last_name,
        email,
        phone,
        segmentTags: segment_tags,
        crmSource: crm_source,
        crmId: crm_id,
      })
      .returning();

    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    console.error("[POST /api/projects/:id/contacts] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    );
  }
});
