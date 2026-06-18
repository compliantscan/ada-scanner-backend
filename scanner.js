const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');

async function scanUrl(url) {
  let browser;
  try {
    console.log(`Starting scan of: ${url}`);
    
    // Launch headless Chromium
    browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Navigate to URL
    console.log('Loading page...');
    await page.goto(url, { waitUntil: 'networkidle' });
    
    // Run axe-core scan
    console.log('Running accessibility scan...');
    const results = await new AxeBuilder({ page }).analyze();
    
    // Print results
    console.log('\n========== SCAN RESULTS ==========\n');
    console.log(`URL: ${url}`);
    console.log(`Total Violations: ${results.violations.length}`);
    console.log(`Passes: ${results.passes.length}`);
    
    // Group by severity
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
    throw error;
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
