# Security: Encryption Strategy

This document describes how the Market Signal Platform satisfies **Requirement 22.1** — AES-256 encryption at rest for all stored user data, contact records, signal data, and call recordings.

---

## 1. Integration Access Tokens (field-level AES-256-GCM)

**Scope:** OAuth access tokens and shared secrets for all third-party integrations (Slack, HubSpot, Intercom, Notion, Segment).

**Implementation:** `src/lib/encryption.ts`

All integration credentials are encrypted with AES-256-GCM before being written to the `integrations.access_token` column and decrypted on read. The encrypted format is:

```
base64( IV[12 bytes] | ciphertext | AuthTag[16 bytes] )
```

- **Algorithm:** AES-256-GCM (authenticated encryption — provides both confidentiality and integrity)
- **Key:** 256-bit key sourced from the `ENCRYPTION_KEY` environment variable (64-character hex string)
- **IV:** 96-bit random IV generated per encryption operation via `crypto.randomBytes(12)`
- **Auth tag:** 128-bit GCM authentication tag, verified on decryption to detect tampering

Every OAuth callback (`/api/integrations/*/callback`) calls `encrypt(accessToken)` before the database insert/upsert. The Segment integration encrypts its HMAC shared secret the same way.

**Key generation:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 2. Call Recordings (S3 server-side encryption — SSE-S3 AES-256)

**Scope:** Voice call recordings uploaded to AWS S3 via `src/lib/s3.ts`.

**Implementation:** `src/lib/s3.ts` — `uploadRecordingFromUrl()`

Every `PutObjectCommand` includes `ServerSideEncryption: 'AES256'`, which instructs S3 to apply SSE-S3 (AES-256) encryption to the object at rest. AWS manages the encryption keys transparently; each object is encrypted with a unique data key that is itself encrypted under an S3-managed master key.

```typescript
new PutObjectCommand({
  Bucket: env.AWS_S3_BUCKET,
  Key: key,
  Body: buffer,
  ContentType: contentType,
  ServerSideEncryption: 'AES256',  // SSE-S3 AES-256
})
```

For stronger key control, this can be upgraded to SSE-KMS (`ServerSideEncryption: 'aws:kms'`) with a customer-managed KMS key.

---

## 3. Contact Records (database-level AES-256 via AWS RDS encryption)

**Scope:** The `contacts` table, which stores PII: `first_name`, `last_name`, `email`, `phone`.

**Implementation:** AWS RDS instance encryption (infrastructure layer).

Contact PII is protected at the storage layer by enabling **AWS RDS encryption** on the PostgreSQL instance. RDS encryption uses AES-256 to encrypt the underlying EBS volumes, automated backups, read replicas, and snapshots. This is configured at instance creation time and cannot be disabled after the fact.

In addition, **Row-Level Security (RLS)** policies scoped to `app.current_account_id` enforce tenant isolation at the database level — no cross-account data access is possible even if application-layer authorization is bypassed.

For field-level encryption of contact PII (e.g., encrypting `email` and `phone` columns individually), the `encrypt()`/`decrypt()` helpers in `src/lib/encryption.ts` can be applied before write and after read. This would be the recommended next step for higher-sensitivity deployments.

---

## 4. Signal Data and Other Tables

Signal data, transcripts, and other platform data are protected by the same AWS RDS AES-256 volume encryption described in section 3. Tenant isolation is enforced via RLS on all `project_id`-scoped tables.

---

## Summary

| Data Type | Encryption Mechanism | Algorithm |
|---|---|---|
| Integration OAuth tokens | Field-level (application layer) | AES-256-GCM |
| Segment shared secrets | Field-level (application layer) | AES-256-GCM |
| Call recordings (S3) | S3 SSE-S3 (object storage layer) | AES-256 |
| Contact PII (PostgreSQL) | RDS volume encryption (storage layer) | AES-256 |
| All other DB data | RDS volume encryption (storage layer) | AES-256 |

---

## Environment Variables

| Variable | Description |
|---|---|
| `ENCRYPTION_KEY` | 64-character hex string (32 bytes) used as the AES-256 key for field-level encryption. Required in production. |
| `AWS_S3_BUCKET` | S3 bucket name for call recording storage. |
| `AWS_REGION` | AWS region for S3 and RDS. |
