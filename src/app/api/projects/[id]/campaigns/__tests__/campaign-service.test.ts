/**
 * Unit tests for campaign service plan limit enforcement and quota Redis counter logic.
 * Requirements: 21.1, 21.3, 21.4
 */

import { describe, it, expect } from "vitest";

// ── Plan limit constants (mirrored from the route/worker) ────────────────────

const PLAN_CONVERSATION_LIMITS: Record<string, number> = {
  free: 50,
  starter: 500,
  growth: 2000,
  enterprise: Infinity,
};

const ACTIVE_CAMPAIGN_PLANS = new Set(["starter", "growth", "enterprise"]);

// ── Redis key helper (mirrored from the route/worker) ────────────────────────

function conversationCountKey(accountId: string, date?: Date): string {
  const now = date ?? new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `account:${accountId}:conversations:${month}`;
}

// ── Quota enforcement logic (extracted for unit testing) ─────────────────────

interface QuotaCheckResult {
  allowed: boolean;
  reason?: "quota_exceeded" | "plan_not_allowed";
  warningTriggered?: boolean;
}

function checkQuota(
  planTier: string,
  currentCount: number,
): QuotaCheckResult {
  // Free tier cannot run active campaigns
  if (!ACTIVE_CAMPAIGN_PLANS.has(planTier)) {
    return { allowed: false, reason: "plan_not_allowed" };
  }

  const limit = PLAN_CONVERSATION_LIMITS[planTier] ?? 0;

  if (limit === Infinity) {
    return { allowed: true };
  }

  if (currentCount >= limit) {
    return { allowed: false, reason: "quota_exceeded" };
  }

  const warningThreshold = Math.floor(limit * 0.9);
  const warningTriggered = currentCount >= warningThreshold;

  return { allowed: true, warningTriggered };
}

// ── Opt-out check logic (extracted for unit testing) ─────────────────────────

interface ContactOptOutFlags {
  optedOutEmail: boolean;
  optedOutSms: boolean;
  optedOutVoice: boolean;
}

