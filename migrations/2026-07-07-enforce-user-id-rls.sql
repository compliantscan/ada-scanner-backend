-- Migration: enforce user_id-based row-level security on scans
-- Run this in the Supabase SQL editor or via the Supabase CLI.
--
-- The backend uses the service role key for all writes, which bypasses RLS.
-- These policies protect direct client-side access and act as a defence-in-depth
-- layer. The backend ALSO enforces user_id checks in every query (see server.js).

-- 1. Ensure user_id column exists and is indexed
ALTER TABLE IF EXISTS scans
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS scans_user_id_idx ON scans(user_id);

-- 2. Enable RLS
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;

-- 3. Drop all old policies that are too permissive
DROP POLICY IF EXISTS "Allow public scans"           ON scans;
DROP POLICY IF EXISTS "Users can read their own scans" ON scans;
DROP POLICY IF EXISTS "Users can select own scans"   ON scans;
DROP POLICY IF EXISTS "Users can insert own scans"   ON scans;
DROP POLICY IF EXISTS "Users can update own scans"   ON scans;
DROP POLICY IF EXISTS "Users can delete own scans"   ON scans;

-- 4. Authenticated users can only see their own rows
CREATE POLICY "Users can select own scans"
  ON scans FOR SELECT
  USING (auth.uid() IS NOT NULL AND auth.uid() = user_id);

-- 5. Authenticated users can insert rows that belong to themselves
CREATE POLICY "Users can insert own scans"
  ON scans FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);

-- 6. Authenticated users can update only their own rows
CREATE POLICY "Users can update own scans"
  ON scans FOR UPDATE
  USING  (auth.uid() IS NOT NULL AND auth.uid() = user_id)
  WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);

-- 7. Authenticated users can delete only their own rows
CREATE POLICY "Users can delete own scans"
  ON scans FOR DELETE
  USING (auth.uid() IS NOT NULL AND auth.uid() = user_id);

-- NOTE: Public/free scans (user_id IS NULL) are intentionally not exposed
-- through any RLS policy. They are only accessible via the service role key
-- on the backend (e.g. /report/:scanId public endpoint).
