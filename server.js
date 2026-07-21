// Load environment variables early so dependent modules can use them
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { scanUrl } = require('./scanner');
const { saveScanResults, createScanPlaceholder, updateScanWithResults, saveCollectedEmail, saveContactSubmission, getScanById, getUserScans, getActiveSubscriptionByTokenHash, claimScanForSubscriber, upsertSubscription, getSubscriptionByStripeCustomer } = require('./db');
const { buildFreePaidBoundaryReport, buildPaidReport } = require('./paid-report-service');
const { generatePaidReportPdf } = require('./report');
const { sendPdfAttachmentEmail } = require('./email');
const { bearerToken, generateAccessKey, hashSecret, safeHashMatch } = require('./entitlements');
const { calculateScore } = require('./scoring');
const requireAuth = require('./middleware/requireAuth');
const { initCronJobs, runMonitorScan } = require('./cron');
const {
  addMonitoredSite,
  getMonitoredSitesByUser,
  getMonitoredSiteById,
  updateMonitoredSite,
  deleteMonitoredSite,
  getMonitoringScans,
  getLatestMonitoringScan,
  getAlertsByUser,
  getAlertsByMonitor,
  markAlertRead
} = require('./db');

// Start cron jobs
initCronJobs();

const app = express();
const PORT = process.env.PORT || 3000;
const supabaseAuthClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || null,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);
const allowAllOrigins = !process.env.CORS_ALLOWED_ORIGINS;
const allowedOrigins = allowAllOrigins
  ? []
  : process.env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowAllOrigins || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS origin denied: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

if (allowAllOrigins) {
  console.warn('[CORS] No CORS_ALLOWED_ORIGINS configured. Allowing all origins.');
} else {
  console.log('[CORS] Allowed origins:', allowedOrigins);
}

app.use(cors(corsOptions));

// Stripe webhook must receive raw body — register before express.json
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_PLANS = {
  starter: process.env.STRIPE_PRICE_STARTER,
  growth: process.env.STRIPE_PRICE_GROWTH,
  agency: process.env.STRIPE_PRICE_AGENCY,
};

app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(503).json({ message: 'Webhook not configured.' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[STRIPE] Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const customer = await stripe.customers.retrieve(session.customer);
      const plan = session.metadata?.plan || 'starter';
      const accessToken = generateAccessKey();
      await upsertSubscription({
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        userEmail: customer.email || session.customer_email || '',
        plan,
        status: 'active',
        currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
        accessTokenHash: hashSecret(accessToken),
      });
      console.log(`[STRIPE] Subscription activated: ${session.subscription} plan=${plan}`);
    }
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const existing = await getSubscriptionByStripeCustomer(sub.customer);
      if (existing) {
        await upsertSubscription({
          stripeCustomerId: sub.customer,
          stripeSubscriptionId: sub.id,
          userEmail: existing.user_email,
          plan: existing.plan,
          status: sub.status === 'active' ? 'active' : 'inactive',
          currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
          accessTokenHash: existing.access_token_hash,
        });
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const existing = await getSubscriptionByStripeCustomer(sub.customer);
      if (existing) {
        await upsertSubscription({
          stripeCustomerId: sub.customer,
          stripeSubscriptionId: sub.id,
          userEmail: existing.user_email,
          plan: existing.plan,
          status: 'inactive',
          currentPeriodEnd: existing.current_period_end,
          accessTokenHash: existing.access_token_hash,
        });
        console.log(`[STRIPE] Subscription cancelled: ${sub.id}`);
      }
    }
  } catch (err) {
    console.error('[STRIPE] Webhook handler error:', err.message);
    return res.status(500).send('Handler error');
  }
  return res.json({ received: true });
});

// Axe findings can include enough HTML snippets to exceed Express's 100 KB default.
app.use(express.json({ limit: '5mb' }));

