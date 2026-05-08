-- Migration: 0004_add_password_hash
-- Adds the password_hash column to the accounts table.
--
-- This column stores the bcrypt hash of the account password for
-- email/password authentication. It is nullable because accounts
-- created via Google OAuth do not have a password.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS password_hash TEXT;
