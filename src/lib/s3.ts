/**
 * S3 utilities for call recording storage and pre-signed URL generation.
 *
 * Provides:
 *   - `uploadRecordingFromUrl` — downloads a recording from a remote URL and
 *     uploads it to S3, returning the S3 object URL.
 *   - `getPresignedUrl` — generates a time-limited pre-signed URL for playback.
 *
 * Security: All objects are uploaded with `ServerSideEncryption: 'AES256'`
 * (SSE-S3), satisfying the AES-256 encryption-at-rest requirement for call
 * recordings stored in S3 (Requirement 22.1).
 *
 * Requirements: 12.7, 22.1
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

// ── S3 client singleton ───────────────────────────────────────────────────────

const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Detect the file extension from a URL path.
 * Falls back to `.mp3` if the extension cannot be determined.
 */
function detectExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(mp3|wav|ogg|m4a|aac|flac)$/i);
    return match ? match[0].toLowerCase() : ".mp3";
  } catch {
    return ".mp3";
  }
}

/**
 * Map a file extension to its MIME content type.
 */
function contentTypeForExtension(ext: string): string {
  const map: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
  };
  return map[ext] ?? "audio/mpeg";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Downloads a recording from `vapiRecordingUrl` and uploads it to S3 under
 * the given `key`. Returns the S3 object URL (`s3://<bucket>/<key>` style
 * stored as `https://<bucket>.s3.<region>.amazonaws.com/<key>`).
 *
 * The key should follow the convention: `recordings/{projectId}/{transcriptId}.mp3`
 *
 * @param vapiRecordingUrl - The Vapi-hosted recording URL (may expire).
 * @param key              - The S3 object key to store the recording under.
 * @returns The permanent S3 HTTPS URL for the uploaded object.
 * @throws If the download or upload fails.
 */
export async function uploadRecordingFromUrl(
  vapiRecordingUrl: string,
  key: string,
): Promise<string> {
  // 1. Download the recording from Vapi
  const response = await fetch(vapiRecordingUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download recording from Vapi: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const audioBuffer = await response.arrayBuffer();
  const ext = detectExtension(vapiRecordingUrl);
  const contentType = contentTypeForExtension(ext);

  // 2. Upload to S3 with server-side encryption (AES-256 / SSE-S3)
  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      Body: Buffer.from(audioBuffer),
      ContentType: contentType,
      // Enforce AES-256 server-side encryption at rest (Requirement 22.1)
      ServerSideEncryption: ServerSideEncryption.AES256,
    }),
  );

  // 3. Return the permanent S3 HTTPS URL
  const s3Url = `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
  return s3Url;
}

/**
 * Generates a pre-signed S3 URL that allows temporary read access to the
 * object at `key`. The URL expires after `expiresInSeconds` (default: 3600).
 *
 * @param key              - The S3 object key.
 * @param expiresInSeconds - How long the pre-signed URL should be valid (default 1 hour).
 * @returns A time-limited HTTPS URL for the S3 object.
 */
export async function getPresignedUrl(
  key: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}
