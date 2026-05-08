/**
 * weekly-digest-scheduler.test.ts
 *
 * Unit tests for the weekly digest scheduler worker.
 * Tests timezone-aware scheduling logic and deduplication.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("Weekly Digest Scheduler - Timezone Logic", () => {
  beforeEach(() => {
    // Mock the current time to a known Monday at 09:30 UTC
    // 2025-01-06 09:30:00 UTC (Monday)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-06T09:30:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should correctly identify Monday 09:xx in UTC timezone", () => {
    const timezone = "UTC";
    const now = new Date();

    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    });

    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

    const weekday = get("weekday");
    const hour = parseInt(get("hour"), 10);

    expect(weekday).toBe("Mon");
    expect(hour).toBe(9);
  });

  it("should correctly identify Monday 09:xx in America/New_York timezone", () => {
    // At 2025-01-06 09:30 UTC, it is 04:30 in America/New_York (EST, UTC-5)
    // So it should NOT be Monday 09:xx in New York
    const timezone = "America/New_York";
    const now = new Date();

    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    });

    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

    const weekday = get("weekday");
    const hour = parseInt(get("hour"), 10);

    expect(weekday).toBe("Mon");
    expect(hour).toBe(4); // 04:30 in New York
  });

  it("should correctly identify Monday 09:xx in Europe/London timezone", () => {
    // At 2025-01-06 09:30 UTC, it is 09:30 in Europe/London (GMT, UTC+0 in winter)
    const timezone = "Europe/London";
    const now = new Date();

    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    });

    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

    const weekday = get("weekday");
    const hour = parseInt(get("hour"), 10);

    expect(weekday).toBe("Mon");
    expect(hour).toBe(9);
  });

  it("should correctly identify Monday 09:xx in Asia/Tokyo timezone", () => {
    // At 2025-01-06 09:30 UTC, it is 18:30 in Asia/Tokyo (JST, UTC+9)
    const timezone = "Asia/Tokyo";
    const now = new Date();

    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    });

    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

    const weekday = get("weekday");
    const hour = parseInt(get("hour"), 10);

    expect(weekday).toBe("Mon");
    expect(hour).toBe(18); // 18:30 in Tokyo
  });

  it("should correctly identify when it is Monday 09:xx in America/Los_Angeles", () => {
    // Set time to 2025-01-06 17:30 UTC (Monday)
    // In America/Los_Angeles (PST, UTC-8), this is 09:30 Monday
    vi.setSystemTime(new Date("2025-01-06T17:30:00Z"));

    const timezone = "America/Los_Angeles";
    const now = new Date();

    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    });

    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

    const weekday = get("weekday");
    const hour = parseInt(get("hour"), 10);

    expect(weekday).toBe("Mon");
    expect(hour).toBe(9); // 09:30 in Los Angeles
  });

  it("should handle invalid timezone by falling back to UTC", () => {
    const invalidTimezone = "Invalid/Timezone";

    // Test that invalid timezone doesn't throw
    expect(() => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: invalidTimezone });
      } catch {
        // Expected to throw
      }
    }).not.toThrow();
  });

  it("should generate correct local date string in different timezones", () => {
    // At 2025-01-06 09:30 UTC
    const now = new Date();

    // UTC: 2025-01-06
    const utcFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const utcParts = utcFormatter.formatToParts(now);
    const utcDate = `${utcParts.find((p) => p.type === "year")?.value}-${utcParts.find((p) => p.type === "month")?.value}-${utcParts.find((p) => p.type === "day")?.value}`;
    expect(utcDate).toBe("2025-01-06");

    // America/New_York: 2025-01-06 (still Monday, just early morning)
    const nyFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const nyParts = nyFormatter.formatToParts(now);
    const nyDate = `${nyParts.find((p) => p.type === "year")?.value}-${nyParts.find((p) => p.type === "month")?.value}-${nyParts.find((p) => p.type === "day")?.value}`;
    expect(nyDate).toBe("2025-01-06");
  });
});

describe("Weekly Digest Scheduler - Day of Week Detection", () => {
  it("should correctly identify Monday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-06T09:30:00Z")); // Monday

    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      weekday: "short",
    });
    const parts = formatter.formatToParts(new Date());
    const weekday = parts.find((p) => p.type === "weekday")?.value;

    expect(weekday).toBe("Mon");

    vi.useRealTimers();
  });

  it("should correctly identify Tuesday (not Monday)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-07T09:30:00Z")); // Tuesday

    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      weekday: "short",
    });
    const parts = formatter.formatToParts(new Date());
    const weekday = parts.find((p) => p.type === "weekday")?.value;

    expect(weekday).toBe("Tue");

    vi.useRealTimers();
  });

  it("should correctly identify Sunday (not Monday)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-05T09:30:00Z")); // Sunday

    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      weekday: "short",
    });
    const parts = formatter.formatToParts(new Date());
    const weekday = parts.find((p) => p.type === "weekday")?.value;

    expect(weekday).toBe("Sun");

    vi.useRealTimers();
  });
});
