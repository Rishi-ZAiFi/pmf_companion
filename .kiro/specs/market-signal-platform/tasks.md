# Implementation Plan: Market Signal Platform

## Overview

Implement the Market Signal Platform as a Next.js (App Router) monorepo with TypeScript, PostgreSQL + pgvector, BullMQ + Redis for async workers, and integrations with OpenAI, Vapi, Twilio, SendGrid, and Stripe. Tasks are ordered to build foundational infrastructure first, then layer in scraping, active signal collection, intelligence processing, and finally the dashboard and integrations.

## Tasks

- [x] 1. Set up project foundation and database schema
  - Initialize a Next.js 14 App Router project with TypeScript, ESLint, and Prettier
  - Install and configure core dependencies: `drizzle-orm` (or `prisma`) for PostgreSQL, `pgvector`, `bullmq`, `ioredis`, `next-auth`, `stripe`, `zod`
  - Write all SQL migration files for the core tables: `accounts`, `projects`, `signals`, `theme_clusters`, `signal_cluster_memberships`, `contacts`, `campaigns`, `conversations`, `transcripts`, `pmf_score_snapshots`, `notifications`, `integrations`, `webhook_endpoints`, `audit_log`
  - Enable the `pgvector` extension and add the `vector(1536)` column and IVFFlat index on `signals.embedding`
  - Add the `UNIQUE (project_id, source_url)` deduplication constraint on `signals`
  - Enable Row-Level Security on all tenant-scoped tables and write RLS policies scoped to `app.current_account_id`
  - Create the `signal_feed_mv` materialized view with composite score calculation and its covering index
  - Set up environment variable schema with `zod` for all required secrets (DB URL, Redis URL, OpenAI key, etc.)
  - _Requirements: 1.1, 1.7, 7.6, 22.1, 22.2, 23.1_

- [x] 2. Implement authentication and session management
  - [x] 2.1 Configure NextAuth.js (Auth.js v5) with email/password credentials provider and Google OAuth provider
    - Store sessions as JWTs with 15-minute access token and 7-day refresh token
    - Include `userId`, `accountId`, and `planTier` in the JWT payload
    - _Requirements: 1.1_
  - [x] 2.2 Implement registration endpoint `POST /api/auth/register`
    - Hash password with bcrypt, create `accounts` row, return session
    - _Requirements: 1.1_
  - [x] 2.3 Write a reusable `requireAuth` middleware/helper that validates the session token and sets `app.current_account_id` on the DB connection before any query
    - _Requirements: 22.1, 22.6_
  - [ ]* 2.4 Write unit tests for auth middleware and registration validation
    - Test invalid credentials, duplicate email, missing fields
    - _Requirements: 1.1_

- [x] 3. Implement project management service
  - [x] 3.1 Implement CRUD API routes for projects (`GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`)
    - Enforce plan-level project count limits (1 / 3 / 10 / unlimited per tier)
    - Implement soft-delete (set `status = 'deleted'`) and archive/restore endpoints
    - _Requirements: 1.2, 1.3, 1.5, 1.7, 21.1_
  - [x] 3.2 Implement project activation logic: on project save, validate required fields (name, description, ICP, problem statement, up to 5 competitors) and enqueue a `generate-keywords` BullMQ job
    - _Requirements: 1.3, 1.4_
  - [x] 3.3 Implement the `generate-keywords` BullMQ worker
    - Call OpenAI Chat Completions with ICP description and problem statement
    - Write resulting keyword set and subreddit candidates back to the project record within 60 seconds
    - _Requirements: 1.4, 2.1_
  - [x] 3.4 Implement archive behavior: when a project is archived, suspend all scraping and campaign jobs for that project while retaining historical signal data
    - _Requirements: 1.6_
  - [ ]* 3.5 Write unit tests for project plan limit enforcement and field validation
    - _Requirements: 1.3, 1.7, 21.1_

