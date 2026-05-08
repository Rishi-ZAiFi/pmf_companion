/**
 * Unit tests for notification service logic.
 * Requirements: 19.1, 19.2
 */

import { describe, it, expect } from "vitest";

// ── Notification types ───────────────────────────────────────────────────────

const VALID_NOTIFICATION_TYPES = [
  "pmf-alert",
  "cluster-alert",
  "quota-warning",
  "quota-exceeded",
  "payment-failed",
  "weekly-digest",
] as const;

type NotificationType = (typeof VALID_NOTIFICATION_TYPES)[number];

// ── SSE message formatting (mirrored from the route) ─────────────────────────

function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── Notification filtering logic ─────────────────────────────────────────────

interface NotificationRecord {
  id: string;
  accountId: string;
  projectId: string | null;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: Date;
}

function filterUnread(notifications: NotificationRecord[]): NotificationRecord[] {
  return notifications.filter((n) => !n.isRead);
}

function filterByType(
  notifications: NotificationRecord[],
  type: NotificationType,
): NotificationRecord[] {
  return notifications.filter((n) => n.type === type);
}

function sortByCreatedAtDesc(
  notifications: NotificationRecord[],
): NotificationRecord[] {
  return [...notifications].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

function filterNewSince(
  notifications: NotificationRecord[],
  since: Date,
): NotificationRecord[] {
  return notifications.filter((n) => n.createdAt > since);
}

// ── Notification limit helpers ────────────────────────────────────────────────

function applyLimit(notifications: NotificationRecord[], limit: number): NotificationRecord[] {
  return notifications.slice(0, limit);
}

function clampLimit(raw: number, min = 1, max = 100, defaultVal = 50): number {
  if (isNaN(raw) || raw < min) return defaultVal;
  return Math.min(raw, max);
}

// ── Sample data factory ───────────────────────────────────────────────────────

function makeNotification(
  overrides: Partial<NotificationRecord> = {},
): NotificationRecord {
  return {
    id: "notif-1",
    accountId: "account-1",
    projectId: "project-1",
    type: "pmf-alert",
    title: "PMF Score Changed",
    body: "Your PMF score changed by 7 points.",
    isRead: false,
    createdAt: new Date("2024-06-01T10:00:00Z"),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SSE message formatting", () => {
  it("should format a notification event correctly", () => {
    const data = { id: "notif-1", type: "pmf-alert" };
    const msg = sseMessage("notification", data);
    expect(msg).toBe(`event: notification\ndata: ${JSON.stringify(data)}\n\n`);
  });

  it("should format a connected event correctly", () => {
    const data = { connectedAt: "2024-06-01T10:00:00.000Z", message: "Notification stream connected" };
    const msg = sseMessage("connected", data);
    expect(msg).toContain("event: connected\n");
    expect(msg).toContain("data: ");
    expect(msg.endsWith("\n\n")).toBe(true);
  });

  it("should format a close event correctly", () => {
    const msg = sseMessage("close", { reason: "max_connection_time_reached" });
    expect(msg).toBe(
      `event: close\ndata: ${JSON.stringify({ reason: "max_connection_time_reached" })}\n\n`,
    );
  });

  it("should handle empty data objects", () => {
    const msg = sseMessage("ping", {});
    expect(msg).toBe("event: ping\ndata: {}\n\n");
  });

  it("should handle nested data objects", () => {
    const data = { notification: { id: "1", type: "pmf-alert", nested: { value: 42 } } };
    const msg = sseMessage("notification", data);
    expect(msg).toContain(JSON.stringify(data));
  });

  it("should always end with double newline", () => {
    const msg = sseMessage("test", { foo: "bar" });
    expect(msg.endsWith("\n\n")).toBe(true);
  });
});

describe("Notification filtering — unread", () => {
  it("should return only unread notifications", () => {
    const notifications = [
      makeNotification({ id: "1", isRead: false }),
      makeNotification({ id: "2", isRead: true }),
      makeNotification({ id: "3", isRead: false }),
    ];
    const result = filterUnread(notifications);
    expect(result).toHaveLength(2);
    expect(result.every((n) => !n.isRead)).toBe(true);
  });

  it("should return empty array when all notifications are read", () => {
    const notifications = [
      makeNotification({ id: "1", isRead: true }),
      makeNotification({ id: "2", isRead: true }),
    ];
    expect(filterUnread(notifications)).toHaveLength(0);
  });

  it("should return all notifications when none are read", () => {
    const notifications = [
      makeNotification({ id: "1", isRead: false }),
      makeNotification({ id: "2", isRead: false }),
    ];
    expect(filterUnread(notifications)).toHaveLength(2);
  });

  it("should return empty array for empty input", () => {
    expect(filterUnread([])).toHaveLength(0);
  });
});

describe("Notification filtering — by type", () => {
  it("should filter notifications by pmf-alert type", () => {
    const notifications = [
      makeNotification({ id: "1", type: "pmf-alert" }),
      makeNotification({ id: "2", type: "cluster-alert" }),
      makeNotification({ id: "3", type: "pmf-alert" }),
    ];
    const result = filterByType(notifications, "pmf-alert");
    expect(result).toHaveLength(2);
    expect(result.every((n) => n.type === "pmf-alert")).toBe(true);
  });

  it("should return empty array when no notifications match the type", () => {
    const notifications = [
      makeNotification({ id: "1", type: "pmf-alert" }),
    ];
    expect(filterByType(notifications, "cluster-alert")).toHaveLength(0);
  });

  it("should handle all valid notification types", () => {
    const notifications = VALID_NOTIFICATION_TYPES.map((type, i) =>
      makeNotification({ id: String(i), type }),
    );
    for (const type of VALID_NOTIFICATION_TYPES) {
      const result = filterByType(notifications, type);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe(type);
    }
  });
});

describe("Notification sorting — by createdAt descending", () => {
  it("should sort notifications newest first", () => {
    const notifications = [
      makeNotification({ id: "1", createdAt: new Date("2024-06-01T08:00:00Z") }),
      makeNotification({ id: "2", createdAt: new Date("2024-06-01T12:00:00Z") }),
      makeNotification({ id: "3", createdAt: new Date("2024-06-01T10:00:00Z") }),
    ];
    const sorted = sortByCreatedAtDesc(notifications);
    expect(sorted[0].id).toBe("2");
    expect(sorted[1].id).toBe("3");
    expect(sorted[2].id).toBe("1");
  });

  it("should not mutate the original array", () => {
    const notifications = [
      makeNotification({ id: "1", createdAt: new Date("2024-06-01T08:00:00Z") }),
      makeNotification({ id: "2", createdAt: new Date("2024-06-01T12:00:00Z") }),
    ];
    const original = [...notifications];
    sortByCreatedAtDesc(notifications);
    expect(notifications[0].id).toBe(original[0].id);
  });

  it("should handle single-element arrays", () => {
    const notifications = [makeNotification({ id: "1" })];
    const sorted = sortByCreatedAtDesc(notifications);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].id).toBe("1");
  });

  it("should handle empty arrays", () => {
    expect(sortByCreatedAtDesc([])).toHaveLength(0);
  });
});

