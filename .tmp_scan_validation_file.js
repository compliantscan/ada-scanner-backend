const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const logPath = path.resolve(__dirname, 'scan_validation_file.log');
const urls = [
  'https://example.com',
  'https://www.wikipedia.org',
  'https://www.mozilla.org',
  'https://www.github.com',
  'https://www.npmjs.com',
  'https://www.microsoft.com',
  'https://www.python.org',
  'https://www.nodejs.org',
  'https://www.stackoverflow.com',
  'https://www.reddit.com',
  'https://www.bbc.com',
  'https://www.cnn.com',
  'https://www.nytimes.com',
  'https://www.apple.com',
  'https://www.google.com',
  'https://www.linkedin.com',
  'https://www.amazon.com',
  'https://www.youtube.com',
  'https://www.twitter.com',
  'https://www.medium.com',
  'https://web.dev',
  'https://www.zdnet.com',
  'https://www.espn.com',
  'https://www.forbes.com',
  'https://www.bloomberg.com',
  'https://www.techcrunch.com',
  'https://news.ycombinator.com',
  'https://www.salesforce.com',
  'https://www.nasa.gov',
  'https://www.cnet.com',
];

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
}

function getMemory() {
  const m = process.memoryUsage();
  return {
    rss: Math.round(m.rss / 1024 / 1024),
    heapTotal: Math.round(m.heapTotal / 1024 / 1024),
    heapUsed: Math.round(m.heapUsed / 1024 / 1024),
    external: Math.round(m.external / 1024 / 1024),
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

(async () => {
  fs.writeFileSync(logPath, '');
  log('Starting validation');
  log(`Initial memory ${JSON.stringify(getMemory())}`);

  let success = 0;
  let failures = 0;

  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    log(`=== Scan ${i + 1}/${urls.length}: ${url} ===`);
    const beforeMem = getMemory();
    let browser = null;
    let context = null;
    let page = null;
    let browserPid = null;
    try {
      browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'], headless: true });
      browserPid = browser.process()?.pid || null;
      log(`Browser launched pid=${browserPid}`);
      context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36', bypassCSP: true, ignoreHTTPSErrors: true });
      log('Context created');
      page = await context.newPage();
      page.setDefaultNavigationTimeout(90000);
      log('Page created');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      log('Page navigated to domcontentloaded');
      await page.waitForTimeout(2000);
      log('Wait completed');
      const results = await new (require('@axe-core/playwright').AxeBuilder)({ page }).analyze();
      log(`Scan completed: violations=${results.violations.length}`);
      success += 1;
    } catch (err) {
      const stack = err && (err.stack || err.message || String(err));
      log(`Scan failed: ${stack}`);
      failures += 1;
    } finally {
      if (page) {
        try {
          await page.close();
          log('Page closed');
        } catch (err) {
          log(`Page close failed: ${err.message || err}`);
        }
      }
      if (context) {
        try {
          await context.close();
          log('Context closed');
        } catch (err) {
          log(`Context close failed: ${err.message || err}`);
        }
      }
      if (browser) {
        try {
          await browser.close();
          log('Browser closed');
        } catch (err) {
          log(`Browser close failed: ${err.message || err}`);
        }
      }
      if (browserPid) {
        const alive = isProcessAlive(browserPid);
        log(`Browser PID ${browserPid} alive after close: ${alive}`);
      }
      const afterMem = getMemory();
      log(`Memory before ${JSON.stringify(beforeMem)} after ${JSON.stringify(afterMem)}`);
    }
  }

  log(`Summary: success=${success} failures=${failures}`);
})();