- [x] 4. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement the scraper subsystem — Reddit and Hacker News
  - [x] 5.1 Create the BullMQ scraper worker infrastructure: shared base class with exponential backoff (initial 60s delay, doubling, max 1 hour), `Retry-After` header handling, and `robots.txt` compliance
    - _Requirements: 23.4, 23.5_
  - [x] 5.2 Implement the `reddit-scraper` worker (6-hour repeatable job)
    - Use `snoowrap` to fetch posts and comments matching project keywords from monitored subreddits
    - Perform bulk `INSERT ... ON CONFLICT DO NOTHING` for deduplication
    - Enqueue `embed-signal` jobs for newly inserted signals
    - _Requirements: 2.1, 2.2, 2.6_
  - [x] 5.3 Implement Reddit signal classification: assign one of the six signal types (pain_point, feature_request, competitor_mention, market_trend, positive_sentiment, negative_sentiment) and a Relevance Score 0–100 via OpenAI
    - _Requirements: 2.4, 2.5_
  - [x] 5.4 Implement the `hn-scraper` worker (2-hour repeatable job)
    - Use the Hacker News Algolia API to fetch "Ask HN" and "Show HN" posts matching the project's problem space
    - Deduplicate and enqueue embed jobs
    - _Requirements: 4.1, 4.2, 4.4_
  - [x] 5.5 Implement HN signal classification using the same taxonomy and relevance scoring
    - _Requirements: 4.3_
  - [x] 5.6 Add API endpoints for managing subreddit monitoring lists (`PATCH /api/projects/:id` to add/remove subreddits)
    - _Requirements: 2.3_
  - [ ]* 5.7 Write unit tests for deduplication logic and backoff strategy
    - _Requirements: 2.6, 4.4, 23.5_

- [x] 6. Implement the scraper subsystem — Twitter/X, LinkedIn, and review sites
  - [x] 6.1 Implement the `twitter-scraper` worker (30-minute repeatable job)
    - Use Twitter/X API v2 to fetch tweets and threads matching project keywords, hashtags, and competitor handles
    - Deduplicate and enqueue embed jobs
    - _Requirements: 3.1, 3.2, 3.5_
  - [x] 6.2 Implement Twitter sentiment trend aggregation: store a daily sentiment aggregate per keyword cluster in `signals.metadata`
    - _Requirements: 3.3_
  - [x] 6.3 Implement the `linkedin-scraper` worker (24-hour repeatable job)
    - Use a headless browser (Playwright) to scrape public LinkedIn posts, articles, and job postings matching the project's ICP
    - Deduplicate and enqueue embed jobs
    - _Requirements: 5.1, 5.2, 5.3, 5.5_
  - [x] 6.4 Implement the `review-scraper` worker (7-day repeatable job)
    - Scrape G2, Trustpilot, Product Hunt, Apple App Store, and Google Play Store for competitor reviews
    - Flag reviews classified as negative_sentiment or competitor weakness as `is_opportunity = true`
    - Deduplicate and enqueue embed jobs
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x] 6.5 Apply the shared signal classification and relevance scoring to Twitter, LinkedIn, and review signals
    - _Requirements: 3.4, 5.4, 6.3_
  - [ ]* 6.6 Write unit tests for opportunity flagging and sentiment classification
    - _Requirements: 6.4_

- [x] 7. Implement the embedding engine and semantic clustering
  - [x] 7.1 Implement the `embed-signal` BullMQ worker
    - Dequeue job by `signalId`, load signal text, call OpenAI `text-embedding-3-small` (1536 dimensions)
    - Write embedding to `signals.embedding`, update `signals.status` to `embedded`
    - Enqueue a debounced `cluster-signals` job (one pending per project at a time)
    - _Requirements: 7.1_
  - [x] 7.2 Implement the `cluster-signals` worker using pgvector cosine distance
    - Greedy agglomerative clustering: group signals within cosine distance ≤ 0.20 (similarity ≥ 0.80)
    - Assign to existing clusters or create new ones; update `signal_cluster_memberships` and `theme_clusters.signal_count`
    - Run at intervals no greater than 1 hour
    - _Requirements: 7.2, 7.4_
  - [x] 7.3 Implement the `name-cluster` worker
    - Trigger when a cluster reaches ≥ 5 signals and has no LLM-generated name
    - Call OpenAI Chat Completions with top 10 signal texts; store cluster name (≤ 6 words) and 2-sentence summary
    - _Requirements: 7.3_
  - [x] 7.4 Implement relevance score filtering: exclude signals with score < 20 from the signal feed (set `status = 'excluded'`) while retaining them in storage
    - _Requirements: 7.5_
  - [ ]* 7.5 Write unit tests for clustering threshold logic and deduplication constraint
    - Test that signals from the same source URL within the same project produce exactly one record
    - _Requirements: 7.6_

