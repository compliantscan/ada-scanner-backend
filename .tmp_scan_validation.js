const { scanUrl } = require('./scanner');
const { execSync } = require('child_process');

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
  'https://www.hackernews.com',
  'https://www.salesforce.com',
  'https://www.nasa.gov',
  'https://www.cnet.com'
];

function getMemory() {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024),
  };
}

function getChromiumProcesses() {
  try {
    const output = execSync('tasklist /FO CSV /NH').toString('utf8');
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.replace(/^"|"$/g, '').split('","')[0])
      .filter(name => /chrome|msedge|chromium|playwright|pwsh/i.test(name));
  } catch (err) {
    return [`error reading tasklist: ${err.message}`];
  }
}

(async () => {
  console.log('Starting scan validation');
  console.log('Initial memory', getMemory());
  console.log('Initial Chromium-like processes', getChromiumProcesses());

  let success = 0;
  let failures = 0;
  const results = [];

  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    console.log(`\n=== Scan ${i + 1}/${urls.length}: ${url} ===`);
    const beforeMem = getMemory();
    try {
      const start = Date.now();
      const data = await scanUrl(url);
      const duration = Date.now() - start;
      console.log(`Scan succeeded in ${duration}ms: violations=${data.violations.length}`);
      success += 1;
      results.push({ url, status: 'success', duration, violations: data.violations.length });
    } catch (err) {
      const stack = err && (err.stack || err.message || err);
      console.error(`Scan failed for ${url}:`, stack);
      failures += 1;
      results.push({ url, status: 'failure', error: String(err), stack: stack ? stack.toString().slice(0, 1000) : '' });
    }
    const afterMem = getMemory();
    console.log('Memory before', beforeMem);
    console.log('Memory after', afterMem);
    if ((i + 1) % 5 === 0) {
      console.log(`After ${i + 1} scans memory`, afterMem);
    }
    const chromeProcs = getChromiumProcesses();
    console.log('Chromium-like processes after scan', chromeProcs.slice(0, 20));
  }

  console.log('\n=== Validation summary ===');
  console.log('Success', success, 'Failures', failures);
  console.log('Final memory', getMemory());
  console.log('Final Chromium-like processes', getChromiumProcesses().slice(0, 20));
  process.exit(failures > 0 ? 1 : 0);
})();
