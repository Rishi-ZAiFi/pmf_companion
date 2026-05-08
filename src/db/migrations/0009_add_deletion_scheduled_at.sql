-- Migration: 0009_add_deletion_scheduled_at.sql
--
-- Adds the `deletion_scheduled_at` column to the `accounts` table to support
-- the data deletion endpoint (DELETE /api/accounts/me).
--
-- When a Founder requests account deletion, this timestamp is set to
-- `now() + 30 days`. A daily BullMQ worker (`process-account-deletions`)
-- checks for accounts whose deletion window has passed and permanently
-- deletes them, relying on ON DELETE CASCADE to remove all related data.
--
-- Requirements: 22.4

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ;

COMMENT ON COLUMN accounts.deletion_scheduled_at IS
  'When set, the account is scheduled for permanent deletion at this timestamp '
  '(30 days after the deletion request). NULL means no deletion is pending. '
  'Requirement 22.4.';

-- Index to make the daily deletion worker query efficient.
CREATE INDEX IF NOT EXISTS accounts_deletion_scheduled_at_idx
  ON accounts (deletion_scheduled_at)
  WHERE deletion_scheduled_at IS NOT NULL;