- [x] 8. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement contact management service
  - [x] 9.1 Implement contact CRUD API routes (`GET/PATCH/DELETE /api/projects/:id/contacts/:cid`) with segment tag management
    - _Requirements: 8.5, 8.6_
  - [x] 9.2 Implement CSV import endpoint (`POST /api/projects/:id/contacts/import`)
    - Parse with `papaparse`, validate each row (require at least one of email or phone), return validation summary (valid/invalid counts with row numbers and error reasons) before committing
    - Bulk-insert valid rows
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 9.3 Implement CRM sync endpoint (`POST /api/projects/:id/contacts/sync`) for HubSpot, Intercom, and Mailchimp
    - _Requirements: 8.4_
  - [x] 9.4 Implement opt-out endpoint (`POST /api/projects/:id/contacts/:cid/optout`) that sets the appropriate `opted_out_*` flag and halts all outreach for that contact
    - _Requirements: 10.6, 11.7, 12.8_
  - [ ]* 9.5 Write unit tests for CSV validation logic (missing email+phone, malformed rows)
    - _Requirements: 8.2, 8.3_

- [x] 10. Implement campaign service and script generation
  - [x] 10.1 Implement campaign CRUD API routes (`GET/POST /api/projects/:id/campaigns`, `GET/PATCH /api/projects/:id/campaigns/:cid`)
    - Support goals: pmf_survey, pain_point_discovery, feature_validation, churn_investigation
    - Support channels: email, sms, voice, widget
    - _Requirements: 9.1, 9.2, 9.3_
  - [x] 10.2 Implement auto-generated conversation script and AI persona on campaign creation
    - Call OpenAI Chat Completions with campaign goal, product description, and ICP
    - Store structured JSON script with turn-by-turn prompts
    - _Requirements: 9.4_
  - [x] 10.3 Implement campaign launch endpoint (`POST /api/projects/:id/campaigns/:cid/launch`)
    - Validate plan limits using Redis atomic increment (`INCR account:{id}:conversations:{month}`)
    - Require consent confirmation from founder before launch
    - Set campaign status to `launching`, enqueue `deliver-campaign` job
    - Begin delivering conversations within 15 minutes
    - _Requirements: 9.6, 21.1, 21.2, 22.3_
  - [x] 10.4 Implement pause/resume/cancel endpoints and enforce pause behavior (no new conversations, allow in-progress to complete)
    - _Requirements: 9.7, 9.8_
  - [x] 10.5 Implement the `deliver-campaign` BullMQ worker
    - Load target contacts filtered by segment, check opt-out status per contact, enqueue channel-specific `send-conversation` jobs
    - _Requirements: 9.6_
  - [x] 10.6 Implement plan quota enforcement: send warning notification at 90% usage, pause all campaigns at 100% usage
    - _Requirements: 21.3, 21.4_
  - [ ]* 10.7 Write unit tests for plan limit enforcement and quota Redis counter logic
    - _Requirements: 21.1, 21.3, 21.4_

- [x] 11. Implement email and SMS channel workers
  - [x] 11.1 Implement the `send-email` worker using SendGrid API
    - Personalize email body with contact first name and segment context
    - Store `message_id` for reply tracking
    - Include opt-out link in every outbound email
    - _Requirements: 10.1, 10.2, 22.5_
  - [x] 11.2 Implement inbound email reply routing: route replies to the AI conversation engine, send follow-up within 5 minutes, enforce 5-message limit per contact per campaign
    - _Requirements: 10.3, 10.4_
  - [x] 11.3 Implement email thread closure: generate Transcript, extract insights (sentiment, pain intensity 1–10), create Active Signal records
    - Detect opt-out phrases ("unsubscribe", "stop", "remove me") and immediately mark contact as opted out
    - _Requirements: 10.5, 10.6_
  - [x] 11.4 Implement the `send-sms` worker using Twilio Messages API
    - Store Twilio SID for reply tracking
    - Include opt-out instruction in outbound SMS
    - _Requirements: 11.1, 22.5_
  - [x] 11.5 Implement inbound SMS reply routing via Twilio webhook: route to AI engine, respond within 2 minutes, enforce 8-message limit per session
    - Detect opt-out phrases ("STOP", "UNSUBSCRIBE") and immediately mark contact as opted out
    - _Requirements: 11.2, 11.5, 11.7_
  - [x] 11.6 Implement SMS session closure: generate Transcript and extract insights
    - _Requirements: 11.6_
  - [ ]* 11.7 Write unit tests for opt-out phrase detection and message limit enforcement
    - _Requirements: 10.4, 10.6, 11.5, 11.7_

