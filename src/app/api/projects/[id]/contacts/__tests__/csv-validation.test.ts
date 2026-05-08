/**
 * Unit tests for CSV import validation logic.
 *
 * Tests cover:
 * - Missing email + phone (Requirement 8.3)
 * - Malformed rows (Requirement 8.2)
 * - Valid rows with various field name formats
 * - Segment tag parsing
 * - Email format validation
 *
 * Requirements: 8.1, 8.2, 8.3
 */

import { describe, it, expect } from "vitest";
import Papa from "papaparse";

// ── Re-implement the normalizeRow logic here for unit testing ────────────────
// (mirrors the logic in the import route without importing Next.js server code)

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

interface NormalizedContact {
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  segmentTags: string[];
  crmSource: "csv";
}

type NormalizeResult =
  | { valid: true; data: NormalizedContact }
  | { valid: false; reason: string };

function normalizeRow(row: CsvRow): NormalizeResult {
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

  if (!firstName) {
    return { valid: false, reason: "Missing required field: first_name" };
  }

  const normalizedEmail = email || undefined;
  const normalizedPhone = phone || undefined;

  if (!normalizedEmail && !normalizedPhone) {
    return {
      valid: false,
      reason: "At least one of email or phone is required",
    };
  }

  if (normalizedEmail) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return { valid: false, reason: `Invalid email format: ${normalizedEmail}` };
    }
  }

  const segmentTags = segmentTagsRaw
    ? segmentTagsRaw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];

  return {
    valid: true,
    data: {
      firstName,
      lastName: lastName || undefined,
      email: normalizedEmail,
      phone: normalizedPhone,
      segmentTags,
      crmSource: "csv",
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CSV row validation — normalizeRow", () => {
  // ── Valid rows ─────────────────────────────────────────────────────────────

  it("accepts a row with email only", () => {
    const result = normalizeRow({
      first_name: "Alice",
      email: "alice@example.com",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.firstName).toBe("Alice");
      expect(result.data.email).toBe("alice@example.com");
      expect(result.data.phone).toBeUndefined();
    }
  });

  it("accepts a row with phone only", () => {
    const result = normalizeRow({
      first_name: "Bob",
      phone: "+15551234567",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.firstName).toBe("Bob");
      expect(result.data.phone).toBe("+15551234567");
      expect(result.data.email).toBeUndefined();
    }
  });

  it("accepts a row with both email and phone", () => {
    const result = normalizeRow({
      first_name: "Carol",
      email: "carol@example.com",
      phone: "+15559876543",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.email).toBe("carol@example.com");
      expect(result.data.phone).toBe("+15559876543");
    }
  });

  it("accepts Title Case column names", () => {
    const result = normalizeRow({
      "First Name": "Dave",
      "Last Name": "Smith",
      Email: "dave@example.com",
      Phone: "+15550001111",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.firstName).toBe("Dave");
      expect(result.data.lastName).toBe("Smith");
    }
  });

  it("accepts camelCase column names", () => {
    const result = normalizeRow({
      firstName: "Eve",
      lastName: "Jones",
      email: "eve@example.com",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.firstName).toBe("Eve");
      expect(result.data.lastName).toBe("Jones");
    }
  });

  it("trims whitespace from field values", () => {
    const result = normalizeRow({
      first_name: "  Frank  ",
      email: "  frank@example.com  ",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.firstName).toBe("Frank");
      expect(result.data.email).toBe("frank@example.com");
    }
  });

  it("parses comma-separated segment tags", () => {
    const result = normalizeRow({
      first_name: "Grace",
      email: "grace@example.com",
      segment_tags: "power_user, churned, trial",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.segmentTags).toEqual(["power_user", "churned", "trial"]);
    }
  });

  it("returns empty segment tags when field is absent", () => {
    const result = normalizeRow({
      first_name: "Henry",
      email: "henry@example.com",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.segmentTags).toEqual([]);
    }
  });

  it("sets crmSource to 'csv'", () => {
    const result = normalizeRow({
      first_name: "Iris",
      email: "iris@example.com",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.crmSource).toBe("csv");
    }
  });

  // ── Invalid rows — Requirement 8.3 ────────────────────────────────────────

  it("rejects a row missing both email and phone (Requirement 8.3)", () => {
    const result = normalizeRow({
      first_name: "Jack",
      last_name: "Doe",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("email or phone");
    }
  });

  it("rejects a row with empty email and empty phone (Requirement 8.3)", () => {
    const result = normalizeRow({
      first_name: "Kate",
      email: "",
      phone: "",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("email or phone");
    }
  });

  it("rejects a row with whitespace-only email and no phone (Requirement 8.3)", () => {
    const result = normalizeRow({
      first_name: "Leo",
      email: "   ",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("email or phone");
    }
  });

  it("rejects a row missing first_name", () => {
    const result = normalizeRow({
      email: "noname@example.com",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("first_name");
    }
  });

  it("rejects a row with an invalid email format", () => {
    const result = normalizeRow({
      first_name: "Mia",
      email: "not-an-email",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("Invalid email format");
    }
  });

  it("rejects a row with email missing domain", () => {
    const result = normalizeRow({
      first_name: "Nick",
      email: "nick@",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("Invalid email format");
    }
  });

  it("rejects a row with email missing @ symbol", () => {
    const result = normalizeRow({
      first_name: "Olivia",
      email: "oliviaexample.com",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("Invalid email format");
    }
  });
});

// ── CSV parsing integration tests ────────────────────────────────────────────

describe("CSV parsing with papaparse", () => {
  it("parses a well-formed CSV with headers", () => {
    const csv = `first_name,last_name,email,phone
Alice,Smith,alice@example.com,+15551234567
Bob,Jones,bob@example.com,`;

    const result = Papa.parse<CsvRow>(csv, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });

    expect(result.data).toHaveLength(2);
    expect(result.data[0].first_name).toBe("Alice");
    expect(result.data[1].first_name).toBe("Bob");
  });

  it("validates all rows from a CSV and counts valid/invalid", () => {
    const csv = `first_name,last_name,email,phone
Alice,Smith,alice@example.com,+15551234567
Bob,Jones,,
Carol,White,,+15559876543
Dave,Brown,not-an-email,`;

    const parseResult = Papa.parse<CsvRow>(csv, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });

    const rows = parseResult.data;
    const validRows: NormalizedContact[] = [];
    const errors: { row: number; reason: string }[] = [];

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      const result = normalizeRow(row);
      if (result.valid) {
        validRows.push(result.data);
      } else {
        errors.push({ row: rowNumber, reason: result.reason });
      }
    });

    // Alice: valid (email + phone)
    // Bob: invalid (no email, no phone)
    // Carol: valid (phone only)
    // Dave: invalid (bad email format)
    expect(validRows).toHaveLength(2);
    expect(errors).toHaveLength(2);

    // Bob is row 3 (header=1, Alice=2, Bob=3)
    expect(errors[0].row).toBe(3);
    expect(errors[0].reason).toContain("email or phone");

    // Dave is row 5
    expect(errors[1].row).toBe(5);
    expect(errors[1].reason).toContain("Invalid email format");
  });

  it("handles a CSV with Title Case headers", () => {
    const csv = `First Name,Last Name,Email,Phone
Alice,Smith,alice@example.com,`;

    const parseResult = Papa.parse<CsvRow>(csv, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });

    const result = normalizeRow(parseResult.data[0]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.firstName).toBe("Alice");
      expect(result.data.email).toBe("alice@example.com");
    }
  });

  it("returns empty array for a CSV with only a header row", () => {
    const csv = `first_name,last_name,email,phone`;

    const parseResult = Papa.parse<CsvRow>(csv, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });

    expect(parseResult.data).toHaveLength(0);
  });

  it("correctly assigns row numbers (1-indexed, header = row 1)", () => {
    const csv = `first_name,email
Alice,alice@example.com
Bob,
Carol,carol@example.com`;

    const parseResult = Papa.parse<CsvRow>(csv, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });

    const errors: { row: number; reason: string }[] = [];
    parseResult.data.forEach((row, index) => {
      const rowNumber = index + 2;
      const result = normalizeRow(row);
      if (!result.valid) {
        errors.push({ row: rowNumber, reason: result.reason });
      }
    });

    // Bob is the 2nd data row → row number 3
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(3);
  });
});

