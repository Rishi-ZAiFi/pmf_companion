/**
 * optout-token.ts
 *
 * Token-based opt-out link helpers for email and SMS outreach.
 *
 * Tokens are HMAC-SHA256 signed, URL-safe, and encode:
 *   { contactId, projectId, channel, exp }
 *
 * The token format is:
 *   base64url(JSON payload) + "." + base64url(HMAC signature)
 *
 * Tokens expire after 90 days. The signing key is derived from NEXTAUTH_SECRET
 * so no additional environment variable is required.
 *
 * Requirements: 22.5
 */

import { createHmac, timingSafeEqual } from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Token lifetime: 90 days in seconds */
const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/** HMAC algorithm */
const HMAC_ALGORITHM = "sha256";

// ── Types ─────────────────────────────────────────────────────────────────────

export type OptOutChannel = "email" | "sms" | "all";

export interface OptOutTokenPayload {
  contactId: string;
  projectId: string;
  channel: OptOutChannel;
  /** Unix timestamp (seconds) when the token expires */
  exp: number;
}

// ── Key resolution ────────────────────────────────────────────────────────────

/**
 * Resolve the signing key from the environment.
 * Uses NEXTAUTH_SECRET which is always required.
 */
function resolveSigningKey(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "[optout-token] NEXTAUTH_SECRET is not set. Cannot sign opt-out tokens.",
    );
  }
  return `optout:${secret}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Encode a Buffer or string to URL-safe base64 (no padding).
 */
function toBase64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/**
 * Compute HMAC-SHA256 over the given data using the signing key.
 */
function computeHmac(data: string, key: string): Buffer {
  return createHmac(HMAC_ALGORITHM, key).update(data).digest();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a signed opt-out token for a contact.
 *
 * The token encodes the contactId, projectId, channel, and expiry time.
 * It is signed with HMAC-SHA256 using the NEXTAUTH_SECRET.
 *
 * @param contactId - UUID of the contact opting out.
 * @param projectId - UUID of the project the contact is opting out from.
 * @param channel   - The channel to opt out of ("email" | "sms" | "all").
 * @returns A URL-safe token string suitable for use in a query parameter.
 */
export function generateOptOutToken(
  contactId: string,
  projectId: string,
  channel: OptOutChannel,
): string {
  const key = resolveSigningKey();

  const payload: OptOutTokenPayload = {
    contactId,
    projectId,
    channel,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };

  const payloadEncoded = toBase64Url(JSON.stringify(payload));
  const signature = computeHmac(payloadEncoded, key);
  const signatureEncoded = toBase64Url(signature);

  return `${payloadEncoded}.${signatureEncoded}`;
}

/**
 * Verify and decode a signed opt-out token.
 *
 * Validates the HMAC signature and checks the expiry time.
 *
 * @param token - The token string from the URL query parameter.
 * @returns The decoded payload if valid, or `null` if invalid/expired.
 */
export function verifyOptOutToken(token: string): OptOutTokenPayload | null {
  try {
    const key = resolveSigningKey();

    const dotIndex = token.lastIndexOf(".");
    if (dotIndex === -1) return null;

    const payloadEncoded = token.slice(0, dotIndex);
    const signatureEncoded = token.slice(dotIndex + 1);

    // Recompute expected signature
    const expectedSig = computeHmac(payloadEncoded, key);
    const expectedEncoded = toBase64Url(expectedSig);

    // Timing-safe comparison to prevent timing attacks
    const actualBuf = Buffer.from(signatureEncoded, "utf8");
    const expectedBuf = Buffer.from(expectedEncoded, "utf8");

    if (
      actualBuf.length !== expectedBuf.length ||
      !timingSafeEqual(actualBuf, expectedBuf)
    ) {
      return null;
    }

    // Decode payload
    const payloadJson = Buffer.from(payloadEncoded, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as OptOutTokenPayload;

    // Check expiry
    if (Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }

    // Validate required fields
    if (!payload.contactId || !payload.projectId || !payload.channel) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Build the full opt-out URL for inclusion in emails and SMS messages.
 *
 * @param contactId - UUID of the contact.
 * @param projectId - UUID of the project.
 * @param channel   - The channel to opt out of.
 * @param baseUrl   - The application base URL (e.g. https://app.marketsignal.io).
 * @returns Full opt-out URL with token query parameter.
 */
export function buildOptOutUrl(
  contactId: string,
  projectId: string,
  channel: OptOutChannel,
  baseUrl: string,
): string {
  const token = generateOptOutToken(contactId, projectId, channel);
  return `${baseUrl}/optout?token=${token}`;
}