async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return next();
  }

  const { data: { user }, error } = await supabaseAuthClient.auth.getUser(token);

  if (!error && user) {
    req.user = user;
  }

  next();
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isReasonableString(value, maxLength = 2048) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function normalizedScanUrl(value) {
  if (typeof value !== 'string') throw new Error('URL must be a string');
  const trimmed = value.trim();
  if (!trimmed) throw new Error('URL is required');

  let normalized = trimmed;
  if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  if ((normalized.match(/https?:\/\//gi) || []).length > 1) {
    throw new Error('Invalid URL: multiple protocols detected.');
  }

  const parsed = new URL(normalized);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL must use http or https');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'http' || hostname === 'https') {
    throw new Error('Invalid URL hostname.');
  }
  if (parsed.pathname.startsWith('//')) {
    throw new Error('Invalid URL format.');
  }

  parsed.hash = '';
  return parsed.toString();
}

async function authorizePaidScan(req, scanId, scanAccessKey) {
  const subscriptionToken = bearerToken(req);
  if (!subscriptionToken) {
    const error = new Error('A paid report subscription token is required.');
    error.statusCode = 402;
    throw error;
  }

  const subscription = await getActiveSubscriptionByTokenHash(hashSecret(subscriptionToken));
  if (!subscription) {
    const error = new Error('No active Starter, Pro, or Business subscription was found for this token.');
    error.statusCode = 403;
    throw error;
  }

  let scan = await getScanById(Number(scanId));
  if (!scan) {
    const error = new Error('Scan not found.');
    error.statusCode = 404;
    throw error;
  }

  if (scan.access_key_hash && !safeHashMatch(scanAccessKey, scan.access_key_hash)) {
    const error = new Error('The scan access key is invalid or missing.');
    error.statusCode = 403;
    throw error;
  }

  if (scan.user_email && scan.user_email !== subscription.user_email) {
    const error = new Error('This scan belongs to another account.');
    error.statusCode = 403;
    throw error;
  }

  if (!scan.user_email) scan = await claimScanForSubscriber(scan.id, subscription.user_email) || scan;
  return { scan, subscription };
}

async function authorizeScanAccess(scanId, scanAccessKey) {
  const scan = await getScanById(Number(scanId));
  if (!scan) {
    const error = new Error('Scan not found.');
    error.statusCode = 404;
    throw error;
  }
  if (scan.access_key_hash && !safeHashMatch(scanAccessKey, scan.access_key_hash)) {
    const error = new Error('The scan access key is invalid or missing.');
    error.statusCode = 403;
    throw error;
  }
  return scan;
}

function unlockedCapabilities({ subscribed = false } = {}) {
  return {
    pdfDownload: true,
    sharing: true,
    fixes: true,
    badge: true,
    monitoring: Boolean(subscribed),
  };
}

function queueCollectedEmailReport(email, scanId) {
  setImmediate(async () => {
    try {
      if (!scanId || Number.isNaN(Number(scanId))) return;
      const scan = await getScanById(Number(scanId));
      if (!scan) return;
      const report = await buildFreePaidBoundaryReport(scan);
      const pdfBuffer = await generatePaidReportPdf(report);
      await sendPdfAttachmentEmail(email, scan.url, pdfBuffer, `ada-full-report-${scanId}.pdf`);
      console.log(`[EMAIL] PDF report queued and sent to ${email} for scan ${scanId}`);
    } catch (error) {
      console.warn(`[EMAIL] Background PDF email failed for ${email}: ${error.message}`);
    }
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'API is running' });
});

