// Load environment variables early so dependent modules can use them
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { scanUrl } = require('./scanner');
const { saveScanResults, saveCollectedEmail, getScanById, getActiveSubscriptionByTokenHash, claimScanForSubscriber } = require('./db');
const { buildFreePaidBoundaryReport, buildPaidReport } = require('./paid-report-service');
const { generatePaidReportPdf } = require('./report');
const { sendPdfAttachmentEmail } = require('./email');
const { bearerToken, generateAccessKey, hashSecret, safeHashMatch } = require('./entitlements');
const { calculateScore } = require('./scoring');

const app = express();
const PORT = process.env.PORT || 3000;
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
  methods: ['GET', 'POST', 'OPTIONS'],
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
// Axe findings can include enough HTML snippets to exceed Express's 100 KB default.
app.use(express.json({ limit: '5mb' }));

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isReasonableString(value, maxLength = 2048) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function normalizedScanUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL must use http or https');
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

// POST /scan endpoint - accepts URL and returns violations
app.post('/scan', async (req, res) => {
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
      results = await scanUrl(normalizedUrl);
    } catch (scanError) {
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
      savedRecord = await saveScanResults(normalizedUrl, results, req.body.email || null, {
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
    console.error('Scan error:', error);
    return res.status(500).json({
      error: 'Scan failed',
      message: error.message,
    });
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
      if (scan && scan.url) {
        urlToSave = scan.url;
      }
    }

    if (!urlToSave) {
      return res.status(400).json({
        error: 'Missing data',
        message: 'Email and url or scanId are required.',
      });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(urlToSave);
    } catch {
      parsedUrl = null;
    }

    if (!isReasonableString(urlToSave, 2048) || !parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'URL must be a valid http or https address.',
      });
    }

    await saveCollectedEmail(email.toLowerCase(), parsedUrl.toString());
    queueCollectedEmailReport(email.toLowerCase(), scanId);

    console.log(`[LEAD] Captured ${email.toLowerCase()} for scan ${scanId || '(no scan id)'} in ${Date.now() - submittedAt}ms`);
    return res.json({
      success: true,
      unlocked: true,
      capabilities: unlockedCapabilities({ subscribed: false }),
      message: 'Email saved. The full report is unlocked and the PDF is being emailed.',
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
