const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');

class ScanError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ScanError';
    this.httpStatus = status;
  }
}

function classifyPlaywrightError(error) {
  const msg = error.message || '';
  if (msg.includes('ERR_NAME_NOT_RESOLVED') || msg.includes('ERR_NAME_RESOLUTION_FAILED')) {
    return new ScanError('site unreachable', 400);
  }
  if (msg.includes('ERR_CONNECTION_REFUSED') || msg.includes('ERR_CONNECTION_RESET')) {
    return new ScanError('site unreachable', 400);
  }
  if (msg.includes('ERR_CERT') || msg.includes('SSL')) {
    return new ScanError('invalid URL or SSL issue', 400);
  }
  if (msg.includes('ERR_NETWORK_CHANGED') || msg.includes('ERR_INTERNET_DISCONNECTED')) {
    return new ScanError('network connection interrupted - please retry', 503);
  }
  if (msg.includes('Navigation timeout') || msg.includes('Timeout') || msg.includes('timeout') || msg.includes('closed')) {
    return new ScanError('timed out while loading the site', 504);
  }
  if (msg.includes('Page crashed') || msg.includes('Renderer process crashed') || msg.includes('closed')) {
    return new ScanError('browser crashed during scan', 500);
  }
  return new ScanError('unable to load the site', 400);
}

async function scanUrl(url) {
  let browser = null;
  let context = null;
  let page = null;
  try {
    console.log(`Starting scan of: ${url}`);

    const mem = process.memoryUsage();
    console.log('[SCAN] Memory usage before launch:', { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed });
    if (mem.rss && mem.rss < 700 * 1024 * 1024) {
      console.warn('[SCAN] Warning: available RSS memory is low for Chromium — Railway may need more memory.');
    }

    console.log('[SCAN] Launching Chromium...');
    browser = await chromium.launch({ 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: true
    });
    console.log('[SCAN] Chromium launched');

    context = await browser.newContext({ 
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      bypassCSP: true,
      ignoreHTTPSErrors: true
    });
    console.log('[SCAN] Browser context created');

    page = await context.newPage();
    page.setDefaultNavigationTimeout(90000);
    console.log('[SCAN] Page created');

    // Attach crash listeners to detect page termination
    let pageCrashed = false;
    page.on('close', () => {
      console.warn('[SCAN] Page closed unexpectedly during scan');
      pageCrashed = true;
    });
    page.on('error', (err) => {
      console.warn('[SCAN] Page error event:', err && err.message);
      pageCrashed = true;
    });

    console.log('Loading page...');
    let navSuccess = false;
    const strategies = [
      { waitUntil: 'domcontentloaded', timeout: 45000 },
      { waitUntil: 'load', timeout: 60000 },
      { waitUntil: 'networkidle', timeout: 90000 }
    ];
    
    for (const strategy of strategies) {
      try {
        await page.goto(url, strategy);
        navSuccess = true;
        console.log(`Loaded with ${strategy.waitUntil}`);
        break;
      } catch (navErr) {
        console.warn(`${strategy.waitUntil} failed:`, navErr.message);
      }
    }
    
    if (!navSuccess) {
      throw new ScanError('unable to load the site after multiple attempts', 504);
    }

    try {
      await page.waitForTimeout(2000);
    } catch (tErr) {
      // page.waitForTimeout can throw if page crashes — surface it below
      console.warn('[SCAN] waitForTimeout failed:', tErr && tErr.message);
      throw tErr;
    }

    if (pageCrashed) {
      throw new ScanError('page crashed during page load', 500);
    }

    console.log('Running accessibility scan...');
    // Wrap Axe analysis in a timeout to prevent hanging on complex sites
    const axeTimeoutMs = 120000;
    const axeAnalysisPromise = new AxeBuilder({ page }).analyze();
    const axeTimeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Axe analysis timeout after ' + axeTimeoutMs + 'ms')), axeTimeoutMs)
    );
    
    let results;
    try {
      results = await Promise.race([axeAnalysisPromise, axeTimeoutPromise]);
    } catch (axeErr) {
      const errMsg = axeErr && (axeErr.message || String(axeErr));
      if (errMsg.includes('timeout')) {
        console.warn('[SCAN] Axe analysis timed out or page crashed:', errMsg);
        throw new ScanError('accessibility scan timed out', 504);
      }
      throw axeErr;
    }
    
    console.log('\n========== SCAN RESULTS ==========\n');
    console.log(`URL: ${url}`);
    console.log(`Total Violations: ${results.violations.length}`);
    console.log(`Passes: ${results.passes.length}`);
    
    const bySeverity = {};
    results.violations.forEach(v => {
      bySeverity[v.impact] = (bySeverity[v.impact] || 0) + 1;
    });
    
    console.log('\nViolations by Severity:');
    console.log(JSON.stringify(bySeverity, null, 2));
    
    console.log('\nTop Violations:');
    results.violations.slice(0, 5).forEach((violation, i) => {
      console.log(`\n${i + 1}. ${violation.id}`);
      console.log(`   Impact: ${violation.impact}`);
      console.log(`   Description: ${violation.description}`);
      console.log(`   Affected Elements: ${violation.nodes.length}`);
    });
    
    console.log('\n================================\n');
    
    console.log('[SCAN] Scan completed for:', url);
    return results;
  } catch (error) {
    // Log full stack for crashes and unexpected errors
    console.error('[SCAN] Error during scan:', error && (error.stack || error));
    // If this looks like a Chromium/page crash, ensure full stacktrace is logged
    const msg = (error && error.message) || '';
    if (msg.includes('Page crashed') || msg.includes('Renderer process crashed') || msg.includes('Page crashed')) {
      console.error('[SCAN] Chromium crash detected — full error object:', error);
    }
    if (error.name === 'ScanError') {
      throw error;
    }
    throw classifyPlaywrightError(error);
  } finally {
    // Close page, context, browser in a safe order without allowing close failures to mask the original error
    if (page) {
      try {
        await page.close();
        console.log('[SCAN] Page closed');
      } catch (closePageErr) {
        console.warn('[SCAN] Failed to close page:', closePageErr && closePageErr.message);
      }
    }
    if (context) {
      try {
        await context.close();
        console.log('[SCAN] Context closed');
      } catch (closeContextErr) {
        console.warn('[SCAN] Failed to close context:', closeContextErr && closeContextErr.message);
      }
    }
    if (browser) {
      try {
        await browser.close();
        console.log('[SCAN] Browser closed');
      } catch (closeBrowserErr) {
        console.error('[SCAN] Failed to close browser:', closeBrowserErr && closeBrowserErr.stack ? closeBrowserErr.stack : closeBrowserErr);
      }
    }
    const memAfter = process.memoryUsage();
    console.log('[SCAN] Memory usage after scan:', { rss: memAfter.rss, heapTotal: memAfter.heapTotal, heapUsed: memAfter.heapUsed });
  }
}

// Export the scanner function for use as a module
module.exports = { scanUrl };

// Allow running as standalone script
if (require.main === module) {
  const testUrl = process.argv[2] || 'https://example.com';
  scanUrl(testUrl)
    .then(() => {
      console.log('✓ Scan completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('✗ Scan failed:', error);
      process.exit(1);
    });
}
