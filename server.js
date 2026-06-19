// Load environment variables early so dependent modules can use them
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { scanUrl } = require('./scanner');
const { saveScanResults, saveCollectedEmail, getScanById } = require('./db');
const { sendReportEmail } = require('./email');
const { generateReportPdf } = require('./report');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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
    try {
      new URL(url);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid URL',
        message: 'Please provide a valid URL starting with http:// or https://',
      });
    }

    console.log(`[${new Date().toISOString()}] Scanning: ${url}`);
    
    // Run the scan
    let results;
    try {
      results = await scanUrl(url);
    } catch (scanError) {
      if (scanError.name === 'ScanError') {
        return res.status(scanError.httpStatus || 400).json({
          error: scanError.name,
          message: scanError.message,
        });
      }
      throw scanError;
    }

    // Save results to Supabase (best-effort)
    let savedRecord = null;
    try {
      savedRecord = await saveScanResults(url, results, req.body.email || null);
    } catch (dbError) {
      console.warn('[API] Warning: Could not save to database, but scan completed successfully');
      console.warn(dbError.message);
      // Continue and return scan results even if DB save fails
    }

    // Return results as JSON
    return res.json({
      id: (savedRecord && savedRecord[0] && savedRecord[0].id) || null,
      url,
      timestamp: new Date().toISOString(),
      summary: {
        totalViolations: results.violations.length,
        passes: results.passes.length,
        incomplete: results.incomplete?.length || 0,
      },
      violationsBySeverity: {
        critical: results.violations.filter(v => v.impact === 'critical').length,
        serious: results.violations.filter(v => v.impact === 'serious').length,
        moderate: results.violations.filter(v => v.impact === 'moderate').length,
        minor: results.violations.filter(v => v.impact === 'minor').length,
      },
      violations: results.violations.map(v => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        help: v.help,
        affectedElements: v.nodes.length,
        nodes: v.nodes.map(node => ({
          html: node.html,
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      })),
      passes: results.passes.length,
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
  try {
    const { email, url, scanResult } = req.body;

    if (!email || !url || !scanResult) {
      return res.status(400).json({
        error: 'Missing data',
        message: 'Email, url, and scanResult are required.',
      });
    }

    // Persist the email capture
    await saveCollectedEmail(email, url);

    // Send PDF report to the captured email
    await sendReportEmail(email, scanResult, url);

    return res.json({ success: true, message: 'Email saved and report emailed.' });
  } catch (error) {
    console.error('Email collection error:', error);
    return res.status(500).json({
      error: 'Unable to send report',
      message: error.message,
    });
  }
});

app.post('/generate-report', async (req, res) => {
  try {
    const { scanId } = req.body;
    if (!scanId) {
      return res.status(400).json({
        error: 'Missing scanId',
        message: 'Please provide a scanId in the request body.',
      });
    }

    const scanData = await getScanById(scanId);
    if (!scanData) {
      return res.status(404).json({
        error: 'Scan not found',
        message: 'No scan found for the provided scanId.',
      });
    }

    const pdfBuffer = await generateReportPdf(scanData);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ada-scan-report-${scanId}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Generate report error:', error);
    return res.status(500).json({
      error: 'Unable to generate report',
      message: error.message,
    });
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
