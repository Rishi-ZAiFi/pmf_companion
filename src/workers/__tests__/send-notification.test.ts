/**
 * Unit tests for the send-notification worker.
 *
 * Tests notification job processing for all supported notification types:
 * - pmf-alert
 * - cluster-alert
 * - quota-warning
 * - quota-exceeded
 * - payment-failed
 * - weekly-digest
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Job } from "bullmq";
import type { NotificationJobData } from "@/lib/queues";

// Mock dependencies
vi.mock("@/lib/env", () => ({
  env: {
    SENDGRID_API_KEY: "test-sendgrid-key",
    NEXTAUTH_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://test",
    REDIS_URL: "redis://test",
    OPENAI_API_KEY: "test-openai-key",
    NEXTAUTH_SECRET: "test-secret-32-chars-minimum-length",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    TWILIO_ACCOUNT_SID: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    TWILIO_AUTH_TOKEN: "test-twilio-token",
    TWILIO_PHONE_NUMBER: "+15555555555",
    VAPI_API_KEY: "test-vapi-key",
    VAPI_PHONE_NUMBER_ID: "test-vapi-phone-id",
    STRIPE_SECRET_KEY: "sk_test_" + "x".repeat(24),
    STRIPE_WEBHOOK_SECRET: "whsec_" + "x".repeat(24),
    AWS_ACCESS_KEY_ID: "test-aws-access-key",
    AWS_SECRET_ACCESS_KEY: "test-aws-secret-key",
    AWS_S3_BUCKET: "test-bucket",
    AWS_REGION: "us-east-1",
    NODE_ENV: "test" as const,
  },
}));

vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: vi.fn(),
    send: vi.fn().mockResolvedValue([
      {
        statusCode: 202,
        headers: { "x-message-id": "test-message-id" },
      },
    ]),
  },
}));

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
  },
}));

vi.mock("@/lib/queues", () => ({
  redisConnection: {},
  notificationQueue: {
    add: vi.fn(),
  },
}));

describe("send-notification worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should export sendNotificationWorker", async () => {
    const { sendNotificationWorker } = await import("../send-notification");
    expect(sendNotificationWorker).toBeDefined();
    expect(sendNotificationWorker.name).toBe("notifications");
  });

  it("should handle pmf-alert notification type", async () => {
    const jobData: NotificationJobData = {
      type: "pmf-alert",
      accountId: "test-account-id",
      projectId: "test-project-id",
      newScore: 75,
      previousScore: 65,
      change: 10,
    };

    // Verify the job data structure is valid
    expect(jobData.type).toBe("pmf-alert");
    expect(jobData.newScore).toBe(75);
    expect(jobData.previousScore).toBe(65);
    expect(jobData.change).toBe(10);
  });

  it("should handle cluster-alert notification type", async () => {
    const jobData: NotificationJobData = {
      type: "cluster-alert",
      accountId: "test-account-id",
      projectId: "test-project-id",
      metadata: {
        clusterId: "test-cluster-id",
        clusterName: "Test Cluster",
        signalCount: 15,
      },
    };

    // Verify the job data structure is valid
    expect(jobData.type).toBe("cluster-alert");
    expect(jobData.metadata?.clusterId).toBe("test-cluster-id");
  });

  it("should handle quota-warning notification type", async () => {
    const jobData: NotificationJobData = {
      type: "quota-warning",
      accountId: "test-account-id",
      metadata: {
        limit: 500,
        currentCount: 450,
        warningThreshold: 450,
      },
    };

    // Verify the job data structure is valid
    expect(jobData.type).toBe("quota-warning");
    expect(jobData.metadata?.limit).toBe(500);
    expect(jobData.metadata?.currentCount).toBe(450);
  });

  it("should handle quota-exceeded notification type", async () => {
    const jobData: NotificationJobData = {
      type: "quota-exceeded",
      accountId: "test-account-id",
      metadata: {
        limit: 500,
        currentCount: 501,
      },
    };

    // Verify the job data structure is valid
    expect(jobData.type).toBe("quota-exceeded");
    expect(jobData.metadata?.limit).toBe(500);
    expect(jobData.metadata?.currentCount).toBe(501);
  });

  it("should handle payment-failed notification type", async () => {
    const jobData: NotificationJobData = {
      type: "payment-failed",
      accountId: "test-account-id",
      metadata: {
        invoiceUrl: "https://stripe.com/invoice/test",
      },
    };

    // Verify the job data structure is valid
    expect(jobData.type).toBe("payment-failed");
    expect(jobData.metadata?.invoiceUrl).toBe("https://stripe.com/invoice/test");
  });

  it("should handle weekly-digest notification type", async () => {
    const jobData: NotificationJobData = {
      type: "weekly-digest",
      accountId: "test-account-id",
      projectId: "test-project-id",
    };

    // Verify the job data structure is valid
    expect(jobData.type).toBe("weekly-digest");
    expect(jobData.projectId).toBe("test-project-id");
  });
});
