-- Migration: 0005_add_notification_preferences
-- Adds the notification_preferences JSONB column to the accounts table.
--
-- This column stores per-account notification type preferences.
-- Each key is a notification type and the value is a boolean:
--   true  = enabled (default)
--   false = disabled (founder has opted out)
--
-- Supported notification types:
--   pmf-alert, cluster-alert, quota-warning, quota-exceeded,
--   payment-failed, weekly-digest
--
-- Requirements: 19.4

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{
    "pmf-alert": true,
    "cluster-alert": true,
    "quota-warning": true,
    "quota-exceeded": true,
    "payment-failed": true,
    "weekly-digest": true
  }'::jsonb;
