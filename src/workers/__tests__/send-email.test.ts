/**
 * Unit tests for the send-email worker helper functions.
 *
 * Tests cover:
 * - Opt-out link generation (token encoding, URL format)
 * - Email body personalization (first name, segment context, fallback messages)
 * - Subject extraction from campaign script
 * - Opt-out footer inclusion in every email
 *
 * Requirements: 10.1, 10.2, 22.5
 */

import { describe, it, expect } from "vitest";

// ── Helpers extracted for unit testing ───────────────────────────────────────
// These mirror the private helpers in send-email.ts so we can test them
// without importing the worker (which would try to connect to Redis/DB).

const APP_URL = "https://app.marketsignal.io";

function buildOptOutLink(contactId: string): string {
  const token = Buffer.from(contactId).toString("base64url");
  return `${APP_URL}/optout?token=${token}`;
}

function buildEmailBody(
  contact: { firstName: string; segmentTags: string[] },
  campaign: { script: unknown; goal: string; name: string },
  optOutLink: string,
): { subject: string; html: string; text: string } {
  const script = campaign.script as Record<string, unknown>;
  let openingMessage = "";
  let subject = `Quick question about ${campaign.name}`;

  if (script && typeof script === "object") {
    const turns = script.turns as Array<{ prompt?: string; message?: string }> | undefined;
    if (Array.isArray(turns) && turns.length > 0) {
      openingMessage = turns[0]?.prompt ?? turns[0]?.message ?? "";
    } else if (typeof script.opening === "string") {
      openingMessage = script.opening;
    } else if (typeof script.message === "string") {
      openingMessage = script.message;
    }

    if (typeof script.subject === "string") {
      subject = script.subject;
    }
  }

  const greeting = `Hi ${contact.firstName},`;

  const segmentContext =
    contact.segmentTags.length > 0
      ? `\n\nAs a ${contact.segmentTags.join(", ")} user, your perspective is especially valuable to us.`
      : "";

  if (!openingMessage) {
    openingMessage = `I'd love to get your feedback on our product. It will only take a few minutes.`;
  }

  openingMessage = openingMessage.replace(/\{firstName\}/gi, contact.firstName);

  const textBody = [
    greeting,
    "",
    openingMessage,
    segmentContext,
    "",
    "Please reply directly to this email to share your thoughts.",
    "",
    "---",
    `To opt out of future emails, click here: ${optOutLink}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <p>${greeting}</p>
  <p>${openingMessage.replace(/\n/g, "<br>")}</p>
  ${segmentContext ? `<p>${segmentContext.trim()}</p>` : ""}
  <p>Please reply directly to this email to share your thoughts.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  <p style="font-size: 12px; color: #999;">
    To opt out of future emails, <a href="${optOutLink}" style="color: #999;">click here</a>.
  </p>
</body>
</html>`.trim();

  return { subject, html: htmlBody, text: textBody };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildOptOutLink", () => {
  it("should produce a URL with the correct base path", () => {
    const link = buildOptOutLink("contact-123");
    expect(link).toMatch(/^https:\/\/app\.marketsignal\.io\/optout\?token=/);
  });

  it("should encode the contact ID as base64url", () => {
    const contactId = "550e8400-e29b-41d4-a716-446655440000";
    const link = buildOptOutLink(contactId);
    const token = link.split("token=")[1];
    // Decode and verify round-trip
    const decoded = Buffer.from(token!, "base64url").toString("utf8");
    expect(decoded).toBe(contactId);
  });

  it("should use base64url encoding (no +, /, or = padding)", () => {
    // Use a contact ID that would produce padding in standard base64
    const contactId = "abc";
    const link = buildOptOutLink(contactId);
    const token = link.split("token=")[1]!;
    // base64url must not contain +, /, or = characters
    expect(token).not.toMatch(/[+/=]/);
  });

  it("should produce different tokens for different contact IDs", () => {
    const link1 = buildOptOutLink("contact-1");
    const link2 = buildOptOutLink("contact-2");
    expect(link1).not.toBe(link2);
  });

  it("should produce a stable token for the same contact ID", () => {
    const contactId = "stable-id-123";
    const link1 = buildOptOutLink(contactId);
    const link2 = buildOptOutLink(contactId);
    expect(link1).toBe(link2);
  });

  it("should handle UUID contact IDs correctly", () => {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const link = buildOptOutLink(uuid);
    const token = link.split("token=")[1]!;
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    expect(decoded).toBe(uuid);
  });
});

