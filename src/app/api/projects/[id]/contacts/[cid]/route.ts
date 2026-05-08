import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { contacts } from "@/db/schema/contacts";
import { projects } from "@/db/schema/projects";
import { withAuth } from "@/lib/require-auth";

// ── Validation schemas ───────────────────────────────────────────────────────

const updateContactSchema = z.object({
  first_name: z.string().min(1).max(255).optional(),
  last_name: z.string().max(255).nullable().optional(),
  email: z.string().email("Invalid email address").nullable().optional(),
  phone: z.string().min(1).max(50).nullable().optional(),
  /** Full replacement of segment tags */
  segment_tags: z.array(z.string().min(1)).optional(),
  /** Tags to add to the existing list */
  add_tags: z.array(z.string().min(1)).optional(),
  /** Tags to remove from the existing list */
  remove_tags: z.array(z.string().min(1)).optional(),
});

// ── Shared helpers ───────────────────────────────────────────────────────────

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

async function loadContact(contactId: string, projectId: string) {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.projectId, projectId)))
    .limit(1);

  return contact ?? null;
}

// ── GET /api/projects/:id/contacts/:cid ──────────────────────────────────────

/**
 * Returns a single contact by ID.
 *
 * Responses:
 *   200 — Contact object.
 *   401 — Not authenticated.
 *   404 — Project or contact not found.
 *   500 — Unexpected server error.
 */
export const GET = withAuth<{ id: string; cid: string }>(
  async (request, { params, auth }) => {
    const { accountId } = auth;
    const { id: projectId, cid: contactId } = await params;

    try {
      const project = await verifyProjectOwnership(projectId, accountId);
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }

      const contact = await loadContact(contactId, projectId);
      if (!contact) {
        return NextResponse.json({ error: "Contact not found" }, { status: 404 });
      }

      return NextResponse.json(contact);
    } catch (err) {
      console.error("[GET /api/projects/:id/contacts/:cid] Unexpected error:", err);
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 }
      );
    }
  }
);

// ── PATCH /api/projects/:id/contacts/:cid ────────────────────────────────────

/**
 * Updates a contact's fields and/or segment tags.
 *
 * Request body (JSON, all fields optional):
 *   {
 *     first_name?: string,
 *     last_name?: string | null,
 *     email?: string | null,
 *     phone?: string | null,
 *     segment_tags?: string[]   — full replacement
 *     add_tags?: string[]       — additive update
 *     remove_tags?: string[]    — subtractive update
 *   }
 *
 * Responses:
 *   200 — Updated contact object.
 *   400 — Validation error.
 *   401 — Not authenticated.
 *   404 — Project or contact not found.
 *   500 — Unexpected server error.
 */
export const PATCH = withAuth<{ id: string; cid: string }>(
  async (request, { params, auth }) => {
    const { accountId } = auth;
    const { id: projectId, cid: contactId } = await params;

    // Parse and validate request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = updateContactSchema.safeParse(body);
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

    try {
      const project = await verifyProjectOwnership(projectId, accountId);
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }

      const contact = await loadContact(contactId, projectId);
      if (!contact) {
        return NextResponse.json({ error: "Contact not found" }, { status: 404 });
      }

      const {
        first_name,
        last_name,
        email,
        phone,
        segment_tags,
        add_tags,
        remove_tags,
      } = parsed.data;

      // Build update payload
      const updateValues: Partial<typeof contacts.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (first_name !== undefined) updateValues.firstName = first_name;
      if (last_name !== undefined) updateValues.lastName = last_name ?? undefined;
      if (email !== undefined) updateValues.email = email ?? undefined;
      if (phone !== undefined) updateValues.phone = phone ?? undefined;

      // Handle segment tag management
      if (segment_tags !== undefined) {
        // Full replacement
        updateValues.segmentTags = segment_tags;
      } else if (add_tags !== undefined || remove_tags !== undefined) {
        // Additive/subtractive update
        let current = contact.segmentTags ?? [];

        if (add_tags && add_tags.length > 0) {
          const existing = new Set(current);
          for (const tag of add_tags) {
            if (!existing.has(tag)) {
              current = [...current, tag];
              existing.add(tag);
            }
          }
        }

        if (remove_tags && remove_tags.length > 0) {
          const toRemove = new Set(remove_tags);
          current = current.filter((tag) => !toRemove.has(tag));
        }

        updateValues.segmentTags = current;
      }

      // Validate that at least one contact channel remains after update
      const finalEmail = email !== undefined ? email : contact.email;
      const finalPhone = phone !== undefined ? phone : contact.phone;
      if (!finalEmail && !finalPhone) {
        return NextResponse.json(
          { error: "At least one of email or phone is required" },
          { status: 400 }
        );
      }

      const [updated] = await db
        .update(contacts)
        .set(updateValues)
        .where(and(eq(contacts.id, contactId), eq(contacts.projectId, projectId)))
        .returning();

      return NextResponse.json(updated);
    } catch (err) {
      console.error("[PATCH /api/projects/:id/contacts/:cid] Unexpected error:", err);
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 }
      );
    }
  }
);

// ── DELETE /api/projects/:id/contacts/:cid ───────────────────────────────────

/**
 * Permanently deletes a contact.
 *
 * Responses:
 *   200 — { message: "Contact deleted" }
 *   401 — Not authenticated.
 *   404 — Project or contact not found.
 *   500 — Unexpected server error.
 */
export const DELETE = withAuth<{ id: string; cid: string }>(
  async (request, { params, auth }) => {
    const { accountId } = auth;
    const { id: projectId, cid: contactId } = await params;

    try {
      const project = await verifyProjectOwnership(projectId, accountId);
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }

      const contact = await loadContact(contactId, projectId);
      if (!contact) {
        return NextResponse.json({ error: "Contact not found" }, { status: 404 });
      }

      await db
        .delete(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.projectId, projectId)));

      return NextResponse.json({ message: "Contact deleted" });
    } catch (err) {
      console.error("[DELETE /api/projects/:id/contacts/:cid] Unexpected error:", err);
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 }
      );
    }
  }
);