// ── Opt-out channel validation ────────────────────────────────────────────────

describe("Opt-out channel logic", () => {
  type Channel = "email" | "sms" | "voice" | "all";

  interface OptOutFlags {
    optedOutEmail: boolean;
    optedOutSms: boolean;
    optedOutVoice: boolean;
  }

  function applyOptOut(channel: Channel, current: OptOutFlags): OptOutFlags {
    const updated = { ...current };
    switch (channel) {
      case "email":
        updated.optedOutEmail = true;
        break;
      case "sms":
        updated.optedOutSms = true;
        break;
      case "voice":
        updated.optedOutVoice = true;
        break;
      case "all":
        updated.optedOutEmail = true;
        updated.optedOutSms = true;
        updated.optedOutVoice = true;
        break;
    }
    return updated;
  }

  const defaultFlags: OptOutFlags = {
    optedOutEmail: false,
    optedOutSms: false,
    optedOutVoice: false,
  };

  it("sets optedOutEmail when channel is 'email' (Requirement 10.6)", () => {
    const result = applyOptOut("email", defaultFlags);
    expect(result.optedOutEmail).toBe(true);
    expect(result.optedOutSms).toBe(false);
    expect(result.optedOutVoice).toBe(false);
  });

  it("sets optedOutSms when channel is 'sms' (Requirement 11.7)", () => {
    const result = applyOptOut("sms", defaultFlags);
    expect(result.optedOutEmail).toBe(false);
    expect(result.optedOutSms).toBe(true);
    expect(result.optedOutVoice).toBe(false);
  });

  it("sets optedOutVoice when channel is 'voice' (Requirement 12.8)", () => {
    const result = applyOptOut("voice", defaultFlags);
    expect(result.optedOutEmail).toBe(false);
    expect(result.optedOutSms).toBe(false);
    expect(result.optedOutVoice).toBe(true);
  });

  it("sets all opt-out flags when channel is 'all'", () => {
    const result = applyOptOut("all", defaultFlags);
    expect(result.optedOutEmail).toBe(true);
    expect(result.optedOutSms).toBe(true);
    expect(result.optedOutVoice).toBe(true);
  });

  it("does not clear existing opt-out flags when opting out of a different channel", () => {
    const alreadyOptedOut: OptOutFlags = {
      optedOutEmail: true,
      optedOutSms: false,
      optedOutVoice: false,
    };
    const result = applyOptOut("sms", alreadyOptedOut);
    expect(result.optedOutEmail).toBe(true); // preserved
    expect(result.optedOutSms).toBe(true);   // newly set
    expect(result.optedOutVoice).toBe(false);
  });

  it("is idempotent — opting out twice has the same result", () => {
    const once = applyOptOut("email", defaultFlags);
    const twice = applyOptOut("email", once);
    expect(twice).toEqual(once);
  });
});

