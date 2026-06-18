-- Supabase SQL Setup for ADA Scanner
-- Run this in your Supabase SQL Editor

-- Create scans table
CREATE TABLE IF NOT EXISTS scans (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  user_email TEXT,
  total_violations INTEGER,
  violations_by_severity JSONB,
  results_json JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for faster queries
CREATE INDEX IF NOT EXISTS scans_user_email_idx ON scans(user_email);
CREATE INDEX IF NOT EXISTS scans_created_at_idx ON scans(created_at DESC);
CREATE INDEX IF NOT EXISTS scans_url_idx ON scans(url);

-- Enable RLS (Row Level Security) - optional, for multi-user support
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Allow public scans" ON scans;
DROP POLICY IF EXISTS "Users can read their own scans" ON scans;

-- Create policy to allow anyone to insert (for free tier)
CREATE POLICY "Allow public scans" ON scans
  FOR INSERT
  WITH CHECK (true);

-- Create policy to allow users to read their own scans
CREATE POLICY "Users can read their own scans" ON scans
  FOR SELECT
  USING (user_email = auth.email() OR user_email IS NULL);