// Dashboard stats endpoint — returns aggregated data for the dashboard home page
app.get('/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const { supabase: db } = require('./db');
    // Use service-role client if available for full read access
    const { createClient: mkClient } = require('@supabase/supabase-js');
    const adminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const client = adminKey
      ? mkClient(process.env.SUPABASE_URL, adminKey)
      : db;

    // Fetch only scans belonging to the authenticated user
    const { data: scans, error } = await client
      .from('scans')
      .select('id, url, score, total_violations, violations_by_severity, affected_elements, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const rows = scans || [];

    // ── Aggregate stats ────────────────────────────────────────────────────
    // 1. Unique domains
    const domains = new Set(rows.map(s => {
      try { return new URL(s.url).hostname; } catch { return s.url; }
    }));
    const websitesScanned = domains.size;

    // 2. Pages scanned — fall back to 1 per scan when no explicit count exists
    const pagesScanned = rows.reduce((sum, s) => {
      const pages = s.pages_scanned;
      return sum + (Number.isFinite(pages) ? pages : 1);
    }, 0);

    // 3. Total violations
    const totalViolations = rows.reduce((sum, s) => {
      if (Number.isFinite(s.total_violations)) return sum + s.total_violations;
      // fall back to results_json
      const v = s.results_json?.violations;
      return sum + (Array.isArray(v) ? v.length : 0);
    }, 0);

    // 4. Critical issues
    const criticalIssues = rows.reduce((sum, s) => {
      const bySeverity = s.violations_by_severity;
      if (bySeverity && Number.isFinite(bySeverity.critical)) return sum + bySeverity.critical;
      // fall back to results_json
      const v = s.results_json?.violations;
      if (Array.isArray(v)) return sum + v.filter(vio => vio.impact === 'critical').length;
      return sum;
    }, 0);

    // 5. Average score — calculate from severity if score is missing
    function calculateApproxScore(scan) {
      // If a precomputed `score` exists and is numeric, use it.
      if (Object.prototype.hasOwnProperty.call(scan, 'score') && Number.isFinite(scan.score)) return scan.score;
      const bySev = scan.violations_by_severity;
      if (bySev) {
        const deduction =
          (bySev.critical || 0) * 10 +
          (bySev.serious  || 0) * 5  +
          (bySev.moderate || 0) * 2  +
          (bySev.minor    || 0) * 1;
        return Math.max(0, Math.min(100, 100 - deduction));
      }
      const v = scan.results_json?.violations;
      if (Array.isArray(v)) {
        const deduction = v.reduce((d, vio) => {
          if (vio.impact === 'critical') return d + 10;
          if (vio.impact === 'serious')  return d + 5;
          if (vio.impact === 'moderate') return d + 2;
          if (vio.impact === 'minor')    return d + 1;
          return d;
        }, 0);
        return Math.max(0, Math.min(100, 100 - deduction));
      }
      return 100;
    }

    const avgScore = rows.length
      ? Math.round(rows.reduce((sum, s) => sum + calculateApproxScore(s), 0) / rows.length)
      : 0;

    // 6. Scans this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const scansThisMonth = rows.filter(s => s.created_at >= monthStart).length;

    // ── Recent reports (latest 5) ──────────────────────────────────────────
    const latest5 = rows.slice(0, 5);

    // Build a domain → previous-scan map for violation diff
    const domainPrevViolations = {};
    rows.slice(5).forEach(s => {
      let host;
      try { host = new URL(s.url).hostname; } catch { host = s.url; }
      if (!(host in domainPrevViolations)) {
        const v = Number.isFinite(s.total_violations)
          ? s.total_violations
          : (Array.isArray(s.results_json?.violations) ? s.results_json.violations.length : null);
        domainPrevViolations[host] = v;
      }
    });

    const recentReports = latest5.map(scan => {
      let hostname;
      try { hostname = new URL(scan.url).hostname; } catch { hostname = scan.url; }

      const scanScore = calculateApproxScore(scan);
      const violations = Number.isFinite(scan.total_violations)
        ? scan.total_violations
        : (Array.isArray(scan.results_json?.violations) ? scan.results_json.violations.length : 0);

      const pages = scan.pages_scanned ?? 1;
      const scanType = pages > 1 ? 'Full Website' : 'Single Page';
      const scanTypeVariant = pages > 1 ? 'blue' : 'green';

      let riskLevel, riskVariant;
      if (scanScore >= 80)      { riskLevel = 'Low Risk';    riskVariant = 'green'; }
      else if (scanScore >= 60) { riskLevel = 'Medium Risk'; riskVariant = 'orange'; }
      else                      { riskLevel = 'High Risk';   riskVariant = 'red'; }

      const prevViolations = domainPrevViolations[hostname] ?? null;
      let violationsChange = null;
      if (prevViolations !== null) {
        violationsChange = violations - prevViolations; // positive = more, negative = fewer
      }

      return {
        id: scan.id,
        domain: hostname,
        url: scan.url,
        scanType,
        scanTypeVariant,
        pages: Number.isFinite(pages) ? pages : 1,
        score: scanScore,
        violations,
        violationsChange,
        riskLevel,
        riskVariant,
        scannedAt: scan.created_at,
      };
    });

    return res
      .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      .json({
      websitesScanned,
      pagesScanned,
      totalViolations,
      criticalIssues,
      avgScore,
      scansThisMonth,
      monthlyLimit: 100,
      recentReports,
      totalScans: rows.length,
    });
  } catch (err) {
    console.error('[API] /dashboard/stats error:', err.message);
    return res.status(500).json({ error: 'Failed to load dashboard stats', message: err.message });
  }
});