- [x] 12. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 13. Implement voice call channel (Vapi integration)
  - [x] 13.1 Implement the `send-voice` worker: call `POST https://api.vapi.ai/call/phone` with assistant config, campaign script as system prompt, probing instruction (ask "why" when response < 15 words), and `recordingEnabled: true`
    - Include verbal consent disclosure at call start
    - _Requirements: 12.1, 12.2, 12.3, 12.4_
  - [x] 13.2 Implement Vapi webhook receiver (`POST /api/webhooks/vapi`)
    - Handle `call-started` (update conversation status), `transcript` (store incremental chunks), `call-ended` (trigger finalization)
    - _Requirements: 12.5_
  - [x] 13.3 Implement transcript finalization on `call-ended`
    - Fetch full transcript from Vapi, store in `transcripts` table, enqueue `analyze-transcript` job
    - Deliver transcript to dashboard within 5 minutes of call ending
    - _Requirements: 12.5, 23.3_
  - [x] 13.4 Implement call recording storage: save recording to S3, store URL in `transcripts.recording_url`; expose recording playback and transcript read via `GET /api/projects/:id/transcripts/:tid`
    - _Requirements: 12.7_
  - [x] 13.5 Implement call opt-out handling: if contact declines or requests to end call, the Voice Agent ends the call immediately and marks contact as `opted_out_voice = true`
    - _Requirements: 12.8_
  - [ ]* 13.6 Write unit tests for Vapi webhook event handling and transcript storage
    - _Requirements: 12.5, 12.6_

- [x] 14. Implement conversation intelligence service
  - [x] 14.1 Implement the `analyze-transcript` BullMQ worker
    - Call OpenAI Chat Completions with the full transcript and structured extraction prompt
    - Parse JSON response: sentiment, pain_intensity (1–10), willingness_to_pay, competitor_mentions, top_quotes (3), signal_summaries
    - _Requirements: 12.6, 13.1_
  - [x] 14.2 Persist extracted insights: update `transcripts` table with analysis results; create Active Signal records in `signals` for each `signal_summary`; link signals to transcript and contact
    - Surface top 3 verbatim quotes as representative quotes in the Signal Feed entry
    - _Requirements: 13.2, 13.4_
  - [x] 14.3 Enqueue `embed-signal` jobs for all newly created Active Signals so they are clustered with Passive Signals
    - _Requirements: 13.3_
  - [ ]* 14.4 Write unit tests for insight extraction JSON parsing and Active Signal creation
    - _Requirements: 13.1, 13.2_

- [x] 15. Implement the unified signal feed service
  - [x] 15.1 Implement `GET /api/projects/:id/signals` with pagination (page/limit), filtering (source, type, sentiment, min_relevance, date range), and sorting (composite_score, recency, relevance)
    - Query the `signal_feed_mv` materialized view; return first 50 results within 2 seconds
    - _Requirements: 14.1, 14.2, 14.3, 14.4_
  - [x] 15.2 Implement signal interaction endpoints: bookmark, tag with custom label, and dismiss (`PATCH /api/projects/:id/signals/:sid`)
    - _Requirements: 14.5_
  - [x] 15.3 Implement source link resolution: when a signal is selected, return the original source URL (Reddit post, Transcript link, review page, etc.)
    - _Requirements: 14.6_
  - [x] 15.4 Set up a scheduled job to refresh the `signal_feed_mv` materialized view every 5 minutes
    - _Requirements: 14.3, 23.2_
  - [ ]* 15.5 Write unit tests for composite score calculation and filter query construction
    - _Requirements: 14.2, 14.4_