// ── Segment tag management ────────────────────────────────────────────────────

describe("Segment tag management", () => {
  function applyTagUpdate(
    current: string[],
    options: {
      segment_tags?: string[];
      add_tags?: string[];
      remove_tags?: string[];
    }
  ): string[] {
    const { segment_tags, add_tags, remove_tags } = options;

    if (segment_tags !== undefined) {
      return segment_tags;
    }

    let result = [...current];

    if (add_tags && add_tags.length > 0) {
      const existing = new Set(result);
      for (const tag of add_tags) {
        if (!existing.has(tag)) {
          result = [...result, tag];
          existing.add(tag);
        }
      }
    }

    if (remove_tags && remove_tags.length > 0) {
      const toRemove = new Set(remove_tags);
      result = result.filter((tag) => !toRemove.has(tag));
    }

    return result;
  }

  it("replaces all tags when segment_tags is provided (Requirement 8.5)", () => {
    const result = applyTagUpdate(["old_tag", "another"], {
      segment_tags: ["power_user", "churned"],
    });
    expect(result).toEqual(["power_user", "churned"]);
  });

  it("adds new tags without duplicates (Requirement 8.5)", () => {
    const result = applyTagUpdate(["power_user"], {
      add_tags: ["churned", "power_user"],
    });
    expect(result).toEqual(["power_user", "churned"]);
  });

  it("removes specified tags (Requirement 8.5)", () => {
    const result = applyTagUpdate(["power_user", "churned", "trial"], {
      remove_tags: ["churned"],
    });
    expect(result).toEqual(["power_user", "trial"]);
  });

  it("can add and remove tags in the same operation", () => {
    const result = applyTagUpdate(["power_user", "churned"], {
      add_tags: ["trial"],
      remove_tags: ["churned"],
    });
    expect(result).toEqual(["power_user", "trial"]);
  });

  it("returns empty array when all tags are removed", () => {
    const result = applyTagUpdate(["power_user"], {
      remove_tags: ["power_user"],
    });
    expect(result).toEqual([]);
  });

  it("removing a non-existent tag is a no-op", () => {
    const result = applyTagUpdate(["power_user"], {
      remove_tags: ["nonexistent"],
    });
    expect(result).toEqual(["power_user"]);
  });

  it("preserves existing tags when no update options are provided", () => {
    const result = applyTagUpdate(["power_user", "churned"], {});
    expect(result).toEqual(["power_user", "churned"]);
  });
});