app.get('/report/:scanId', async (req, res) => {
  try {
    const scanId = Number(req.params.scanId);
    if (Number.isNaN(scanId)) {
      return res.status(400).json({ error: 'Invalid scan ID' });
    }

    const scan = await getScanById(scanId);
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }

    const normalizedScan = {
      ...scan,
      results: scan.results || scan.result || scan.results_json || scan.scan_results || null,
      result: scan.result || scan.results || scan.results_json || scan.scan_results || null,
      scan_results: scan.scan_results || scan.results || scan.result || scan.results_json || null,
    };

    return res.json({ scan: normalizedScan });
  } catch (error) {
    console.error('[API] Failed to load public report:', error.message);
    return res.status(500).json({ error: 'Unable to load report' });
  }
});

// POST /scan endpoint - accepts URL and returns violations
app.post('/scan', optionalAuth, async (req, res) => {
  try {
    const { url } = req.body;

    // Validate URL
    if (!url) {
      return res.status(400).json({
        error: 'Missing URL',
        message: 'Please provide a URL in the request body: { "url": "https://example.com" }',
      });
    }

    // Validate URL format
    let normalizedUrl;
    try {
      normalizedUrl = normalizedScanUrl(url);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid URL',
        message: 'Please provide a valid URL starting with http:// or https://',
      });
    }

    console.log(`[${new Date().toISOString()}] Scanning: ${normalizedUrl}`);
    
    // Run the scan
    let results;
    try {
      console.log('[API] Launching scanUrl');
      results = await scanUrl(normalizedUrl);
      console.log('[API] scanUrl completed successfully');
    } catch (scanError) {
      console.error('[API] scanUrl error:', scanError && (scanError.stack || scanError));
      if (scanError.name === 'ScanError') {
        return res.status(scanError.httpStatus || 400).json({
          error: scanError.name,
          message: scanError.message,
        });
      }
      throw scanError;
    }

    const now = new Date();
    const scanAccessKey = generateAccessKey();
    const freeReportExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const score = calculateScore(results.violations);

    // Save results to Supabase (best-effort)
    let savedRecord = null;
    try {
      if (req.user?.id || req.user?.email) {
        console.log('Authenticated scan user:', req.user?.id, req.user?.email);
      }
      savedRecord = await saveScanResults(normalizedUrl, results, req.user || null, {
        score,
        accessKeyHash: hashSecret(scanAccessKey),
        freeReportExpiresAt,
      });
    } catch (dbError) {
      console.warn('[API] Warning: Could not save to database, but scan completed successfully');
      console.warn(dbError.message);
      // Continue and return scan results even if DB save fails
    }

    const scanId = (savedRecord && savedRecord[0] && savedRecord[0].id) || null;
    const scanRecord = {
      id: scanId,
      url: normalizedUrl,
      results_json: results,
      created_at: now.toISOString(),
    };
    const fullReport = await buildFreePaidBoundaryReport(scanRecord);


    return res.json({
      success: true,
      scanId,
      tier: 'free',
      id: scanId,
      url: normalizedUrl,
      timestamp: now.toISOString(),
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      reportId: fullReport.reportId,
      executiveSummary: fullReport.executiveSummary,
      priorityChecklist: fullReport.priorityChecklist,
      violations: fullReport.violations,
      pages: fullReport.pages,
      complianceBadgeHtml: fullReport.complianceBadgeHtml,
      capabilities: { pdfDownload: false, sharing: false, fixes: true, badge: false, monitoring: false },
      hiddenViolationCount: Math.max(0, fullReport.violations.length - 3),
      scanAccessKey,
      savedToDatabase: !!savedRecord,
    });
  } catch (error) {
    console.error('Scan error:', error && (error.stack || error));
    return res.status(500).json({
      error: 'Scan failed',
      message: error.message || 'Unexpected server error',
    });
  }
});

