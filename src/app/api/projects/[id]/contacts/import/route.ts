import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import Papa from "papaparse";
import { db } from "@/db/client";
import { contacts, type NewContact } from "@/db/schema/contacts";
import { projects } from "@/db/schema/projects";
import { withAuth } from "@/lib/require-auth";

// ── Types ────────────────────────────────────────────────────────────────────

interface CsvRow {
  first_name?: string;
  firstName?: string;
  "First Name"?: string;
  last_name?: string;
  lastName?: string;
  "Last Name"?: string;
  email?: string;
  Email?: string;
  phone?: string;
  Phone?: string;
  segment_tags?: string;
  segmentTags?: string;
  "Segment Tags"?: string;
  [key: string]: string | undefined;
}

interface ValidationError {
  row: number;
  reason: string;
}

interface ValidRow {
  rowIndex: number;
  data: NewContact;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalizes a CSV row by trying multiple common column name variants.
 */
function normalizeRow(row: CsvRow, projectId: string): { valid: true; data: NewContact } | { valid: false; reason: string } {
  // Normalize field names (case-insensitive, snake_case, camelCase, "Title Case")
  const firstName =
    row.first_name?.trim() ||
    row.firstName?.trim() ||
    row["First Name"]?.trim() ||
    row["first name"]?.trim() ||
    "";

  const lastName =
    row.last_name?.trim() ||
    row.lastName?.trim() ||
    row["Last Name"]?.trim() ||
    row["last name"]?.trim() ||
    undefined;

  const email =
    row.email?.trim() ||
    row.Email?.trim() ||
    row["Email Address"]?.trim() ||
    row["email address"]?.trim() ||
    undefined;

  const phone =
    row.phone?.trim() ||
    row.Phone?.trim() ||
    row["Phone Number"]?.trim() ||
    row["phone number"]?.trim() ||
    undefined;

  const segmentTagsRaw =
    row.segment_tags?.trim() ||
    row.segmentTags?.trim() ||
    row["Segment Tags"]?.trim() ||
    row["segment tags"]?.trim() ||
    "";

  // Validate: first_name is required
  if (!firstName) {
    return { valid: false, reason: "Missing required field: first_name" };
  }

  // Validate: at least one of email or phone is required (Requirement 8.3)
  const normalizedEmail = email || undefined;
  const normalizedPhone = phone || undefined;

  if (!normalizedEmail && !normalizedPhone) {
    return {
      valid: false,
      reason: "At least one of email or phone is required",
    };
  }

  // Validate email format if provided
  if (normalizedEmail) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return { valid: false, reason: `Invalid email format: ${normalizedEmail}` };
    }
  }

  // Parse segment tags (comma-separated)
  const segmentTags = segmentTagsRaw
    ? segmentTagsRaw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];

  return {
    valid: true,
    data: {
      projectId,
      firstName,
      lastName: lastName || undefined,
      email: normalizedEmail,
      phone: normalizedPhone,
      segmentTags,
      crmSource: "csv",
    },
  };
}

// ── POST /api/projects/:id/contacts/import ───────────────────────────────────

/**
 * Imports contacts from a CSV file.
 *
 * Accepts a multipart/form-data request with a `file` field containing the CSV.
 *
 * The endpoint:
 * 1. Parses the CSV using papaparse
 * 2. Validates each row (requires at least one of email or phone)
 * 3. Returns a validation summary (valid/invalid counts with row numbers and error reasons)
 * 4. Bulk-inserts valid rows
 *
 * Responses:
 *   200 — {
 *     summary: { total: number, valid: number, invalid: number },
 *     errors: [{ row: number, reason: string }],
 *     imported: number
 *   }
 *   400 — Missing file or invalid CSV.
 *   401 — Not authenticated.
 *   404 — Project not found.
 *   500 — Unexpected server error.
 *
 * Requirements: 8.1, 8.2, 8.3
 */
export const POST = withAuth<{ id: string }>(async (request, { params, auth }) => {
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

    // Parse multipart form data
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid multipart form data" },
        { status: 400 }
      );
    }

    const file = formData.get("file");
    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { error: "Missing required field: file" },
        { status: 400 }
      );
    }

    // Read file content
    const csvText = await file.text();
    if (!csvText.trim()) {
      return NextResponse.json(
        { error: "CSV file is empty" },
        { status: 400 }
      );
    }

    // Parse CSV with papaparse
    const parseResult = Papa.parse<CsvRow>(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim(),
    });

    if (parseResult.errors.length > 0 && parseResult.data.length === 0) {
      return NextResponse.json(
        {
          error: "Failed to parse CSV file",
          details: parseResult.errors.map((e) => e.message),
        },
        { status: 400 }
      );
    }

    const rows = parseResult.data;

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "CSV file contains no data rows" },
        { status: 400 }
      );
    }

    // Validate each row
    const validRows: ValidRow[] = [];
    const errors: ValidationError[] = [];

    rows.forEach((row, index) => {
      // Row numbers are 1-indexed (row 1 = first data row after header)
      const rowNumber = index + 2; // +2 because row 1 is the header
      const result = normalizeRow(row, projectId);

      if (result.valid) {
        validRows.push({ rowIndex: rowNumber, data: result.data });
      } else {
        errors.push({ row: rowNumber, reason: result.reason });
      }
    });

    // Bulk-insert valid rows
    let importedCount = 0;
    if (validRows.length > 0) {
      const insertValues = validRows.map((r) => r.data);

      // Use INSERT ... ON CONFLICT DO NOTHING to handle potential duplicates
      // (no unique constraint on contacts, so this just inserts all valid rows)
      const inserted = await db
        .insert(contacts)
        .values(insertValues)
        .returning({ id: contacts.id });

      importedCount = inserted.length;
    }

    return NextResponse.json({
      summary: {
        total: rows.length,
        valid: validRows.length,
        invalid: errors.length,
      },
      errors,
      imported: importedCount,
    });
  } catch (err) {
    console.error("[POST /api/projects/:id/contacts/import] Unexpected error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    );
  }
});
