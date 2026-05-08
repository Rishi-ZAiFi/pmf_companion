-- Migration: 0003_signal_feed_mv
-- Creates the signal_feed_mv materialized view used by the Signal Feed API.
--
-- The composite score formula:
--   composite_score = (relevance_score * 0.5)
--                   + (recency_score   * 0.3)   -- decays over 7 days
--                   + (type_weight     * 0.2)
--
-- The view is refreshed every 5 minutes by a BullMQ scheduled job
-- (see src/workers/refresh-signal-feed.ts).

CREATE MATERIALIZED VIEW IF NOT EXISTS signal_feed_mv AS
SELECT
  s.*,
  (
    -- Relevance component (0–100, weight 50%)
    s.relevance_score * 0.5

    -- Recency component: exponential decay over 7 days (604800 seconds), weight 30%
    + (100.0 * exp(
        -EXTRACT(EPOCH FROM (now() - s.ingested_at)) / 604800.0
      )) * 0.3

    -- Signal-type weight component (weight 20%)
    + CASE s.signal_type
        WHEN 'pain_point'          THEN 100
        WHEN 'feature_request'     THEN 90
        WHEN 'competitor_mention'  THEN 80
        WHEN 'negative_sentiment'  THEN 70
        WHEN 'market_trend'        THEN 60
        ELSE 50  -- positive_sentiment and any unknown types
      END * 0.2
  ) AS composite_score
FROM signals s
WHERE s.status    != 'excluded'
  AND s.is_dismissed = false;

-- Covering index for the primary feed query pattern:
--   WHERE project_id = $1 ORDER BY composite_score DESC LIMIT 50
CREATE UNIQUE INDEX IF NOT EXISTS signal_feed_mv_id_idx
  ON signal_feed_mv(id);

CREATE INDEX IF NOT EXISTS signal_feed_mv_project_score_idx
  ON signal_feed_mv(project_id, composite_score DESC);

-- Additional indexes to support filtered feed queries
CREATE INDEX IF NOT EXISTS signal_feed_mv_project_ingested_idx
  ON signal_feed_mv(project_id, ingested_at DESC);

CREATE INDEX IF NOT EXISTS signal_feed_mv_project_relevance_idx
  ON signal_feed_mv(project_id, relevance_score DESC);
