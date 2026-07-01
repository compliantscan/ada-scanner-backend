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

-- Safe to run against an existing installation.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS score INTEGER;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS access_key_hash TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS free_report_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS affected_elements INTEGER;

-- Add indexes for faster queries
CREATE INDEX IF NOT EXISTS scans_user_email_idx ON scans(user_email);
CREATE INDEX IF NOT EXISTS scans_created_at_idx ON scans(created_at DESC);
CREATE INDEX IF NOT EXISTS scans_url_idx ON scans(url);
CREATE INDEX IF NOT EXISTS scans_access_key_hash_idx ON scans(access_key_hash);

-- Billing: one row per active subscription.
-- Store only a SHA-256 hash of the report access token; never store the raw token.
CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_email TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('starter', 'growth', 'agency', 'pro', 'business')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'past_due', 'canceled', 'expired')),
  access_token_hash TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  customer_logo_url TEXT,
  current_period_end TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscriptions_email_idx ON subscriptions(user_email);
CREATE INDEX IF NOT EXISTS subscriptions_token_idx ON subscriptions(access_token_hash);
CREATE INDEX IF NOT EXISTS subscriptions_stripe_customer_idx ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_stripe_sub_idx ON subscriptions(stripe_subscription_id);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Safe to run against an existing installation (adds Stripe columns if missing).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE;

-- AI fixes are cached by a fingerprint of rule + failing markup.
CREATE TABLE IF NOT EXISTS ai_fix_cache (
  fingerprint TEXT PRIMARY KEY,
  criterion TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE ai_fix_cache ENABLE ROW LEVEL SECURITY;

-- Contact form submissions
CREATE TABLE IF NOT EXISTS contact_submissions (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  website TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on scans
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

-- subscriptions and ai_fix_cache intentionally have no public policies.
-- Backend access requires SUPABASE_SERVICE_ROLE_KEY.