describe("buildEmailBody — personalization (Requirement 10.2)", () => {
  const optOutLink = "https://app.marketsignal.io/optout?token=abc123";

  it("should include the contact's first name in the greeting", () => {
    const { text } = buildEmailBody(
      { firstName: "Alice", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "PMF Survey" },
      optOutLink,
    );
    expect(text).toContain("Hi Alice,");
  });

  it("should replace {firstName} placeholder in the script message", () => {
    const { text } = buildEmailBody(
      { firstName: "Bob", segmentTags: [] },
      {
        script: { opening: "Hey {firstName}, we'd love your feedback!" },
        goal: "pmf_survey",
        name: "Survey",
      },
      optOutLink,
    );
    expect(text).toContain("Hey Bob, we'd love your feedback!");
    expect(text).not.toContain("{firstName}");
  });

  it("should replace {firstName} case-insensitively", () => {
    const { text } = buildEmailBody(
      { firstName: "Carol", segmentTags: [] },
      {
        script: { opening: "Hello {FIRSTNAME}, quick question!" },
        goal: "pmf_survey",
        name: "Survey",
      },
      optOutLink,
    );
    expect(text).toContain("Hello Carol, quick question!");
  });

  it("should include segment context when contact has segment tags", () => {
    const { text } = buildEmailBody(
      { firstName: "Dave", segmentTags: ["power_user", "churned"] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(text).toContain("power_user, churned");
    expect(text).toContain("your perspective is especially valuable");
  });

  it("should not include segment context when contact has no segment tags", () => {
    const { text } = buildEmailBody(
      { firstName: "Eve", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(text).not.toContain("your perspective is especially valuable");
  });

  it("should use a fallback message when script has no opening", () => {
    const { text } = buildEmailBody(
      { firstName: "Frank", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(text).toContain("I'd love to get your feedback on our product");
  });

  it("should extract opening from script.turns[0].prompt", () => {
    const { text } = buildEmailBody(
      { firstName: "Grace", segmentTags: [] },
      {
        script: {
          turns: [
            { prompt: "What's your biggest challenge with our product?" },
            { prompt: "Follow-up question" },
          ],
        },
        goal: "pain_point_discovery",
        name: "Discovery",
      },
      optOutLink,
    );
    expect(text).toContain("What's your biggest challenge with our product?");
  });

  it("should extract opening from script.turns[0].message when prompt is absent", () => {
    const { text } = buildEmailBody(
      { firstName: "Hank", segmentTags: [] },
      {
        script: {
          turns: [{ message: "Hi, we'd love your thoughts!" }],
        },
        goal: "pmf_survey",
        name: "Survey",
      },
      optOutLink,
    );
    expect(text).toContain("Hi, we'd love your thoughts!");
  });

  it("should extract opening from script.opening when turns is absent", () => {
    const { text } = buildEmailBody(
      { firstName: "Iris", segmentTags: [] },
      {
        script: { opening: "We value your feedback as a customer." },
        goal: "pmf_survey",
        name: "Survey",
      },
      optOutLink,
    );
    expect(text).toContain("We value your feedback as a customer.");
  });

  it("should extract opening from script.message as last fallback", () => {
    const { text } = buildEmailBody(
      { firstName: "Jack", segmentTags: [] },
      {
        script: { message: "Quick question for you!" },
        goal: "pmf_survey",
        name: "Survey",
      },
      optOutLink,
    );
    expect(text).toContain("Quick question for you!");
  });
});

describe("buildEmailBody — subject line", () => {
  const optOutLink = "https://app.marketsignal.io/optout?token=abc123";

  it("should use default subject when script has no subject field", () => {
    const { subject } = buildEmailBody(
      { firstName: "Alice", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "My Campaign" },
      optOutLink,
    );
    expect(subject).toBe("Quick question about My Campaign");
  });

  it("should use script.subject when provided", () => {
    const { subject } = buildEmailBody(
      { firstName: "Alice", segmentTags: [] },
      {
        script: { subject: "We'd love your feedback!" },
        goal: "pmf_survey",
        name: "My Campaign",
      },
      optOutLink,
    );
    expect(subject).toBe("We'd love your feedback!");
  });
});

describe("buildEmailBody — opt-out link inclusion (Requirement 22.5)", () => {
  const optOutLink = "https://app.marketsignal.io/optout?token=test-token";

  it("should include the opt-out link in the plain text body", () => {
    const { text } = buildEmailBody(
      { firstName: "Alice", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(text).toContain(optOutLink);
  });

  it("should include the opt-out link in the HTML body", () => {
    const { html } = buildEmailBody(
      { firstName: "Alice", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(html).toContain(optOutLink);
  });

  it("should include opt-out link even when contact has segment tags", () => {
    const { text } = buildEmailBody(
      { firstName: "Bob", segmentTags: ["power_user"] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(text).toContain(optOutLink);
  });

  it("should include opt-out link even when script has a custom opening", () => {
    const { text } = buildEmailBody(
      { firstName: "Carol", segmentTags: [] },
      {
        script: { opening: "Custom opening message." },
        goal: "pmf_survey",
        name: "Survey",
      },
      optOutLink,
    );
    expect(text).toContain(optOutLink);
  });

  it("should include opt-out text label in plain text body", () => {
    const { text } = buildEmailBody(
      { firstName: "Dave", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(text).toContain("To opt out of future emails");
  });

  it("should include opt-out anchor in HTML body", () => {
    const { html } = buildEmailBody(
      { firstName: "Eve", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(html).toContain('<a href="');
    expect(html).toContain("click here");
  });
});

describe("buildEmailBody — HTML structure", () => {
  const optOutLink = "https://app.marketsignal.io/optout?token=abc";

  it("should produce valid HTML with DOCTYPE", () => {
    const { html } = buildEmailBody(
      { firstName: "Alice", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("should include the greeting in the HTML body", () => {
    const { html } = buildEmailBody(
      { firstName: "Alice", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(html).toContain("Hi Alice,");
  });

  it("should include segment context paragraph in HTML when tags present", () => {
    const { html } = buildEmailBody(
      { firstName: "Bob", segmentTags: ["trial"] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(html).toContain("trial");
    expect(html).toContain("your perspective is especially valuable");
  });

  it("should not include segment context paragraph in HTML when no tags", () => {
    const { html } = buildEmailBody(
      { firstName: "Carol", segmentTags: [] },
      { script: {}, goal: "pmf_survey", name: "Survey" },
      optOutLink,
    );
    expect(html).not.toContain("your perspective is especially valuable");
  });
});

describe("opt-out token round-trip", () => {
  it("should decode back to the original contact ID", () => {
    const contactId = "550e8400-e29b-41d4-a716-446655440000";
    const link = buildOptOutLink(contactId);
    const token = new URL(link).searchParams.get("token")!;
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    expect(decoded).toBe(contactId);
  });

  it("should handle contact IDs with special characters after encoding", () => {
    // UUIDs contain only hex chars and hyphens, but test robustness
    const contactId = "test-contact-id-12345";
    const link = buildOptOutLink(contactId);
    const token = new URL(link).searchParams.get("token")!;
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    expect(decoded).toBe(contactId);
  });
});
