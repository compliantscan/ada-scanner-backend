-- Migration: add missing columns and ai_fix_cache table
-- Run this in the Supabase SQL editor or via the Supabase CLI

ALTER TABLE IF EXISTS scans
  ADD COLUMN IF NOT EXISTS access_key_hash TEXT;

ALTER TABLE IF EXISTS scans
  ADD COLUMN IF NOT EXISTS affected_elements INTEGER;

CREATE TABLE IF NOT EXISTS ai_fix_cache (
  fingerprint TEXT PRIMARY KEY,
  criterion TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS if your project uses it (requires appropriate policies/roles)
ALTER TABLE IF EXISTS ai_fix_cache ENABLE ROW LEVEL SECURITY;