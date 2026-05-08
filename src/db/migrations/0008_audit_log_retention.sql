-- Migration: 0008_audit_log_retention.sql
--
-- Implements a 90-day retention policy for the audit_log table per
-- Requirement 22.6: "retain for minimum 90 days".
--
-- APPROACH
-- ─────────
-- We use two complementary mechanisms:
--
-- 1. A PostgreSQL function `cleanup_old_audit_logs()` that deletes records
--    older than 90 days. This can be called manually or scheduled via
--    pg_cron (see below).
--
-- 2. A pg_cron scheduled job (if the pg_cron extension is available) that
--    runs the cleanup function daily at 03:00 UTC. pg_cron is available on
--    AWS RDS PostgreSQL 12+ and Supabase by default.
--
-- If pg_cron is not available in your environment, you can schedule the
-- cleanup function via an external cron job (e.g. a BullMQ repeatable job
-- or a Vercel Cron) that calls:
--   SELECT cleanup_old_audit_logs();
--
-- IMPORTANT: This migration does NOT delete any existing data. It only
-- installs the cleanup mechanism going forward.

-- ── 1. Create the cleanup function ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION cleanup_old_audit_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM audit_log
  WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$;

COMMENT ON FUNCTION cleanup_old_audit_logs() IS
  'Deletes audit_log records older than 90 days. '
  'Called by pg_cron daily or by an external scheduler. '
  'Requirement 22.6: retain audit logs for minimum 90 days.';

-- ── 2. Add an index to speed up the retention cleanup query ──────────────────
-- The cleanup DELETE filters on created_at; an index makes it efficient even
-- when the table grows large.

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx
  ON audit_log (created_at);

-- ── 3. Schedule via pg_cron (if available) ───────────────────────────────────
-- pg_cron is available on AWS RDS PostgreSQL 12+ and Supabase.
-- If the extension is not installed, this block is skipped gracefully.
--
-- The DO block catches the error so the migration succeeds even without pg_cron.

DO $$
BEGIN
  -- Attempt to create the pg_cron extension (no-op if already installed)
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'pg_cron extension requires superuser. Skipping pg_cron setup.';
      RETURN;
    WHEN OTHERS THEN
      RAISE NOTICE 'pg_cron extension not available (%). Skipping pg_cron setup.', SQLERRM;
      RETURN;
  END;

  -- Schedule the cleanup to run daily at 03:00 UTC
  -- Unschedule first to avoid duplicates on re-run
  BEGIN
    PERFORM cron.unschedule('audit-log-cleanup');
  EXCEPTION
    WHEN OTHERS THEN
      NULL; -- Job may not exist yet; ignore
  END;

  PERFORM cron.schedule(
    'audit-log-cleanup',          -- job name
    '0 3 * * *',                  -- daily at 03:00 UTC
    'SELECT cleanup_old_audit_logs()'
  );

  RAISE NOTICE 'pg_cron job "audit-log-cleanup" scheduled: daily at 03:00 UTC.';
END;
$$;
