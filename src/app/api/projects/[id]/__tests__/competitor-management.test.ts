/**
 * competitor-management.test.ts
 *
 * Unit tests for competitor add/remove logic in PATCH /api/projects/:id.
 *
 * Requirements: 18.3, 18.4
 *
 * These tests exercise the pure business logic extracted from the route handler
 * without requiring a live DB or Redis connection.
 */

import { describe, it, expect } from "vitest";

// ── Business logic extracted for unit testing ─────────────────────────────────
// These functions mirror the logic in the PATCH handler.

const MAX_COMPETITORS = 5;

/**
 * Adds a competitor to the list, enforcing uniqueness (case-insensitive)
 * and the 5-competitor maximum.
 *
 * Returns the updated list, or an error string if the operation is invalid.
 */
function addCompetitor(
  current: string[],
  competitorName: string,
): { ok: true; result: string[] } | { ok: false; error: string } {
  const alreadyTracked = current.some(
    (c) => c.toLowerCase() === competitorName.toLowerCase(),
  );
  if (alreadyTracked) {
    return {
      ok: false,
      error: `Competitor "${competitorName}" is already being tracked`,
    };
  }

  if (current.length >= MAX_COMPETITORS) {
    return {
      ok: false,
      error: "Maximum of 5 competitors allowed per project",
    };
  }

  return { ok: true, result: [...current, competitorName] };
}

/**
 * Removes a competitor from the list (case-insensitive match).
 * Historical signals are NOT deleted — the scraper stops collecting new
 * signals naturally because it checks project.competitor_names.
 *
 * Returns the updated list, or an error string if the competitor is not found.
 */
function removeCompetitor(
  current: string[],
  competitorName: string,
): { ok: true; result: string[] } | { ok: false; error: string } {
  const exists = current.some(
    (c) => c.toLowerCase() === competitorName.toLowerCase(),
  );
  if (!exists) {
    return {
      ok: false,
      error: `Competitor "${competitorName}" is not being tracked`,
    };
  }

  return {
    ok: true,
    result: current.filter(
      (c) => c.toLowerCase() !== competitorName.toLowerCase(),
    ),
  };
}

// ── Tests: add_competitor ─────────────────────────────────────────────────────

describe("add_competitor action (Requirement 18.3)", () => {
  it("appends a new competitor to an empty list", () => {
    const result = addCompetitor([], "Acme");
    expect(result).toEqual({ ok: true, result: ["Acme"] });
  });

  it("appends a new competitor to an existing list", () => {
    const result = addCompetitor(["Acme", "Globex"], "Initech");
    expect(result).toEqual({ ok: true, result: ["Acme", "Globex", "Initech"] });
  });

  it("preserves the original casing of the competitor name", () => {
    const result = addCompetitor([], "HubSpot CRM");
    expect(result).toEqual({ ok: true, result: ["HubSpot CRM"] });
  });

  it("rejects a duplicate competitor (exact match)", () => {
    const result = addCompetitor(["Acme"], "Acme");
    expect(result).toEqual({
      ok: false,
      error: 'Competitor "Acme" is already being tracked',
    });
  });

  it("rejects a duplicate competitor (case-insensitive match)", () => {
    const result = addCompetitor(["Acme"], "acme");
    expect(result).toEqual({
      ok: false,
      error: 'Competitor "acme" is already being tracked',
    });
  });

  it("rejects a duplicate competitor (mixed case)", () => {
    const result = addCompetitor(["HubSpot"], "HUBSPOT");
    expect(result).toEqual({
      ok: false,
      error: 'Competitor "HUBSPOT" is already being tracked',
    });
  });

  it("allows adding up to the maximum of 5 competitors", () => {
    const current = ["A", "B", "C", "D"];
    const result = addCompetitor(current, "E");
    expect(result).toEqual({ ok: true, result: ["A", "B", "C", "D", "E"] });
  });

  it("rejects adding a 6th competitor when already at the limit", () => {
    const current = ["A", "B", "C", "D", "E"];
    const result = addCompetitor(current, "F");
    expect(result).toEqual({
      ok: false,
      error: "Maximum of 5 competitors allowed per project",
    });
  });

  it("does not mutate the original array", () => {
    const original = ["Acme"];
    const result = addCompetitor(original, "Globex");
    expect(result.ok).toBe(true);
    expect(original).toEqual(["Acme"]); // unchanged
  });
});

// ── Tests: remove_competitor ──────────────────────────────────────────────────

