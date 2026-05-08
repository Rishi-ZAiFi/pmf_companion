-- Migration: add metadata JSONB column to conversations
-- Required by the widget channel to store message history in the conversation record.
-- Requirements: 11.4, 11.5

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
