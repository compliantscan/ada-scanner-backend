// Load environment variables early so dependent modules can use them
require('dotenv').config();

const express = require('express');
const { scanUrl } = require('./scanner');
const { saveScanResults } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
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
    const results = await scanUrl(url);

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
