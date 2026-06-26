const { scanUrl } = require('./scanner');

(async () => {
  const url = process.argv[2] || 'https://www.bbc.com';
  try {
    const result = await scanUrl(url);
    console.log('RESULT', result && result.violations && result.violations.length);
    process.exit(0);
  } catch (err) {
    console.error('ERROR', err && (err.stack || err.message || err));
    process.exit(1);
  }
})();
