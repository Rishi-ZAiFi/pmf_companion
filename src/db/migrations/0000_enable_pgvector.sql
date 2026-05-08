-- Migration: 0000_enable_pgvector
-- Enable the pgvector extension required for vector(1536) columns and ANN indexes.
-- This must run before any table that uses the vector type is created.

CREATE EXTENSION IF NOT EXISTS "pgvector";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