app.get('/dashboard/report/:scanId', requireAuth, async (req, res) => {
  try {
    const scanId = Number(req.params.scanId);
    if (Number.isNaN(scanId)) return res.status(400).json({ error: 'Invalid scan ID' });
    const scan = await getScanById(scanId);
    if (!scan) return res.status(404).json({ error: 'Scan not found' });
    if (scan.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const report = await buildFreePaidBoundaryReport(scan);
    return res.json({ scan: { ...scan, ...report } });
  } catch (error) {
    console.error('[API] Failed to load dashboard report:', error.message);
    return res.status(500).json({ error: 'Unable to load report' });
  }
});

app.get('/dashboard/scans', requireAuth, async (req, res) => {
  try {
    const scans = await getUserScans(req.user.id);
    return res.json({ scans: scans || [] });
  } catch (error) {
    console.error('[API] Failed to load user scans:', error.message);
    return res.status(500).json({ error: 'Unable to load scans' });
  }
});

// Create a dashboard audit (queued) and run the scan in background. Returns immediately with audit id.
app.post('/dashboard/scan', requireAuth, async (req, res) => {
  try {
    const { url, scan_type = 'single', report_type = 'executive' } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    let normalizedUrl;
    try { normalizedUrl = normalizedScanUrl(url); } catch (err) { return res.status(400).json({ error: 'Invalid URL', message: err.message }); }

    // Create placeholder record, storing scan_type and report_type
    const placeholder = await createScanPlaceholder(
      normalizedUrl,
      { id: req.user.id, email: req.user.email },
      { scan_type, report_type }
    );
    const scanId = placeholder?.id || null;

    // Kick off background scan (do not await)
    setImmediate(async () => {
      try {
        // mark as scanning
        try {
          await (require('./db').supabase)
            .from('scans')
            .update({ results_json: { _status: 'scanning', _progress: 5 } })
            .eq('id', scanId);
        } catch (e) {
          console.warn('[BG-SCAN] Failed to mark scanning status:', e.message || e);
        }

        const results = await scanUrl(normalizedUrl);
        const score = calculateScore(results.violations);

        // Update scan row with final results
        await updateScanWithResults(scanId, results, { score });
        console.log(`[BG-SCAN] Background scan ${scanId} completed`);
      } catch (err) {
        console.error(`[BG-SCAN] Scan ${scanId} failed:`, err && (err.stack || err));
        try {
          await (require('./db').supabase)
            .from('scans')
            .update({ results_json: { _status: 'failed', _error: err.message || String(err) } })
            .eq('id', scanId);
        } catch (uerr) {
          console.warn('[BG-SCAN] Failed to mark scan failed:', uerr.message || uerr);
        }
      }
    });

    return res.json({ success: true, scanId });
  } catch (error) {
    console.error('[API] /dashboard/scan error:', error && (error.stack || error));
    return res.status(500).json({ error: 'Failed to create audit', message: error.message });
  }
});

// GET /dashboard/monitoring - Get monitored sites for user
app.get('/dashboard/monitoring', requireAuth, async (req, res) => {
  try {
    const sites = await getMonitoredSitesByUser(req.user.id);
    
    // Add summary stats
    let healthy = 0;
    let warning = 0;
    let critical = 0;
    for (const s of sites) {
      if (s.status === 'healthy') healthy++;
      if (s.status === 'warning') warning++;
      if (s.status === 'critical') critical++;
    }
    
    return res.json({ sites, summary: { healthy, warning, critical, total: sites.length } });
  } catch (error) {
    console.error('[API] /dashboard/monitoring GET error:', error);
    return res.status(500).json({ error: 'Unable to fetch monitored sites' });
  }
});

// POST /dashboard/monitoring - Add a site to monitor
app.post('/dashboard/monitoring', requireAuth, async (req, res) => {
  try {
    const { url, frequency, pages_monitored, alerts_enabled } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    let normalizedUrl;
    try { normalizedUrl = normalizedScanUrl(url); } catch (err) { return res.status(400).json({ error: 'Invalid URL', message: err.message }); }
    
    const site = await addMonitoredSite(req.user.id, normalizedUrl, frequency, pages_monitored, alerts_enabled);
    return res.json({ success: true, site });
  } catch (error) {
    console.error('[API] /dashboard/monitoring POST error:', error);
    return res.status(500).json({ error: 'Failed to add monitored site', message: error.message });
  }
});

// GET /dashboard/monitoring/alerts - Get all alerts for user
app.get('/dashboard/monitoring/alerts', requireAuth, async (req, res) => {
  try {
    const alerts = await getAlertsByUser(req.user.id);
    return res.json({ alerts });
  } catch (error) {
    console.error('[API] /dashboard/monitoring/alerts GET error:', error);
    return res.status(500).json({ error: 'Failed to get alerts', message: error.message });
  }
});

// POST /dashboard/monitoring/alerts/:id/read - Mark alert as read
app.post('/dashboard/monitoring/alerts/:id/read', requireAuth, async (req, res) => {
  try {
    const alert = await markAlertRead(req.params.id);
    return res.json({ success: true, alert });
  } catch (error) {
    console.error('[API] /dashboard/monitoring/alerts/:id/read error:', error);
    return res.status(500).json({ error: 'Failed to mark alert read' });
  }
});

// GET /dashboard/monitoring/:id - Get specific site, its scans, and its alerts
app.get('/dashboard/monitoring/:id', requireAuth, async (req, res) => {
  try {
    const site = await getMonitoredSiteById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    if (site.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const scans = await getMonitoringScans(site.id, 12);
    const alerts = await getAlertsByMonitor(site.id);

    return res.json({ site, scans, alerts });
  } catch (error) {
    console.error('[API] /dashboard/monitoring/:id GET error:', error);
    return res.status(500).json({ error: 'Failed to fetch site', message: error.message });
  }
});

// PUT /dashboard/monitoring/:id - Update site
app.put('/dashboard/monitoring/:id', requireAuth, async (req, res) => {
  try {
    const site = await getMonitoredSiteById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    if (site.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { frequency, status, alerts_enabled } = req.body;
    const updates = {};
    if (frequency) updates.frequency = frequency;
    if (status) updates.status = status;
    if (alerts_enabled !== undefined) updates.alerts_enabled = alerts_enabled;

    const updatedSite = await updateMonitoredSite(site.id, updates);
    return res.json({ success: true, site: updatedSite });
  } catch (error) {
    console.error('[API] /dashboard/monitoring/:id PUT error:', error);
    return res.status(500).json({ error: 'Failed to update site', message: error.message });
  }
});

// DELETE /dashboard/monitoring/:id - Remove site
app.delete('/dashboard/monitoring/:id', requireAuth, async (req, res) => {
  try {
    const site = await getMonitoredSiteById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    if (site.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    await deleteMonitoredSite(site.id);
    return res.json({ success: true });
  } catch (error) {
    console.error('[API] /dashboard/monitoring/:id DELETE error:', error);
    return res.status(500).json({ error: 'Failed to delete site', message: error.message });
  }
});

// POST /dashboard/monitoring/:id/scan - Run Scan Now
app.post('/dashboard/monitoring/:id/scan', requireAuth, async (req, res) => {
  try {
    const site = await getMonitoredSiteById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    if (site.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    // Run async to not block request
    runMonitorScan(site).catch(err => console.error('Background monitor scan failed:', err));

    return res.json({ success: true, message: 'Scan started' });
  } catch (error) {
    console.error('[API] /dashboard/monitoring/:id/scan POST error:', error);
    return res.status(500).json({ error: 'Failed to start scan', message: error.message });
  }
});

// GET /dashboard/monitoring/:id/compare - Compare latest 2 scans
app.get('/dashboard/monitoring/:id/compare', requireAuth, async (req, res) => {
  try {
    const site = await getMonitoredSiteById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    if (site.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const scans = await getMonitoringScans(site.id, 2);
    if (scans.length < 2) {
      return res.json({ error: 'Need at least 2 scans to compare' });
    }

    const current = scans[0];
    const previous = scans[1];

    const prevRuleIds = new Set((previous.violations_json || []).map(v => v.id));
    const currRuleIds = new Set((current.violations_json || []).map(v => v.id));

    const newIssues = (current.violations_json || []).filter(v => !prevRuleIds.has(v.id));
    const fixedIssues = (previous.violations_json || []).filter(v => !currRuleIds.has(v.id));

    const scoreDiff = current.score - previous.score;

    return res.json({
      current,
      previous,
      newIssues,
      fixedIssues,
      scoreDiff
    });
  } catch (error) {
    console.error('[API] /dashboard/monitoring/:id/compare GET error:', error);
    return res.status(500).json({ error: 'Failed to compare scans', message: error.message });
  }
});

// Fetch raw scan row (status/progress) for dashboard audit polling
app.get('/dashboard/scan/:scanId', requireAuth, async (req, res) => {
  try {
    const scanId = Number(req.params.scanId);
    if (Number.isNaN(scanId)) return res.status(400).json({ error: 'Invalid scan ID' });
    const scan = await getScanById(scanId);
    if (!scan) return res.status(404).json({ error: 'Scan not found' });
    if (scan.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    // Backfill status for scans created before status tracking was implemented.
    const resultsJson = scan.results_json || {};
    if (!resultsJson._status && Array.isArray(resultsJson.violations)) {
      scan.results_json = {
        ...resultsJson,
        _status: 'completed',
        _progress: 100,
      };
    }

    return res.json({ scan });
  } catch (error) {
    console.error('[API] /dashboard/scan/:id error:', error.message);
    return res.status(500).json({ error: 'Unable to load scan', message: error.message });
  }
});

// Delete a scan
app.delete('/dashboard/scan/:id', requireAuth, async (req, res) => {
  try {
    const scanId = Number(req.params.id);
    if (Number.isNaN(scanId)) return res.status(400).json({ error: 'Invalid scan ID' });
    const scan = await getScanById(scanId);
    if (!scan) return res.status(404).json({ error: 'Scan not found' });
    if (scan.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    
    await require('./db').deleteScanById(scanId);
    return res.json({ success: true });
  } catch (error) {
    console.error('[API] /dashboard/scan DELETE error:', error.message);
    return res.status(500).json({ error: 'Unable to delete scan', message: error.message });
  }
});

app.post('/collect-email', async (req, res) => {
  const submittedAt = Date.now();
  try {
    const { email, url, scanId } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Missing data',
        message: 'Email is required.',
      });
    }

    if (!isValidEmail(email) || email.length > 254) {
      return res.status(400).json({
        error: 'Invalid email',
        message: 'Please provide a valid email address.',
      });
    }

    let urlToSave = url;
    if (scanId && !Number.isNaN(Number(scanId))) {
      const scan = await getScanById(Number(scanId));
      if (scan && scan.url) urlToSave = scan.url;
    }

    const isPricingInterest = typeof urlToSave === 'string' && urlToSave.startsWith('pricing-interest');

    if (!isPricingInterest) {
      if (!urlToSave) {
        return res.status(400).json({ error: 'Missing data', message: 'Email and url or scanId are required.' });
      }
      let parsedUrl;
      try { parsedUrl = new URL(urlToSave); } catch { parsedUrl = null; }
      if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({ error: 'Invalid request', message: 'URL must be a valid http or https address.' });
      }
      urlToSave = parsedUrl.toString();
    }

    await saveCollectedEmail(email.toLowerCase(), urlToSave);
    if (!isPricingInterest) queueCollectedEmailReport(email.toLowerCase(), scanId);

    console.log(`[LEAD] Captured ${email.toLowerCase()} for ${urlToSave} in ${Date.now() - submittedAt}ms`);
    return res.json({
      success: true,
      unlocked: !isPricingInterest,
      capabilities: isPricingInterest ? null : unlockedCapabilities({ subscribed: false }),
      message: isPricingInterest
        ? "Thanks! We'll email you when this plan is ready."
        : 'Email saved. The full report is unlocked and the PDF is being emailed.',
    });
  } catch (error) {
    console.error('Email collection error:', error);
    return res.status(500).json({
      error: 'Unable to send report',
      message: error.message,
    });
  }
});

app.post('/paid-report', async (req, res) => {
  try {
    const { scanId, scanAccessKey } = req.body;
    if (!scanId || Number.isNaN(Number(scanId))) {
      return res.status(400).json({
        error: 'Missing scanId',
        message: 'Please provide a valid numeric scanId in the request body.',
      });
    }

    const { scan, subscription } = await authorizePaidScan(req, scanId, scanAccessKey);
    const report = await buildPaidReport(scan, subscription);
    return res.json(report);
  } catch (error) {
    console.error('Paid report error:', error);
    return res.status(error.statusCode || 500).json({ error: 'Unable to generate paid report', message: error.message });
  }
});

app.post('/lead-report/pdf', async (req, res) => {
  try {
    const { scanId, scanAccessKey } = req.body;
    if (!scanId || Number.isNaN(Number(scanId))) {
      return res.status(400).json({ error: 'Missing scanId', message: 'Please provide a valid numeric scanId.' });
    }
    const scan = await authorizeScanAccess(scanId, scanAccessKey);
    const report = await buildFreePaidBoundaryReport(scan);
    const pdfBuffer = await generatePaidReportPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ada-full-report-${scanId}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Lead report PDF error:', error);
    return res.status(error.statusCode || 500).json({ error: 'Unable to generate report PDF', message: error.message });
  }
});

app.post('/contact', async (req, res) => {
  try {
    const { name, email, website, message } = req.body;
    if (!isReasonableString(name, 200)) return res.status(400).json({ message: 'Name is required.' });
    if (!isValidEmail(email) || email.length > 254) return res.status(400).json({ message: 'A valid email is required.' });
    if (!isReasonableString(message, 5000)) return res.status(400).json({ message: 'Message is required.' });
    await saveContactSubmission(name.trim(), email.toLowerCase(), website?.trim() || null, message.trim());
    return res.json({ success: true, message: 'Message received. We will reply within one business day.' });
  } catch (error) {
    console.error('Contact submission error:', error);
    return res.status(500).json({ message: 'Failed to send message. Please try again.' });
  }
});

app.post('/test-free-paid-boundary', async (req, res) => {
  try {
    const { scanId } = req.body;
    if (!scanId || Number.isNaN(Number(scanId))) {
      return res.status(400).json({ error: 'Missing scanId', message: 'Please provide a valid numeric scanId.' });
    }
    const scan = await getScanById(Number(scanId));
    if (!scan) return res.status(404).json({ error: 'Scan not found', message: 'No scan exists for that scanId.' });

    const report = await buildFreePaidBoundaryReport(scan);
    const freeViolations = report.violations.slice(0, 3);
    const hasFullDetails = item => Boolean(
      item.wcag?.id &&
      item.wcag?.name &&
      item.severity &&
      Number.isFinite(item.affectedElements) &&
      item.fix?.effort &&
      item.fix?.replaceThis &&
      item.fix?.withThis
    );
    const hasCodeFixes = item => Boolean(item.fix?.replaceThis && item.fix?.withThis);

    return res.json({
      freeVersion: {
        violationCount: freeViolations.length,
        hasFullDetails: freeViolations.every(hasFullDetails),
        hasCodeFixes: freeViolations.every(hasCodeFixes),
        hasPdf: false,
        hasMonitoring: false,
      },
      paidVersion: {
        violationCount: report.violations.length,
        hasFullDetails: report.violations.every(hasFullDetails),
        hasCodeFixes: report.violations.every(hasCodeFixes),
        hasPdf: true,
        hasMonitoring: true,
      },
    });
  } catch (error) {
    console.error('Boundary test error:', error);
    return res.status(500).json({ error: 'Boundary test failed', message: error.message });
  }
});

app.post('/paid-report/pdf', async (req, res) => {
  try {
    const { scanId, scanAccessKey } = req.body;
    if (!scanId || Number.isNaN(Number(scanId))) {
      return res.status(400).json({ error: 'Missing scanId', message: 'Please provide a valid numeric scanId.' });
    }
    const { scan, subscription } = await authorizePaidScan(req, scanId, scanAccessKey);
    const report = await buildPaidReport(scan, subscription);
    const pdfBuffer = await generatePaidReportPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ada-paid-report-${scanId}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Paid report PDF error:', error);
    return res.status(error.statusCode || 500).json({ error: 'Unable to generate paid report PDF', message: error.message });
  }
});

app.post('/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ message: 'Payments not configured.' });
  const { plan, email } = req.body;
  const priceId = STRIPE_PLANS[plan];
  if (!priceId) return res.status(400).json({ message: 'Invalid plan.' });
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontendUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/pricing`,
      metadata: { plan },
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[STRIPE] Checkout error:', err.message);
    return res.status(500).json({ message: err.message });
  }
});

app.post('/billing-portal', async (req, res) => {
  if (!stripe) return res.status(503).json({ message: 'Payments not configured.' });
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ message: 'customerId required.' });
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${frontendUrl}/billing`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[STRIPE] Billing portal error:', err.message);
    return res.status(500).json({ message: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`✓ Ada Scanner API running at http://localhost:${PORT}`);
  console.log(`✓ Supabase connected and ready`);
  console.log(`\nTest the /scan endpoint:`);
  console.log(`POST http://localhost:${PORT}/scan`);
  console.log(`Body: { "url": "https://example.com" }`);
  console.log(`POST http://localhost:${PORT}/scan`);
  console.log(`Body: { "url": "https://example.com", "email": "user@example.com" }`);
});
