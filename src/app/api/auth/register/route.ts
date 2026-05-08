import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { accounts } from "@/db/schema/accounts";

// ── Validation schema ────────────────────────────────────────────────────────

const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().optional(),
});

// ── POST /api/auth/register ──────────────────────────────────────────────────

/**
 * Registers a new account with email and password.
 *
 * Request body (JSON):
 *   { email: string, password: string, name?: string }
 *
 * Responses:
 *   201 — Account created. Returns { id, email, name, planTier }.
 *   400 — Validation error. Returns { error, details }.
 *   409 — Email already registered. Returns { error }.
 *   500 — Unexpected server error. Returns { error }.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Parse and validate request body ──────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = registerSchema.safeParse(body);
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

  const { email, password, name } = parsed.data;

  try {
    // ── 2. Check for duplicate email ───────────────────────────────────────
    const [existing] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.email, email))
      .limit(1);

    if (existing) {
      return NextResponse.json(
        { error: "An account with this email address already exists" },
        { status: 409 },
      );
    }

    // ── 3. Hash password ───────────────────────────────────────────────────
    const passwordHash = await bcrypt.hash(password, 12);

    // ── 4. Insert new account row ──────────────────────────────────────────
    const [created] = await db
      .insert(accounts)
      .values({
        email,
        name: name ?? null,
        passwordHash,
      })
      .returning({
        id: accounts.id,
        email: accounts.email,
        name: accounts.name,
        planTier: accounts.planTier,
      });

    // ── 5. Return created account (no password hash) ───────────────────────
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    console.error("[POST /api/auth/register] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