- [x] 16. Implement PMF score service
  - [x] 16.1 Implement PMF score calculation: count "very_disappointed" responses / total PMF survey responses × 100; store snapshot in `pmf_score_snapshots` with timestamp
    - Recalculate within 1 hour of each new PMF survey transcript being analyzed
    - _Requirements: 15.1, 15.2_
  - [x] 16.2 Implement per-segment PMF score breakdown: run the same calculation per contact segment tag and store in `pmf_score_snapshots.segment_scores`
    - _Requirements: 15.4_
  - [x] 16.3 Implement PMF score trend API: return daily snapshots for the past 90 days for the trend chart
    - _Requirements: 15.3_
  - [x] 16.4 Implement confidence warning: when fewer than 40 survey responses exist, include a `confidence_warning` flag in the API response
    - _Requirements: 15.6_
  - [x] 16.5 Implement PMF alert trigger: after each recalculation, check if score changed ≥ 5 points in the past 24 hours; if so, enqueue `pmf-alert` notification job
    - _Requirements: 15.5, 19.1_
  - [ ]* 16.6 Write unit tests for PMF score calculation, segment breakdown, and alert threshold detection
    - _Requirements: 15.1, 15.4, 15.5_

- [x] 17. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 18. Implement theme clusters dashboard
  - [x] 18.1 Implement `GET /api/projects/:id/clusters` returning all clusters sorted by signal_count descending, with name, signal_count, trend_direction, and up to 3 representative quotes
    - Calculate trend_direction based on signal ingestion rate over the past 7 days (growing/stable/declining)
    - _Requirements: 16.1, 16.2_
  - [x] 18.2 Implement cluster drill-down: `GET /api/projects/:id/clusters/:cid/signals` returning all signals in the cluster
    - _Requirements: 16.3_
  - [x] 18.3 Implement cluster management endpoints: rename, merge, and dismiss clusters (`PATCH /api/projects/:id/clusters/:cid`)
    - _Requirements: 16.4_
  - [x] 18.4 Implement cluster growth notification: when a new cluster reaches ≥ 10 signals within a 48-hour window, enqueue a `cluster-alert` notification job
    - _Requirements: 16.5, 19.2_
  - [ ]* 18.5 Write unit tests for trend direction calculation and cluster merge logic
    - _Requirements: 16.2, 16.4_

- [x] 19. Implement persona map service
  - [x] 19.1 Implement persona generation: cluster contacts and their associated signal patterns using the Embedding Engine; generate persona name and description via OpenAI
    - Display: persona name, description, primary pain points, average pain intensity score, PMF likelihood (high/medium/low)
    - _Requirements: 17.1, 17.2_
  - [x] 19.2 Derive personas from both Active Signal conversation data and Passive Signal language patterns where contact attribution is available
    - _Requirements: 17.3_
  - [x] 19.3 Schedule persona refresh at intervals no greater than 24 hours
    - _Requirements: 17.4_
  - [x] 19.4 Implement insufficient-data guard: when fewer than 10 contacts have contributed signals, return a notice and suppress persona generation
    - _Requirements: 17.5_
  - [ ]* 19.5 Write unit tests for persona generation guard and PMF likelihood classification
    - _Requirements: 17.5_

- [x] 20. Implement competitor gap analysis
  - [x] 20.1 Implement competitor gap aggregation: group competitor weakness signals from review sites and social sources into a gap map per project
    - Display: unmet need description, supporting signal count, associated competitor names
    - _Requirements: 18.1, 18.2_
  - [x] 20.2 Implement competitor management endpoints: add/remove tracked competitors (`PATCH /api/projects/:id`)
    - When a competitor is removed, retain historical signals but cease collecting new signals for that competitor
    - _Requirements: 18.3, 18.4_
  - [ ]* 20.3 Write unit tests for gap aggregation query and competitor removal behavior
    - _Requirements: 18.4_

- [x] 21. Implement notification service
  - [x] 21.1 Implement the notification BullMQ worker handling all job types: `pmf-alert`, `cluster-alert`, `quota-warning`, `quota-exceeded`, `payment-failed`, `weekly-digest`
    - Send email via SendGrid and create in-app notification records in the `notifications` table
    - _Requirements: 19.1, 19.2, 19.3, 21.3, 21.4, 21.6_
  - [x] 21.2 Implement SSE endpoint `GET /api/notifications/stream` for real-time in-app notification delivery
    - _Requirements: 19.1, 19.2_
  - [x] 21.3 Implement weekly digest job: schedule for Monday 09:00 in the founder's configured timezone (default UTC); include top 5 signals by relevance, PMF score movement, and new clusters from the past 7 days
    - _Requirements: 19.3, 19.5_
  - [x] 21.4 Implement notification preferences API: allow founders to disable individual notification types (`PATCH /api/accounts/notifications`)
    - _Requirements: 19.4_
  - [ ]* 21.5 Write unit tests for timezone-aware digest scheduling and notification preference filtering
    - _Requirements: 19.3, 19.4, 19.5_

