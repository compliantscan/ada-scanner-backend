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
  if (msg.includes('Navigation timeout') || msg.includes('Timeout') || msg.includes('timeout')) {
    return new ScanError('timed out while loading the site', 504);
  }
  return new ScanError('unable to load the site', 400);
}

async function scanUrl(url) {
  let browser;
  try {
    console.log(`Starting scan of: ${url}`);
    
    browser = await chromium.launch({ 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: true
    });
    
    const context = await browser.newContext({ 
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      bypassCSP: true,
      ignoreHTTPSErrors: true
    });
    
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(90000);
    
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
    
    await page.waitForTimeout(2000);
    
    console.log('Running accessibility scan...');
    const results = await new AxeBuilder({ page }).analyze();
    
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
    
    await context.close();
    return results;
  } catch (error) {
    console.error('Error during scan:', error.message);
    if (error.name === 'ScanError') {
      throw error;
    }
    throw classifyPlaywrightError(error);
  } finally {
    if (browser) {
      await browser.close();
    }
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
