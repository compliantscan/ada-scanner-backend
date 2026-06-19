const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in environment variables');
  console.error('Required: SUPABASE_URL and SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
// Optionally create an admin client using the service role key for server-side writes
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
let supabaseAdmin = null;
if (serviceRoleKey) {
  supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
}

/**
 * Save scan results to Supabase "scans" table
 * @param {string} url - The URL that was scanned
 * @param {object} results - Full axe-core results object
 * @param {string} userEmail - User email (optional for anonymous scans)
 * @returns {Promise<object>} - Database record
 */
async function saveScanResults(url, results, userEmail = null) {
  try {
    console.log(`[DB] Saving scan results for ${url}`);

    // Prepare summary data
    const violationsBySeverity = {
      critical: results.violations.filter(v => v.impact === 'critical').length,
      serious: results.violations.filter(v => v.impact === 'serious').length,
      moderate: results.violations.filter(v => v.impact === 'moderate').length,
      minor: results.violations.filter(v => v.impact === 'minor').length,
    };

    // Choose client: prefer admin (service_role) client for server-side writes
    const client = supabaseAdmin || supabase;
    if (!supabaseAdmin) console.warn('[DB] Warning: using anon key for inserts; consider setting SUPABASE_SERVICE_ROLE_KEY');

    // Insert into scans table (attempt full insert) and request returned row(s)
    const attempt = await client.from('scans').insert([
      {
        url,
        user_email: userEmail,
        total_violations: results.violations.length,
        violations_by_severity: violationsBySeverity,
        results_json: results,
        created_at: new Date().toISOString(),
      },
    ]).select();

    console.log('[DB] Supabase insert attempt result:', { status: attempt.status, data: attempt.data, error: attempt.error });

    if (attempt.error) {
      // If schema cache / missing column error, try a minimal insert as a fallback
      const msg = attempt.error.message || '';
      if (attempt.error.code === 'PGRST204' || /Could not find the/.test(msg)) {
        console.warn('[DB] Schema mismatch detected; attempting minimal insert');
        const fallback = await supabase.from('scans').insert([
          {
            url,
            user_email: userEmail,
            results_json: results,
          },
        ]).select();
        console.log('[DB] Supabase fallback insert result:', {
          status: fallback.status,
          data: fallback.data,
          error: fallback.error,
        });
        if (fallback.error) {
          throw fallback.error;
        }
        return fallback.data;
      }

      throw attempt.error;
    }

    // If insert returned no body (data null or empty), try to fetch the recently inserted row
    if (!attempt.data || (Array.isArray(attempt.data) && attempt.data.length === 0)) {
      console.warn('[DB] Insert returned no row; attempting to fetch recent row for URL');
      const { data: recent, error: recentError } = await supabase
        .from('scans')
        .select('*')
        .eq('url', url)
        .order('created_at', { ascending: false })
        .limit(1);
      if (recentError) {
        console.error('[DB] Error fetching recent row after insert:', recentError);
      } else if (recent && recent.length) {
        console.log('[DB] Found recent row after insert:', recent[0]);
        return recent;
      }
    }

    console.log(`[DB] Scan results saved successfully`);
    return attempt.data;
  } catch (error) {
    console.error('[DB] Failed to save scan results:', error.message);
    throw error;
  }
}

/**
 * Save a collected email to Supabase "emails_collected" table
 * @param {string} email
 * @param {string} url
 * @returns {Promise<object>}
 */
async function saveCollectedEmail(email, url) {
  try {
    const { data, error } = await supabase.from('emails_collected').insert([
      {
        email,
        url_scanned: url,
        created_at: new Date().toISOString(),
      },
    ]).select();

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    console.error('[DB] Failed to save collected email:', error.message);
    throw error;
  }
}

/**
 * Get all scans for a user (requires auth)
 * @param {string} userEmail - User email
 * @returns {Promise<array>} - Array of scans
 */
async function getUserScans(userEmail) {
  try {
    const { data, error } = await supabase
      .from('scans')
      .select('*')
      .eq('user_email', userEmail)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('[DB] Failed to fetch user scans:', error.message);
    throw error;
  }
}

/**
 * Get a specific scan result
 * @param {number} scanId - Scan ID
 * @returns {Promise<object>} - Scan record
 */
async function getScanById(scanId) {
  try {
    const { data, error } = await supabase
      .from('scans')
      .select('*')
      .eq('id', scanId)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('[DB] Failed to fetch scan:', error.message);
    throw error;
  }
}

module.exports = {
  saveScanResults,
  saveCollectedEmail,
  getUserScans,
  getScanById,
  supabase,
};
