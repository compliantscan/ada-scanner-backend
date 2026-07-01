require('dotenv').config();

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

// Track whether the ai_fix_cache table appears available. If a lookup fails
// with a missing-relation or permission error, we'll disable future cache
// attempts to avoid noisy logs and repeated failures.
let aiFixCacheAvailable = true;

/**
 * Save scan results to Supabase "scans" table
 * @param {string} url - The URL that was scanned
 * @param {object} results - Full axe-core results object
 * @param {string} userEmail - User email (optional for anonymous scans)
 * @returns {Promise<object>} - Database record
 */
async function saveScanResults(url, results, userEmail = null, metadata = {}) {
  try {
    console.log(`[DB] Saving scan results for ${url}`);

    // Prepare summary data
    const violationsBySeverity = {
      critical: results.violations.filter(v => v.impact === 'critical').length,
      serious: results.violations.filter(v => v.impact === 'serious').length,
      moderate: results.violations.filter(v => v.impact === 'moderate').length,
      minor: results.violations.filter(v => v.impact === 'minor').length,
    };
    const totalAffectedElements = results.violations.reduce(
      (sum, violation) => sum + (Array.isArray(violation.nodes) ? violation.nodes.length : 0),
      0
    );

    // Choose client: prefer admin (service_role) client for server-side writes
    const client = supabaseAdmin || supabase;
    if (!supabaseAdmin) console.warn('[DB] Warning: using anon key for inserts; consider setting SUPABASE_SERVICE_ROLE_KEY');

    // Insert into scans table (attempt full insert) and request returned row(s)
    const attempt = await client.from('scans').insert([
      {
        url,
        user_email: userEmail,
        total_violations: results.violations.length,
        affected_elements: totalAffectedElements,
        violations_by_severity: violationsBySeverity,
        results_json: results,
        score: metadata.score ?? null,
        access_key_hash: metadata.accessKeyHash || null,
        free_report_expires_at: metadata.freeReportExpiresAt || null,
        created_at: new Date().toISOString(),
      },
    ]).select();

    console.log('[DB] Supabase insert attempt result:', { status: attempt.status, data: attempt.data, error: attempt.error });

    if (attempt.error) {
      // If schema cache / missing column error, try a minimal insert as a fallback
      const msg = attempt.error.message || '';
      if (attempt.error.code === 'PGRST204' || /Could not find the/.test(msg)) {
        console.warn('[DB] Schema mismatch detected; attempting minimal insert');
        const fallback = await client.from('scans').insert([
          {
            url,
            user_email: userEmail,
            total_violations: results.violations.length,
            affected_elements: totalAffectedElements,
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
    const client = supabaseAdmin || supabase;
    if (!supabaseAdmin) {
      console.warn('[DB] Warning: using anon key for emails_collected; configure SUPABASE_SERVICE_ROLE_KEY to avoid row-level security failures');
    }

    let existing = null;
    try {
      const { data, error } = await client
        .from('emails_collected')
        .select('*')
        .eq('email', email)
        .eq('url_scanned', url)
        .limit(1);
      if (error) {
        const msg = error.message || '';
        if (msg.toLowerCase().includes('row-level security') || msg.toLowerCase().includes('permission')) {
          console.warn('[DB] Skipping duplicate email check because of row-level security or permission error');
        } else {
          throw error;
        }
      } else if (data && data.length) {
        existing = data[0];
        console.log('[DB] Email already captured for this URL');
      }
    } catch (checkError) {
      console.warn('[DB] Duplicate email check failed:', checkError.message || checkError);
    }

    if (existing) {
      return existing;
    }

    const { data, error } = await client.from('emails_collected').insert([
      {
        email,
        url_scanned: url,
        created_at: new Date().toISOString(),
      },
    ]).select();

    if (error) {
      const msg = error.message || '';
      if (msg.toLowerCase().includes('row-level security') || msg.toLowerCase().includes('permission')) {
        throw new Error('Supabase row-level security or permission rules prevented saving the collected email. Configure SUPABASE_SERVICE_ROLE_KEY or allow inserts on emails_collected.');
      }
      throw error;
    }

    if (!data || !Array.isArray(data) || data.length === 0) {
      throw new Error('Collected email insert returned no data. Verify Supabase insert permissions and table schema.');
    }

    console.log('[DB] Saved collected email:', data[0]);
    return data[0];
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
    const client = supabaseAdmin || supabase;
    const { data, error } = await client
      .from('scans')
      .select('*')
      .eq('id', scanId)
      .limit(1);

    if (error) throw error;
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch (error) {
    console.error('[DB] Failed to fetch scan:', error.message);
    throw error;
  }
}

async function getScanHistory(url, userEmail, limit = 20) {
  const client = supabaseAdmin || supabase;
  let query = client
    .from('scans')
    .select('id,url,user_email,score,results_json,created_at')
    .eq('url', url)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (userEmail) query = query.eq('user_email', userEmail);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function getActiveSubscriptionByTokenHash(tokenHash) {
  if (!supabaseAdmin) throw new Error('Paid reports require SUPABASE_SERVICE_ROLE_KEY.');
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('access_token_hash', tokenHash)
    .eq('status', 'active')
    .limit(1);
  if (error) throw error;
  const subscription = data?.[0] || null;
  if (subscription?.current_period_end && new Date(subscription.current_period_end) <= new Date()) return null;
  return subscription;
}

async function claimScanForSubscriber(scanId, userEmail) {
  if (!supabaseAdmin) throw new Error('Paid reports require SUPABASE_SERVICE_ROLE_KEY.');
  const { data, error } = await supabaseAdmin
    .from('scans')
    .update({ user_email: userEmail, updated_at: new Date().toISOString() })
    .eq('id', scanId)
    .is('user_email', null)
    .select();
  if (error) throw error;
  return data?.[0] || null;
}

async function getCachedAiFix(fingerprint) {
  if (!supabaseAdmin) return null;
  if (!aiFixCacheAvailable) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('ai_fix_cache')
      .select('result_json')
      .eq('fingerprint', fingerprint)
      .limit(1);
    if (error) {
      const msg = (error && error.message) || '';
      console.warn('[DB] AI cache lookup failed:', msg);
      // If the table doesn't exist or permissions block access, disable further attempts
      if (/ai_fix_cache/i.test(msg) && (/does not exist|relation|could not find|permission|row-level security/i.test(msg) || /PGRST204/.test(error.code || ''))) {
        aiFixCacheAvailable = false;
        console.warn('[DB] Disabling AI cache lookups for future requests (table missing or inaccessible).');
      }
      return null;
    }
    return data?.[0]?.result_json || null;
  } catch (err) {
    const msg = (err && err.message) || err;
    console.warn('[DB] AI cache lookup unexpected failure:', msg);
    if (/ai_fix_cache/i.test(msg) && (/does not exist|relation|could not find|permission|row-level security/i.test(msg))) {
      aiFixCacheAvailable = false;
      console.warn('[DB] Disabling AI cache lookups for future requests (table missing or inaccessible).');
    }
    return null;
  }
}

async function saveCachedAiFix(fingerprint, criterion, result) {
  if (!supabaseAdmin) return null;
  if (!aiFixCacheAvailable) return null;
  try {
    const { error } = await supabaseAdmin.from('ai_fix_cache').upsert({
      fingerprint,
      criterion,
      result_json: result,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      const msg = (error && error.message) || '';
      console.warn('[DB] AI cache write failed:', msg);
      if (/ai_fix_cache/i.test(msg) && (/does not exist|relation|could not find|permission|row-level security/i.test(msg) || /PGRST204/.test(error.code || ''))) {
        aiFixCacheAvailable = false;
        console.warn('[DB] Disabling AI cache writes for future requests (table missing or inaccessible).');
      }
    }
    return result;
  } catch (err) {
    const msg = (err && err.message) || err;
    console.warn('[DB] AI cache upsert unexpected failure:', msg);
    if (/ai_fix_cache/i.test(msg) && (/does not exist|relation|could not find|permission|row-level security/i.test(msg))) {
      aiFixCacheAvailable = false;
      console.warn('[DB] Disabling AI cache writes for future requests (table missing or inaccessible).');
    }
    return result;
  }
}

async function upsertSubscription({ stripeCustomerId, stripeSubscriptionId, userEmail, plan, status, currentPeriodEnd, accessTokenHash, customerLogoUrl = null }) {
  if (!supabaseAdmin) throw new Error('upsertSubscription requires SUPABASE_SERVICE_ROLE_KEY.');
  const { data, error } = await supabaseAdmin.from('subscriptions').upsert({
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    user_email: userEmail,
    plan,
    status,
    current_period_end: currentPeriodEnd,
    access_token_hash: accessTokenHash,
    customer_logo_url: customerLogoUrl,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'stripe_subscription_id' }).select();
  if (error) throw error;
  return data?.[0];
}

async function getSubscriptionByStripeCustomer(stripeCustomerId) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client
    .from('subscriptions')
    .select('*')
    .eq('stripe_customer_id', stripeCustomerId)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function saveContactSubmission(name, email, website, message) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client.from('contact_submissions').insert([{
    name,
    email,
    website: website || null,
    message,
    created_at: new Date().toISOString(),
  }]).select();
  if (error) throw error;
  return data?.[0];
}

module.exports = {
  saveScanResults,
  saveCollectedEmail,
  saveContactSubmission,
  getUserScans,
  getScanById,
  getScanHistory,
  getActiveSubscriptionByTokenHash,
  claimScanForSubscriber,
  getCachedAiFix,
  saveCachedAiFix,
  upsertSubscription,
  getSubscriptionByStripeCustomer,
  supabase,
};
