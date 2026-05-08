import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { contacts } from "@/db/schema/contacts";
import { projects } from "@/db/schema/projects";
import { withAuth } from "@/lib/require-auth";

// ── Validation schemas ───────────────────────────────────────────────────────

const optOutSchema = z.object({
  channel: z.enum(["email", "sms", "voice", "all"], {
    errorMap: () => ({
      message: "Channel must be one of: email, sms, voice, all",
    }),
  }),
});

// ── POST /api/projects/:id/contacts/:cid/optout ──────────────────────────────

/**
 * Marks a contact as opted out of one or all outreach channels.
 *
 * Request body (JSON):
 *   {
 *     channel: "email" | "sms" | "voice" | "all"
 *   }
 *
 * Sets the appropriate `opted_out_*` flag(s) on the contact, which halts
 * all outreach for that contact on the specified channel(s).
 *
 * Responses:
 *   200 — Updated contact object.
 *   400 — Validation error.
 *   401 — Not authenticated.
 *   404 — Project or contact not found.
 *   500 — Unexpected server error.
 *
 * Requirements: 10.6, 11.7, 12.8
 */
export const POST = withAuth<{ id: string; cid: string }>(
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

    const parsed = optOutSchema.safeParse(body);
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

    const { channel } = parsed.data;

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

      // Load contact
      const [contact] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.projectId, projectId)))
        .limit(1);

      if (!contact) {
        return NextResponse.json({ error: "Contact not found" }, { status: 404 });
      }

      // Build opt-out update based on channel
      const updateValues: Partial<typeof contacts.$inferInsert> = {
        updatedAt: new Date(),
      };

      switch (channel) {
        case "email":
          updateValues.optedOutEmail = true;
          break;
        case "sms":
          updateValues.optedOutSms = true;
          break;
        case "voice":
          updateValues.optedOutVoice = true;
          break;
        case "all":
          updateValues.optedOutEmail = true;
          updateValues.optedOutSms = true;
          updateValues.optedOutVoice = true;
          break;
      }

      const [updated] = await db
        .update(contacts)
        .set(updateValues)
        .where(and(eq(contacts.id, contactId), eq(contacts.projectId, projectId)))
        .returning();

      return NextResponse.json({
        contact: updated,
        message: `Contact opted out of ${channel === "all" ? "all channels" : `${channel} outreach`}`,
      });
    } catch (err) {
      console.error(
        "[POST /api/projects/:id/contacts/:cid/optout] Unexpected error:",
        err
      );
      return NextResponse.json(
        { error: "An unexpected error occurred. Please try again." },
        { status: 500 }
      );
    }
  }
);
