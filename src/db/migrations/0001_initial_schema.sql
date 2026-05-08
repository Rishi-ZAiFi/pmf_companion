-- Migration: 0001_initial_schema
-- Creates all core tables for the Market Signal Platform.
-- Depends on: 0000_enable_pgvector (pgvector extension must be enabled first)

-- ─────────────────────────────────────────────────────────────────────────────
-- accounts
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT        NOT NULL UNIQUE,
  name                TEXT,
  plan_tier           TEXT        NOT NULL DEFAULT 'free',   -- free | starter | growth | enterprise
  stripe_customer_id  TEXT,
  timezone            TEXT        NOT NULL DEFAULT 'UTC',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- projects
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name                  TEXT        NOT NULL,
  description           TEXT        NOT NULL,
  icp_description       TEXT        NOT NULL,
  problem_statement     TEXT        NOT NULL,
  competitor_names      TEXT[]      NOT NULL DEFAULT '{}',
  keywords              TEXT[]      NOT NULL DEFAULT '{}',
  subreddit_candidates  TEXT[]      NOT NULL DEFAULT '{}',
  status                TEXT        NOT NULL DEFAULT 'active',  -- active | archived | deleted
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_account_id_idx ON projects(account_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- signals
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source          TEXT        NOT NULL,  -- reddit | twitter | hn | linkedin | review | email | sms | voice | widget
  signal_type     TEXT        NOT NULL,  -- pain_point | feature_request | competitor_mention | market_trend | positive_sentiment | negative_sentiment
  signal_kind     TEXT        NOT NULL DEFAULT 'passive',  -- passive | active
  content         TEXT        NOT NULL,
  source_url      TEXT,
  author          TEXT,
  relevance_score INTEGER     NOT NULL DEFAULT 0,   -- 0–100
  sentiment       TEXT,                              -- positive | neutral | negative
  pain_intensity  INTEGER,                           -- 1–10, null for passive signals
  is_opportunity  BOOLEAN     NOT NULL DEFAULT false,
  is_bookmarked   BOOLEAN     NOT NULL DEFAULT false,
  custom_label    TEXT,
  is_dismissed    BOOLEAN     NOT NULL DEFAULT false,
  embedding       vector(1536),
  status          TEXT        NOT NULL DEFAULT 'pending_embedding',  -- pending_embedding | embedded | excluded
  metadata        JSONB       NOT NULL DEFAULT '{}',
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Deduplication: one signal per (project, source URL)
  CONSTRAINT signals_project_source_url_unique UNIQUE (project_id, source_url)
);

-- B-tree index for project-scoped queries
CREATE INDEX IF NOT EXISTS signals_project_id_idx
  ON signals(project_id);

-- Composite index for feed queries ordered by recency
CREATE INDEX IF NOT EXISTS signals_ingested_at_idx
  ON signals(project_id, ingested_at DESC);

-- IVFFlat index for approximate nearest-neighbour search via pgvector.
-- lists=100 is a reasonable default for up to ~1M vectors per project.
-- Rebuild with a higher lists value as the dataset grows.
CREATE INDEX IF NOT EXISTS signals_embedding_idx
  ON signals USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ─────────────────────────────────────────────────────────────────────────────
