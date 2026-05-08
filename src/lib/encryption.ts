/**
 * encryption.ts
 *
 * AES-256-GCM symmetric encryption helpers for storing sensitive values
 * (e.g. OAuth access tokens) at rest in the database.
 *
 * Format of an encrypted value (base64-encoded):
 *   <12-byte IV> | <ciphertext> | <16-byte auth tag>
 *
 * The ENCRYPTION_KEY environment variable must be a 64-character hex string
 * (32 bytes). Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Requirements: 22.1 (AES-256 encryption at rest for integration tokens)
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

// ── Key resolution ────────────────────────────────────────────────────────────

/**
 * Resolve the encryption key from the environment.
 * Returns `null` if `ENCRYPTION_KEY` is not set (encryption is optional for
 * development environments; callers should handle the null case gracefully).
 */
function resolveKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) return null;
  return Buffer.from(hex, "hex");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Returns a base64-encoded string containing the IV, ciphertext, and auth tag
 * concatenated together. The result is safe to store in a TEXT database column.
 *
 * If `ENCRYPTION_KEY` is not configured, the plaintext is returned as-is with
 * a `plain:` prefix so callers can detect unencrypted values.
 *
 * @param plaintext - The value to encrypt (e.g. an OAuth access token).
 * @returns Base64-encoded encrypted value, or `plain:<value>` if no key is set.
 */
export function encrypt(plaintext: string): string {
  const key = resolveKey();

  if (!key) {
    // No encryption key configured — store as plaintext with a marker.
    // This is acceptable in development but should not happen in production.
    console.warn(
      "[encryption] ENCRYPTION_KEY not set — storing token as plaintext. " +
        "Set ENCRYPTION_KEY in production.",
    );
    return `plain:${plaintext}`;
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Concatenate: IV (12) + ciphertext (variable) + auth tag (16)
  const combined = Buffer.concat([iv, encrypted, authTag]);
  return combined.toString("base64");
}

/**
 * Decrypt a value previously encrypted with `encrypt()`.
 *
 * Handles both encrypted values (base64) and the `plain:` fallback produced
 * when no encryption key was configured at write time.
 *
 * @param encryptedValue - The base64-encoded encrypted value from the database.
 * @returns The original plaintext string.
 * @throws If decryption fails (wrong key, corrupted data, or invalid auth tag).
 */
export function decrypt(encryptedValue: string): string {
  // Handle the unencrypted fallback marker
  if (encryptedValue.startsWith("plain:")) {
    return encryptedValue.slice("plain:".length);
  }

  const key = resolveKey();
  if (!key) {
    throw new Error(
      "[encryption] ENCRYPTION_KEY is not set but the stored value appears to be encrypted. " +
        "Set ENCRYPTION_KEY to decrypt stored tokens.",
    );
  }

  const combined = Buffer.from(encryptedValue, "base64");

  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("[encryption] Encrypted value is too short to be valid.");
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
