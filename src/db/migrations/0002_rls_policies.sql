-- Migration: 0002_rls_policies
-- Enables Row-Level Security on all tenant-scoped tables and creates isolation
-- policies scoped to app.current_account_id.
--
-- The application sets this session variable before executing any query:
--   SET LOCAL app.current_account_id = '<uuid>';
--
-- Tables scoped by account_id directly (accounts, notifications, integrations)
-- use a simpler policy. Tables scoped by project_id use a sub-select through
-- the projects table to resolve the owning account.

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: a reusable function that returns the current account ID from the
-- session variable, casting it to UUID. Returns NULL if not set (which causes
-- all RLS policies to deny access, protecting against unauthenticated queries).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_account_id() RETURNS UUID
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_account_id', true), '')::UUID;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- projects
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_isolation ON projects
  USING (account_id = current_account_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- signals
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY signals_isolation ON signals
  USING (
    project_id IN (
      SELECT id FROM projects WHERE account_id = current_account_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- theme_clusters
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE theme_clusters ENABLE ROW LEVEL SECURITY;

CREATE POLICY theme_clusters_isolation ON theme_clusters
  USING (
    project_id IN (
      SELECT id FROM projects WHERE account_id = current_account_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- signal_cluster_memberships
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE signal_cluster_memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY signal_cluster_memberships_isolation ON signal_cluster_memberships
  USING (
    cluster_id IN (
      SELECT tc.id
      FROM theme_clusters tc
      JOIN projects p ON p.id = tc.project_id
      WHERE p.account_id = current_account_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- contacts
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY contacts_isolation ON contacts
  USING (
    project_id IN (
      SELECT id FROM projects WHERE account_id = current_account_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- campaigns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY campaigns_isolation ON campaigns
  USING (
    project_id IN (
      SELECT id FROM projects WHERE account_id = current_account_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- conversations
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversations_isolation ON conversations
  USING (
    project_id IN (
      SELECT id FROM projects WHERE account_id = current_account_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- transcripts
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY transcripts_isolation ON transcripts
  USING (
    project_id IN (
      SELECT id FROM projects WHERE account_id = current_account_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- pmf_score_snapshots
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE pmf_score_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY pmf_score_snapshots_isolation ON pmf_score_snapshots
  USING (
    project_id IN (
      SELECT id FROM projects WHERE account_id = current_account_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- notifications
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_isolation ON notifications
  USING (account_id = current_account_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- integrations
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY integrations_isolation ON integrations
  USING (account_id = current_account_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- webhook_endpoints
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_endpoints_isolation ON webhook_endpoints
  USING (
    project_id IN (
      SELECT id FROM projects WHERE account_id = current_account_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log
-- NOTE: audit_log intentionally has NO RLS policy — it is append-only and
-- readable only by service-role / admin connections, not by tenant sessions.
-- ─────────────────────────────────────────────────────────────────────────────