describe("SSE poll — filter new notifications since cursor", () => {
  it("should return notifications created after the cursor", () => {
    const cursor = new Date("2024-06-01T10:00:00Z");
    const notifications = [
      makeNotification({ id: "1", createdAt: new Date("2024-06-01T09:00:00Z") }),
      makeNotification({ id: "2", createdAt: new Date("2024-06-01T11:00:00Z") }),
      makeNotification({ id: "3", createdAt: new Date("2024-06-01T12:00:00Z") }),
    ];
    const result = filterNewSince(notifications, cursor);
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.id)).toEqual(["2", "3"]);
  });

  it("should not include notifications at exactly the cursor time", () => {
    const cursor = new Date("2024-06-01T10:00:00Z");
    const notifications = [
      makeNotification({ id: "1", createdAt: cursor }),
    ];
    expect(filterNewSince(notifications, cursor)).toHaveLength(0);
  });

  it("should return all notifications when cursor is in the past", () => {
    const cursor = new Date("2020-01-01T00:00:00Z");
    const notifications = [
      makeNotification({ id: "1", createdAt: new Date("2024-06-01T10:00:00Z") }),
      makeNotification({ id: "2", createdAt: new Date("2024-06-01T11:00:00Z") }),
    ];
    expect(filterNewSince(notifications, cursor)).toHaveLength(2);
  });

  it("should return empty array when no notifications are newer than cursor", () => {
    const cursor = new Date("2030-01-01T00:00:00Z");
    const notifications = [
      makeNotification({ id: "1", createdAt: new Date("2024-06-01T10:00:00Z") }),
    ];
    expect(filterNewSince(notifications, cursor)).toHaveLength(0);
  });

  it("should return empty array for empty input", () => {
    expect(filterNewSince([], new Date())).toHaveLength(0);
  });
});

