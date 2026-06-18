require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const PROD_URL = process.env.PROD_SCAN_URL || 'https://ada-scanner-backend-production.up.railway.app/scan';
const TEST_URL = 'https://example.com';
const TEST_EMAIL = 'integration-test@example.com';

async function postScan() {
  console.log('Posting scan to:', PROD_URL);
  const res = await fetch(PROD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: TEST_URL, email: TEST_EMAIL }),
    timeout: 120000,
  });
  const json = await res.json();
  console.log('POST response:', JSON.stringify(json, null, 2));
  return json;
}

async function querySupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase env vars missing for local check.');
    return null;
  }
  const supabase = createClient(supabaseUrl, supabaseKey);
  console.log('Querying Supabase scans table for latest rows...');
  const { data, error } = await supabase
    .from('scans')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) {
    console.error('Supabase query error:', error);
    return null;
  }
  console.log('Supabase rows:', JSON.stringify(data, null, 2));
  return data;
}

(async () => {
  try {
    await postScan();
    await querySupabase();
  } catch (err) {
    console.error('Error during integration check:', err);
    process.exit(1);
  }
})();