-- theme_clusters
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS theme_clusters (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT,
  summary         TEXT,
  signal_count    INTEGER     NOT NULL DEFAULT 0,
  trend_direction TEXT        NOT NULL DEFAULT 'stable',  -- growing | stable | declining
  is_dismissed    BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS theme_clusters_project_id_idx
  ON theme_clusters(project_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- signal_cluster_memberships
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signal_cluster_memberships (
  signal_id   UUID NOT NULL REFERENCES signals(id)        ON DELETE CASCADE,
  cluster_id  UUID NOT NULL REFERENCES theme_clusters(id) ON DELETE CASCADE,
  PRIMARY KEY (signal_id, cluster_id)
);

CREATE INDEX IF NOT EXISTS scm_cluster_id_idx
  ON signal_cluster_memberships(cluster_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- contacts
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  first_name        TEXT        NOT NULL,
  last_name         TEXT,
  email             TEXT,
  phone             TEXT,
  segment_tags      TEXT[]      NOT NULL DEFAULT '{}',
  opted_out_email   BOOLEAN     NOT NULL DEFAULT false,
  opted_out_sms     BOOLEAN     NOT NULL DEFAULT false,
  opted_out_voice   BOOLEAN     NOT NULL DEFAULT false,
  crm_source        TEXT,  -- hubspot | intercom | mailchimp | csv
  crm_id            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT contact_has_channel CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS contacts_project_id_idx
  ON contacts(project_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- campaigns
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                TEXT        NOT NULL,
  goal                TEXT        NOT NULL,  -- pmf_survey | pain_point_discovery | feature_validation | churn_investigation
  channels            TEXT[]      NOT NULL,  -- email | sms | voice | widget
  segment_filter      TEXT[]      NOT NULL DEFAULT '{}',
  script              JSONB       NOT NULL DEFAULT '{}',
  persona             JSONB       NOT NULL DEFAULT '{}',
  status              TEXT        NOT NULL DEFAULT 'draft',  -- draft | launching | active | paused | completed | cancelled
  conversation_count  INTEGER     NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaigns_project_id_idx
  ON campaigns(project_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- conversations
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID        NOT NULL REFERENCES campaigns(id)  ON DELETE CASCADE,
  contact_id   UUID        NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  project_id   UUID        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  channel      TEXT        NOT NULL,  -- email | sms | voice | widget
  status       TEXT        NOT NULL DEFAULT 'pending',  -- pending | in_progress | completed | opted_out | failed
  turn_count   INTEGER     NOT NULL DEFAULT 0,
  external_id  TEXT,  -- Vapi call ID, Twilio SID, SendGrid message ID
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_project_id_idx
  ON conversations(project_id);
CREATE INDEX IF NOT EXISTS conversations_campaign_id_idx
  ON conversations(campaign_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- transcripts
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transcripts (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id           UUID        NOT NULL REFERENCES projects(id)      ON DELETE CASCADE,
  content              TEXT        NOT NULL,
  sentiment            TEXT,
  pain_intensity       INTEGER,
  wtp_signal           BOOLEAN,
  competitor_mentions  TEXT[]      NOT NULL DEFAULT '{}',
  top_quotes           TEXT[]      NOT NULL DEFAULT '{}',
  recording_url        TEXT,
  analyzed_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcripts_project_id_idx
  ON transcripts(project_id);
CREATE INDEX IF NOT EXISTS transcripts_conversation_id_idx
  ON transcripts(conversation_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- pmf_score_snapshots
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pmf_score_snapshots (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  score           NUMERIC(5,2) NOT NULL,
  response_count  INTEGER     NOT NULL,
  segment_scores  JSONB       NOT NULL DEFAULT '{}',
  snapshot_date   DATE        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pmf_score_snapshots_project_date_unique UNIQUE (project_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS pmf_snapshots_project_date_idx
  ON pmf_score_snapshots(project_id, snapshot_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- notifications
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID        NOT NULL REFERENCES accounts(id)          ON DELETE CASCADE,
  project_id  UUID                 REFERENCES projects(id)          ON DELETE CASCADE,
  type        TEXT        NOT NULL,  -- pmf-alert | cluster-alert | quota-warning | quota-exceeded | payment-failed | weekly-digest
  title       TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  is_read     BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_account_id_idx
  ON notifications(account_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- integrations
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integrations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider      TEXT        NOT NULL,  -- slack | hubspot | intercom | notion | segment
  access_token  TEXT        NOT NULL,  -- encrypted at rest (AES-256)
  config        JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT integrations_account_provider_unique UNIQUE (account_id, provider)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- webhook_endpoints
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url         TEXT        NOT NULL,
  secret      TEXT        NOT NULL,  -- HMAC-SHA256 signing secret, encrypted at rest
  events      TEXT[]      NOT NULL,  -- signal.created | pmf_score.changed
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_project_id_idx
  ON webhook_endpoints(project_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID        NOT NULL REFERENCES accounts(id),
  actor_id       UUID,
  action         TEXT        NOT NULL,
  resource_type  TEXT        NOT NULL,
  resource_id    UUID,
  metadata       JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_account_id_idx
  ON audit_log(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_resource_idx
  ON audit_log(resource_type, resource_id);