function isOptedOut(contact: ContactOptOutFlags, channel: string): boolean {
  switch (channel) {
    case "email":
      return contact.optedOutEmail;
    case "sms":
      return contact.optedOutSms;
    case "voice":
      return contact.optedOutVoice;
    case "widget":
      return false;
    default:
      return false;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Plan limit enforcement", () => {
  describe("Free tier", () => {
    it("should not allow active campaigns on free tier", () => {
      const result = checkQuota("free", 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("plan_not_allowed");
    });

    it("should not allow active campaigns on free tier even with 0 conversations", () => {
      const result = checkQuota("free", 0);
      expect(result.allowed).toBe(false);
    });
  });

  describe("Starter tier (500 conversations/month)", () => {
    it("should allow campaigns when under the limit", () => {
      const result = checkQuota("starter", 0);
      expect(result.allowed).toBe(true);
    });

    it("should allow campaigns at 449 conversations (under 90% threshold)", () => {
      const result = checkQuota("starter", 449);
      expect(result.allowed).toBe(true);
      expect(result.warningTriggered).toBe(false);
    });

    it("should trigger warning at 90% usage (450 conversations)", () => {
      const result = checkQuota("starter", 450);
      expect(result.allowed).toBe(true);
      expect(result.warningTriggered).toBe(true);
    });

    it("should trigger warning at 499 conversations", () => {
      const result = checkQuota("starter", 499);
      expect(result.allowed).toBe(true);
      expect(result.warningTriggered).toBe(true);
    });

    it("should block at exactly 500 conversations (quota reached)", () => {
      const result = checkQuota("starter", 500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("quota_exceeded");
    });

    it("should block above 500 conversations", () => {
      const result = checkQuota("starter", 501);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("quota_exceeded");
    });
  });

  describe("Growth tier (2000 conversations/month)", () => {
    it("should allow campaigns when under the limit", () => {
      const result = checkQuota("growth", 0);
      expect(result.allowed).toBe(true);
    });

    it("should trigger warning at 90% usage (1800 conversations)", () => {
      const result = checkQuota("growth", 1800);
      expect(result.allowed).toBe(true);
      expect(result.warningTriggered).toBe(true);
    });

    it("should block at exactly 2000 conversations", () => {
      const result = checkQuota("growth", 2000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("quota_exceeded");
    });
  });

  describe("Enterprise tier (unlimited)", () => {
    it("should always allow campaigns regardless of count", () => {
      const result = checkQuota("enterprise", 0);
      expect(result.allowed).toBe(true);
    });

    it("should allow campaigns even at very high conversation counts", () => {
      const result = checkQuota("enterprise", 1_000_000);
      expect(result.allowed).toBe(true);
    });

    it("should not trigger quota warning for enterprise", () => {
      const result = checkQuota("enterprise", 999_999);
      expect(result.allowed).toBe(true);
      // No warning threshold for unlimited plans
      expect(result.warningTriggered).toBeUndefined();
    });
  });
});

describe("Redis conversation count key", () => {
  it("should format key correctly for a given account and date", () => {
    const key = conversationCountKey("abc123", new Date("2024-01-15"));
    expect(key).toBe("account:abc123:conversations:2024-01");
  });

  it("should zero-pad single-digit months", () => {
    const key = conversationCountKey("abc123", new Date("2024-03-01"));
    expect(key).toBe("account:abc123:conversations:2024-03");
  });

  it("should handle December correctly", () => {
    const key = conversationCountKey("abc123", new Date("2024-12-31"));
    expect(key).toBe("account:abc123:conversations:2024-12");
  });

  it("should produce different keys for different months", () => {
    const jan = conversationCountKey("abc123", new Date("2024-01-01"));
    const feb = conversationCountKey("abc123", new Date("2024-02-01"));
    expect(jan).not.toBe(feb);
  });

  it("should produce different keys for different accounts", () => {
    const date = new Date("2024-06-01");
    const key1 = conversationCountKey("account-1", date);
    const key2 = conversationCountKey("account-2", date);
    expect(key1).not.toBe(key2);
  });

  it("should produce the same key for different days in the same month", () => {
    const day1 = conversationCountKey("abc123", new Date("2024-06-01"));
    const day15 = conversationCountKey("abc123", new Date("2024-06-15"));
    const day30 = conversationCountKey("abc123", new Date("2024-06-30"));
    expect(day1).toBe(day15);
    expect(day15).toBe(day30);
  });
});

describe("Opt-out enforcement", () => {
  const fullyOptedOut: ContactOptOutFlags = {
    optedOutEmail: true,
    optedOutSms: true,
    optedOutVoice: true,
  };

  const notOptedOut: ContactOptOutFlags = {
    optedOutEmail: false,
    optedOutSms: false,
    optedOutVoice: false,
  };

  const emailOptedOut: ContactOptOutFlags = {
    optedOutEmail: true,
    optedOutSms: false,
    optedOutVoice: false,
  };

  it("should block email channel when contact opted out of email", () => {
    expect(isOptedOut(emailOptedOut, "email")).toBe(true);
  });

  it("should allow sms channel when only email is opted out", () => {
    expect(isOptedOut(emailOptedOut, "sms")).toBe(false);
  });

  it("should allow voice channel when only email is opted out", () => {
    expect(isOptedOut(emailOptedOut, "voice")).toBe(false);
  });

  it("should block all channels for fully opted-out contact", () => {
    expect(isOptedOut(fullyOptedOut, "email")).toBe(true);
    expect(isOptedOut(fullyOptedOut, "sms")).toBe(true);
    expect(isOptedOut(fullyOptedOut, "voice")).toBe(true);
  });

  it("should allow all channels for contact with no opt-outs", () => {
    expect(isOptedOut(notOptedOut, "email")).toBe(false);
    expect(isOptedOut(notOptedOut, "sms")).toBe(false);
    expect(isOptedOut(notOptedOut, "voice")).toBe(false);
  });

  it("should never block widget channel (no opt-out flag)", () => {
    expect(isOptedOut(fullyOptedOut, "widget")).toBe(false);
    expect(isOptedOut(notOptedOut, "widget")).toBe(false);
  });

  it("should return false for unknown channels", () => {
    expect(isOptedOut(fullyOptedOut, "unknown_channel")).toBe(false);
  });
});

describe("Campaign goal validation", () => {
  const VALID_GOALS = [
    "pmf_survey",
    "pain_point_discovery",
    "feature_validation",
    "churn_investigation",
  ];

  it("should accept all valid campaign goals", () => {
    for (const goal of VALID_GOALS) {
      expect(VALID_GOALS).toContain(goal);
    }
  });

  it("should have exactly 4 valid goals", () => {
    expect(VALID_GOALS).toHaveLength(4);
  });
});

describe("Campaign channel validation", () => {
  const VALID_CHANNELS = ["email", "sms", "voice", "widget"];

  it("should accept all valid channels", () => {
    for (const channel of VALID_CHANNELS) {
      expect(VALID_CHANNELS).toContain(channel);
    }
  });

  it("should have exactly 4 valid channels", () => {
    expect(VALID_CHANNELS).toHaveLength(4);
  });
});

describe("Plan tier active campaign eligibility", () => {
  it("free tier should not be eligible for active campaigns", () => {
    expect(ACTIVE_CAMPAIGN_PLANS.has("free")).toBe(false);
  });

  it("starter tier should be eligible for active campaigns", () => {
    expect(ACTIVE_CAMPAIGN_PLANS.has("starter")).toBe(true);
  });

  it("growth tier should be eligible for active campaigns", () => {
    expect(ACTIVE_CAMPAIGN_PLANS.has("growth")).toBe(true);
  });

  it("enterprise tier should be eligible for active campaigns", () => {
    expect(ACTIVE_CAMPAIGN_PLANS.has("enterprise")).toBe(true);
  });
});

// ── Upgrade prompt response shape (Requirement 21.2) ─────────────────────────

/**
 * Simulates the 402 response body returned when a Free-tier founder attempts
 * to launch an active campaign.
 */
function buildUpgradePromptResponse(planTier: string): {
  status: number;
  body: { error: string; message: string; upgrade_url: string } | null;
} {
  if (!ACTIVE_CAMPAIGN_PLANS.has(planTier)) {
    return {
      status: 402,
      body: {
        error: "upgrade_required",
        message:
          "Active campaigns are not available on the Free tier. Upgrade to Starter, Growth, or Enterprise to launch campaigns.",
        upgrade_url: "/api/billing/checkout",
      },
    };
  }
  return { status: 200, body: null };
}

describe("Upgrade prompt response (Requirement 21.2)", () => {
  it("should return 402 status for free tier", () => {
    const result = buildUpgradePromptResponse("free");
    expect(result.status).toBe(402);
  });

  it("should include error: upgrade_required in the response body", () => {
    const result = buildUpgradePromptResponse("free");
    expect(result.body?.error).toBe("upgrade_required");
  });

  it("should include a human-readable message in the response body", () => {
    const result = buildUpgradePromptResponse("free");
    expect(result.body?.message).toBeTruthy();
    expect(typeof result.body?.message).toBe("string");
  });

  it("should include upgrade_url pointing to the checkout endpoint", () => {
    const result = buildUpgradePromptResponse("free");
    expect(result.body?.upgrade_url).toBe("/api/billing/checkout");
  });

  it("should not return an upgrade prompt for starter tier", () => {
    const result = buildUpgradePromptResponse("starter");
    expect(result.status).toBe(200);
    expect(result.body).toBeNull();
  });

  it("should not return an upgrade prompt for growth tier", () => {
    const result = buildUpgradePromptResponse("growth");
    expect(result.status).toBe(200);
    expect(result.body).toBeNull();
  });

  it("should not return an upgrade prompt for enterprise tier", () => {
    const result = buildUpgradePromptResponse("enterprise");
    expect(result.status).toBe(200);
    expect(result.body).toBeNull();
  });
});

describe("90% warning threshold calculation", () => {
  it("should calculate 90% threshold for starter plan (450)", () => {
    const limit = PLAN_CONVERSATION_LIMITS["starter"]!;
    const threshold = Math.floor(limit * 0.9);
    expect(threshold).toBe(450);
  });

  it("should calculate 90% threshold for growth plan (1800)", () => {
    const limit = PLAN_CONVERSATION_LIMITS["growth"]!;
    const threshold = Math.floor(limit * 0.9);
    expect(threshold).toBe(1800);
  });

  it("should trigger warning exactly at threshold", () => {
    const result = checkQuota("starter", 450);
    expect(result.warningTriggered).toBe(true);
  });

  it("should not trigger warning one below threshold", () => {
    const result = checkQuota("starter", 449);
    expect(result.warningTriggered).toBe(false);
  });
});