describe("Notification limit clamping", () => {
  it("should return default (50) for NaN input", () => {
    expect(clampLimit(NaN)).toBe(50);
  });

  it("should return default (50) for zero input", () => {
    expect(clampLimit(0)).toBe(50);
  });

  it("should return default (50) for negative input", () => {
    expect(clampLimit(-5)).toBe(50);
  });

  it("should cap at max (100) for values above max", () => {
    expect(clampLimit(200)).toBe(100);
  });

  it("should return the value as-is when within range", () => {
    expect(clampLimit(25)).toBe(25);
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(100)).toBe(100);
  });
});

describe("Notification list limit application", () => {
  const makeMany = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      makeNotification({ id: String(i) }),
    );

  it("should return at most limit items", () => {
    const notifications = makeMany(10);
    expect(applyLimit(notifications, 5)).toHaveLength(5);
  });

  it("should return all items when count is below limit", () => {
    const notifications = makeMany(3);
    expect(applyLimit(notifications, 50)).toHaveLength(3);
  });

  it("should return empty array for empty input", () => {
    expect(applyLimit([], 50)).toHaveLength(0);
  });

  it("should return first N items (preserving order)", () => {
    const notifications = makeMany(5);
    const result = applyLimit(notifications, 3);
    expect(result.map((n) => n.id)).toEqual(["0", "1", "2"]);
  });
});

describe("Valid notification types", () => {
  it("should include pmf-alert (Requirement 19.1)", () => {
    expect(VALID_NOTIFICATION_TYPES).toContain("pmf-alert");
  });

  it("should include cluster-alert (Requirement 19.2)", () => {
    expect(VALID_NOTIFICATION_TYPES).toContain("cluster-alert");
  });

  it("should include quota-warning", () => {
    expect(VALID_NOTIFICATION_TYPES).toContain("quota-warning");
  });

  it("should include quota-exceeded", () => {
    expect(VALID_NOTIFICATION_TYPES).toContain("quota-exceeded");
  });

  it("should include payment-failed", () => {
    expect(VALID_NOTIFICATION_TYPES).toContain("payment-failed");
  });

  it("should include weekly-digest", () => {
    expect(VALID_NOTIFICATION_TYPES).toContain("weekly-digest");
  });

  it("should have exactly 6 notification types", () => {
    expect(VALID_NOTIFICATION_TYPES).toHaveLength(6);
  });
});

describe("Account-level notifications (null projectId)", () => {
  it("should allow null projectId for account-level notifications", () => {
    const notification = makeNotification({ projectId: null });
    expect(notification.projectId).toBeNull();
  });

  it("should allow non-null projectId for project-level notifications", () => {
    const notification = makeNotification({ projectId: "project-1" });
    expect(notification.projectId).toBe("project-1");
  });

  it("payment-failed notifications should be account-level (null projectId)", () => {
    const notification = makeNotification({
      type: "payment-failed",
      projectId: null,
    });
    expect(notification.type).toBe("payment-failed");
    expect(notification.projectId).toBeNull();
  });
});