- [x] 22. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 23. Implement billing service and Stripe integration
  - [x] 23.1 Implement Stripe webhook receiver (`POST /api/webhooks/stripe`)
    - Handle: `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`
    - On payment failure, start 7-day grace period; downgrade to free tier if unresolved
    - _Requirements: 21.5, 21.6_
  - [x] 23.2 Implement subscription management API: plan upgrade/downgrade via Stripe Checkout or Billing Portal
    - _Requirements: 21.5_
  - [x] 23.3 Implement upgrade prompt: when a Free-tier founder attempts to launch an active campaign, return a 402 response with upgrade prompt and prevent launch
    - _Requirements: 21.2_
  - [ ]* 23.4 Write unit tests for plan enforcement logic and grace period timer
    - _Requirements: 21.2, 21.6_

- [x] 24. Implement integrations service
  - [x] 24.1 Implement Slack integration: OAuth connection flow, `chat.postMessage` with Block Kit formatting for signal summaries and PMF alerts to a founder-configured channel
    - _Requirements: 20.1_
  - [x] 24.2 Implement HubSpot and Intercom integration: OAuth connection, contact sync, push signal-derived tags back to CRM as contact properties
    - _Requirements: 20.2_
  - [x] 24.3 Implement Notion integration: OAuth connection, export signal reports and theme cluster summaries as Notion pages
    - _Requirements: 20.3_
  - [x] 24.4 Implement webhook endpoint management API (`GET/POST/DELETE /api/projects/:id/webhooks`, max 10 per project)
    - Deliver `signal.created` and `pmf_score.changed` events with HMAC-SHA256 `X-Signature` header
    - Retry failed deliveries with exponential backoff up to 3 times
    - _Requirements: 20.4_
  - [x] 24.5 Implement Segment source integration: receive user behavior events from Segment and use them to trigger in-app widget campaign conversations
    - _Requirements: 20.5_
  - [ ]* 24.6 Write unit tests for HMAC signature generation and webhook retry logic
    - _Requirements: 20.4_

- [x] 25. Implement chat widget
  - [x] 25.1 Build the self-contained `widget.js` JavaScript bundle (no framework dependencies)
    - Accept `data-project-id` and `data-campaign-id` attributes from the embed script tag
    - Open a chat panel UI and communicate with the platform via WebSocket (Socket.io) with long-polling fallback
    - _Requirements: 11.3, 11.4_
  - [x] 25.2 Implement the `send-chat` campaign worker: activate a widget session for the contact, route messages through the Campaign Service, enforce 8-message limit per session
    - _Requirements: 11.4, 11.5_
  - [x] 25.3 Implement chat session closure: generate Transcript and extract insights when session ends
    - _Requirements: 11.6_
  - [ ]* 25.4 Write unit tests for widget session routing and message limit enforcement
    - _Requirements: 11.4, 11.5_

- [x] 26. Implement security, compliance, and audit logging
  - [x] 26.1 Implement AES-256 encryption at rest for sensitive fields: Contact records, call recordings (via S3 server-side encryption), and integration access tokens
    - _Requirements: 22.1_
  - [x] 26.2 Enforce TLS 1.2+ for all client-server communication (configure in deployment/CDN layer; add HSTS headers in Next.js middleware)
    - _Requirements: 22.2_
  - [x] 26.3 Implement audit log middleware: write a record to `audit_log` for all data access and export events; retain for minimum 90 days
    - _Requirements: 22.6_
  - [x] 26.4 Implement data deletion endpoint: permanently delete all data associated with an account within 30 days of a deletion request (`DELETE /api/accounts/me`)
    - _Requirements: 22.4_
  - [x] 26.5 Implement Contact opt-out link in every outbound email and SMS, routing to a public opt-out confirmation page (`GET /optout?token=...`)
    - _Requirements: 22.5_
  - [ ]* 26.6 Write unit tests for audit log write coverage and opt-out token validation
    - _Requirements: 22.5, 22.6_

- [x] 27. Final checkpoint — Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- The design uses no Correctness Properties section, so property-based tests are not included; unit and integration tests cover correctness
- Checkpoints ensure incremental validation at each major milestone
- All workers are BullMQ consumers and should be implemented as separate Node.js processes deployable independently from the Next.js web tier
