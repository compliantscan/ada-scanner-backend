require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in environment variables');
  console.error('Required: SUPABASE_URL and either SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY');
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
 * @param {object|null} user - Authenticated user object (optional for anonymous scans)
 * @param {object} metadata - Additional metadata for the scan row
 * @returns {Promise<object>} - Database record
 */
async function saveScanResults(url, results, user = null, metadata = {}) {
  try {
    const resolvedUser = typeof user === 'string' ? { id: null, email: user } : user;
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
        user_id: resolvedUser?.id || null,
        user_email: resolvedUser?.email || null,
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
      const msg = attempt.error.message || '';
      if (attempt.error.code === 'PGRST204' || /Could not find the/.test(msg)) {
        console.warn('[DB] Schema mismatch detected; attempting fallback insert');

        const missingColumns = [];
        const missingColumnRegex = /Could not find the '([^']+)' column of 'scans'/g;
        let match;
        while ((match = missingColumnRegex.exec(msg)) !== null) {
          missingColumns.push(match[1]);
        }

        const basePayload = {
          url,
          user_id: resolvedUser?.id || null,
          user_email: resolvedUser?.email || null,
          total_violations: results.violations.length,
          affected_elements: totalAffectedElements,
          violations_by_severity: violationsBySeverity,
          results_json: results,
          score: metadata.score ?? null,
          access_key_hash: metadata.accessKeyHash || null,
          free_report_expires_at: metadata.freeReportExpiresAt || null,
          created_at: new Date().toISOString(),
        };

        const makeFallbackPayload = cols => {
          const payload = { url, user_id: resolvedUser?.id || null, user_email: resolvedUser?.email || null, total_violations: results.violations.length, results_json: results };
          if (!cols.includes('affected_elements')) payload.affected_elements = totalAffectedElements;
          if (!cols.includes('violations_by_severity')) payload.violations_by_severity = violationsBySeverity;
          if (!cols.includes('score')) payload.score = metadata.score ?? null;
          if (!cols.includes('access_key_hash')) payload.access_key_hash = metadata.accessKeyHash || null;
          if (!cols.includes('free_report_expires_at')) payload.free_report_expires_at = metadata.freeReportExpiresAt || null;
          if (!cols.includes('created_at')) payload.created_at = new Date().toISOString();
          return payload;
        };

        let fallbackPayload = makeFallbackPayload(missingColumns);
        let fallback = await client.from('scans').insert([fallbackPayload]).select();
        console.log('[DB] Supabase fallback insert result:', {
          status: fallback.status,
          data: fallback.data,
          error: fallback.error,
        });

        if (fallback.error) {
          const fallbackMsg = fallback.error.message || '';
          const secondMissing = [];
          while ((match = missingColumnRegex.exec(fallbackMsg)) !== null) {
            secondMissing.push(match[1]);
          }

          if (fallback.error.code === 'PGRST204' || /Could not find the/.test(fallbackMsg)) {
            console.warn('[DB] Second fallback due to schema mismatch; removing additional unknown columns');
            fallbackPayload = makeFallbackPayload([...new Set([...missingColumns, ...secondMissing])]);
            const secondAttempt = await client.from('scans').insert([fallbackPayload]).select();
            console.log('[DB] Supabase second fallback result:', {
              status: secondAttempt.status,
              data: secondAttempt.data,
              error: secondAttempt.error,
            });
            if (secondAttempt.error) {
              throw secondAttempt.error;
            }
            return secondAttempt.data || [];
          }
          throw fallback.error;
        }

        return fallback.data;
      }

      throw attempt.error;
    }

    // If insert returned no body (data null or empty), try to fetch the recently inserted row
    if (!attempt.data || (Array.isArray(attempt.data) && attempt.data.length === 0)) {
      console.warn('[DB] Insert returned no row; attempting to fetch recent row for URL');
      const { data: recent, error: recentError } = await client
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
 * Create a placeholder scan row (queued) and return the created record.
 * results_json contains a lightweight status object so clients can poll.
 */
async function createScanPlaceholder(url, user = null, extra = {}) {
  try {
    const client = supabaseAdmin || supabase;
    const resolvedUser = typeof user === 'string' ? { id: null, email: user } : user;
    const payload = {
      url,
      user_id: resolvedUser?.id || null,
      user_email: resolvedUser?.email || null,
      results_json: { _status: 'queued', _progress: 0 },
      created_at: new Date().toISOString(),
    };
    // Store scan_type and report_type if provided (best-effort: ignore column-missing errors)
    if (extra.scan_type) payload.scan_type = extra.scan_type;
    if (extra.report_type) payload.report_type = extra.report_type;
    const { data, error } = await client.from('scans').insert([payload]).select();
    if (error) {
      // If the column doesn't exist yet, retry without optional fields
      if (error.code === 'PGRST204' || /scan_type|report_type/.test(error.message || '')) {
        console.warn('[DB] scan_type/report_type columns missing, retrying without them');
        const { data: data2, error: error2 } = await client.from('scans').insert([{
          url, user_id: payload.user_id, user_email: payload.user_email,
          results_json: payload.results_json, created_at: payload.created_at,
        }]).select();
        if (error2) throw error2;
        return Array.isArray(data2) && data2.length ? data2[0] : null;
      }
      console.error('[DB] createScanPlaceholder insert error:', error.message || error);
      throw error;
    }
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch (err) {
    console.error('[DB] createScanPlaceholder failed:', err.message || err);
    throw err;
  }
}

/**
 * Update an existing scan row with final results after a background scan completes.
 */
async function updateScanWithResults(scanId, results, metadata = {}) {
  try {
    const client = supabaseAdmin || supabase;

    const violationsBySeverity = {
      critical: (results.violations || []).filter(v => v.impact === 'critical').length,
      serious: (results.violations || []).filter(v => v.impact === 'serious').length,
      moderate: (results.violations || []).filter(v => v.impact === 'moderate').length,
      minor: (results.violations || []).filter(v => v.impact === 'minor').length,
    };
    const totalAffectedElements = (results.violations || []).reduce(
      (sum, violation) => sum + (Array.isArray(violation.nodes) ? violation.nodes.length : 0),
      0
    );

    const payload = {
      results_json: {
        ...results,
        _status: 'completed',
        _progress: 100,
      },
      total_violations: Array.isArray(results.violations) ? results.violations.length : null,
      affected_elements: totalAffectedElements,
      violations_by_severity: violationsBySeverity,
      updated_at: new Date().toISOString(),
    };
    // Only include score if the caller provided it to avoid referencing a
    // missing column in older schemas.
    if (metadata && Object.prototype.hasOwnProperty.call(metadata, 'score')) {
      payload.score = metadata.score;
    }

    try {
      const { data, error } = await client.from('scans').update(payload).eq('id', scanId).select();
      if (error) {
        throw error;
      }
      return Array.isArray(data) && data.length ? data[0] : null;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      console.warn('[DB] updateScanWithResults update failed, attempting minimal fallback:', msg);
      // Fallback: update only the minimal fields that are unlikely to be missing
      const minimal = {
        results_json: payload.results_json,
        total_violations: payload.total_violations,
        affected_elements: payload.affected_elements,
        violations_by_severity: payload.violations_by_severity,
        updated_at: payload.updated_at,
      };
      const { data: fbData, error: fbErr } = await client.from('scans').update(minimal).eq('id', scanId).select();
      if (fbErr) {
        console.error('[DB] updateScanWithResults minimal fallback failed:', fbErr.message || fbErr);
        throw fbErr;
      }
      return Array.isArray(fbData) && fbData.length ? fbData[0] : null;
    }
  } catch (err) {
    console.error('[DB] updateScanWithResults failed:', err.message || err);
    throw err;
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
 * @param {string} userId - User ID
 * @returns {Promise<array>} - Array of scans
 */
async function getUserScans(userId) {
  try {
    const client = supabaseAdmin || supabase;
    const { data, error } = await client
      .from('scans')
      .select('id, url, user_id, user_email, total_violations, violations_by_severity, affected_elements, score, created_at, updated_at')
      .eq('user_id', userId)
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
    // Try a full select first. If the DB schema has changed (missing columns),
    // PostgREST can return an error like "Could not find the 'score' column".
    // In that case, fall back to selecting a minimal set of columns that we
    // know are safe to query (id, url, results_json, created_at, user_email).
    try {
      const { data, error } = await client
        .from('scans')
        .select('*')
        .eq('id', scanId)
        .limit(1);
      if (error) throw error;
      return Array.isArray(data) && data.length ? data[0] : null;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      console.warn('[DB] getScanById full select failed:', msg);
      // Fallback to minimal safe columns
      const { data: fallbackData, error: fallbackError } = await client
        .from('scans')
        .select('id,url,user_id,user_email,results_json,created_at,total_violations,violations_by_severity,affected_elements')
        .eq('id', scanId)
        .limit(1);
      if (fallbackError) {
        console.error('[DB] getScanById fallback select failed:', fallbackError.message || fallbackError);
        throw fallbackError;
      }
      return Array.isArray(fallbackData) && fallbackData.length ? fallbackData[0] : null;
    }
  } catch (error) {
    console.error('[DB] Failed to fetch scan:', error.message);
    throw error;
  }
}

async function getScanHistory(url, userId, limit = 20) {
  const client = supabaseAdmin || supabase;
  let query = client
    .from('scans')
    .select('id,url,user_id,user_email,score,results_json,created_at')
    .eq('url', url)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (userId) query = query.eq('user_id', userId);
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

async function deleteScanById(scanId) {
  const client = supabaseAdmin || supabase;
  const { error } = await client.from('scans').delete().eq('id', scanId);
  if (error) throw error;
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

async function addMonitoredSite(userId, url, frequency = 'weekly', pagesMonitored = 1, alertsEnabled = true) {
  const client = supabaseAdmin || supabase;
  const nextScan = new Date();
  nextScan.setMinutes(nextScan.getMinutes() + 5); // Schedule first scan 5 mins from now
  const { data, error } = await client.from('monitored_sites').insert([{
    user_id: userId,
    url,
    frequency,
    pages_monitored: pagesMonitored,
    alerts_enabled: alertsEnabled,
    status: 'pending',
    next_scan_at: nextScan.toISOString(),
  }]).select();
  if (error) throw error;
  return data?.[0];
}

async function getMonitoredSitesByUser(userId) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client
    .from('monitored_sites')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getMonitoredSiteById(siteId) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client
    .from('monitored_sites')
    .select('*')
    .eq('id', siteId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

async function updateMonitoredSite(siteId, updates) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client
    .from('monitored_sites')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', siteId)
    .select();
  if (error) throw error;
  return data?.[0];
}

async function deleteMonitoredSite(siteId) {
  const client = supabaseAdmin || supabase;
  const { error } = await client
    .from('monitored_sites')
    .delete()
    .eq('id', siteId);
  if (error) throw error;
}

async function getSitesDueForScan() {
  if (!supabaseAdmin) throw new Error('Requires SUPABASE_SERVICE_ROLE_KEY.');
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('monitored_sites')
    .select('*')
    .lte('next_scan_at', now)
    .neq('status', 'paused');
  if (error) throw error;
  return data || [];
}

async function addMonitoringScan(monitorId, auditId, scanData) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client.from('monitoring_scans').insert([{
    monitor_id: monitorId,
    audit_id: auditId,
    score: scanData.score,
    critical_count: scanData.critical_count,
    serious_count: scanData.serious_count,
    moderate_count: scanData.moderate_count,
    minor_count: scanData.minor_count,
    pages_scanned: scanData.pages_scanned,
    violations_json: scanData.violations_json,
  }]).select();
  if (error) throw error;
  return data?.[0];
}

async function getMonitoringScans(monitorId, limit = 12) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client
    .from('monitoring_scans')
    .select('*')
    .eq('monitor_id', monitorId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function getLatestMonitoringScan(monitorId) {
  const scans = await getMonitoringScans(monitorId, 1);
  return scans.length > 0 ? scans[0] : null;
}

async function addMonitoringAlert(monitorId, type, severity, message) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client.from('monitoring_alerts').insert([{
    monitor_id: monitorId,
    type,
    severity,
    message,
  }]).select();
  if (error) throw error;
  return data?.[0];
}

async function getAlertsByUser(userId) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client
    .from('monitoring_alerts')
    .select('*, monitored_sites!inner(user_id, url)')
    .eq('monitored_sites.user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getAlertsByMonitor(monitorId) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client
    .from('monitoring_alerts')
    .select('*')
    .eq('monitor_id', monitorId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function markAlertRead(alertId) {
  const client = supabaseAdmin || supabase;
  const { data, error } = await client
    .from('monitoring_alerts')
    .update({ read: true })
    .eq('id', alertId)
    .select();
  if (error) throw error;
  return data?.[0];
}

module.exports = {
  saveScanResults,
  createScanPlaceholder,
  updateScanWithResults,
  saveCollectedEmail,
  saveContactSubmission,
  getUserScans,
  getScanById,
  deleteScanById,
  getScanHistory,
  getActiveSubscriptionByTokenHash,
  claimScanForSubscriber,
  getCachedAiFix,
  saveCachedAiFix,
  upsertSubscription,
  getSubscriptionByStripeCustomer,
  addMonitoredSite,
  getMonitoredSitesByUser,
  getMonitoredSiteById,
  updateMonitoredSite,
  deleteMonitoredSite,
  getSitesDueForScan,
  addMonitoringScan,
  getMonitoringScans,
  getLatestMonitoringScan,
  addMonitoringAlert,
  getAlertsByUser,
  getAlertsByMonitor,
  markAlertRead,
  supabase,
};
