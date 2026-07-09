-- Migration: add auth user ownership to scans
-- Run this in the Supabase SQL editor or via the Supabase CLI

ALTER TABLE IF EXISTS scans
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS user_email TEXT;

CREATE INDEX IF NOT EXISTS scans_user_id_idx ON scans(user_id);
CREATE INDEX IF NOT EXISTS scans_user_email_idx ON scans(user_email);

ALTER TABLE IF EXISTS scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can select own scans" ON scans;
CREATE POLICY "Users can select own scans" ON scans
  FOR SELECT
  USING (user_id IS NOT NULL AND user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own scans" ON scans;
CREATE POLICY "Users can update own scans" ON scans
  FOR UPDATE
  USING (user_id IS NOT NULL AND user_id = auth.uid())
  WITH CHECK (user_id IS NOT NULL AND user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own scans" ON scans;
CREATE POLICY "Users can insert own scans" ON scans
  FOR INSERT
  WITH CHECK (user_id IS NOT NULL AND user_id = auth.uid());