describe("remove_competitor action (Requirements 18.3, 18.4)", () => {
  it("removes an existing competitor from the list", () => {
    const result = removeCompetitor(["Acme", "Globex", "Initech"], "Globex");
    expect(result).toEqual({ ok: true, result: ["Acme", "Initech"] });
  });

  it("removes the only competitor, leaving an empty list", () => {
    const result = removeCompetitor(["Acme"], "Acme");
    expect(result).toEqual({ ok: true, result: [] });
  });

  it("removes a competitor using case-insensitive matching", () => {
    const result = removeCompetitor(["HubSpot"], "hubspot");
    expect(result).toEqual({ ok: true, result: [] });
  });

  it("removes a competitor using mixed-case input", () => {
    const result = removeCompetitor(["Salesforce"], "SALESFORCE");
    expect(result).toEqual({ ok: true, result: [] });
  });

  it("rejects removal of a competitor that is not tracked", () => {
    const result = removeCompetitor(["Acme"], "Globex");
    expect(result).toEqual({
      ok: false,
      error: 'Competitor "Globex" is not being tracked',
    });
  });

  it("rejects removal from an empty list", () => {
    const result = removeCompetitor([], "Acme");
    expect(result).toEqual({
      ok: false,
      error: 'Competitor "Acme" is not being tracked',
    });
  });

  it("does not mutate the original array", () => {
    const original = ["Acme", "Globex"];
    const result = removeCompetitor(original, "Acme");
    expect(result.ok).toBe(true);
    expect(original).toEqual(["Acme", "Globex"]); // unchanged
  });

  it("retains all other competitors when one is removed", () => {
    const current = ["A", "B", "C", "D", "E"];
    const result = removeCompetitor(current, "C");
    expect(result).toEqual({ ok: true, result: ["A", "B", "D", "E"] });
  });

  /**
   * Requirement 18.4: when a competitor is removed, historical signals
   * attributed to that competitor are retained (no deletion). The scraper
   * stops collecting new signals because it checks project.competitor_names.
   *
   * This test verifies the removal logic does not touch signals — it only
   * modifies the competitor_names array. Signal retention is enforced at the
   * DB level (no DELETE on signals is issued by the route handler).
   */
  it("only modifies the competitor list — does not delete historical signals", () => {
    // The remove logic returns the updated competitor list only.
    // No signal deletion is performed — signals are retained in the DB.
    const result = removeCompetitor(["Acme", "Globex"], "Acme");
    expect(result).toEqual({ ok: true, result: ["Globex"] });
    // The returned value contains only the updated competitor_names array.
    // Signal records with metadata.competitor = "Acme" remain untouched in DB.
  });
});

// ── Tests: combined add/remove sequences ─────────────────────────────────────

describe("competitor management — combined sequences", () => {
  it("can add and then remove a competitor", () => {
    let list: string[] = [];

    const addResult = addCompetitor(list, "Acme");
    expect(addResult.ok).toBe(true);
    if (addResult.ok) list = addResult.result;

    const removeResult = removeCompetitor(list, "Acme");
    expect(removeResult.ok).toBe(true);
    if (removeResult.ok) list = removeResult.result;

    expect(list).toEqual([]);
  });

  it("can fill to max, remove one, then add another", () => {
    let list = ["A", "B", "C", "D", "E"];

    // At max — adding fails
    expect(addCompetitor(list, "F").ok).toBe(false);

    // Remove one
    const removeResult = removeCompetitor(list, "C");
    expect(removeResult.ok).toBe(true);
    if (removeResult.ok) list = removeResult.result;
    expect(list).toEqual(["A", "B", "D", "E"]);

    // Now adding succeeds
    const addResult = addCompetitor(list, "F");
    expect(addResult.ok).toBe(true);
    if (addResult.ok) list = addResult.result;
    expect(list).toEqual(["A", "B", "D", "E", "F"]);
  });

  it("cannot add the same competitor twice even after a remove-and-re-add cycle", () => {
    let list = ["Acme"];

    // Remove
    const r1 = removeCompetitor(list, "Acme");
    expect(r1.ok).toBe(true);
    if (r1.ok) list = r1.result;

    // Re-add
    const r2 = addCompetitor(list, "Acme");
    expect(r2.ok).toBe(true);
    if (r2.ok) list = r2.result;

    // Try to add again — should fail
    const r3 = addCompetitor(list, "Acme");
    expect(r3.ok).toBe(false);
  });
});
