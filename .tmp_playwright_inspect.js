const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  console.log('browser keys:', Object.keys(browser));
  console.log('browser.process property:', browser.process);
  console.log('browser.process typeof:', typeof browser.process);
  if (typeof browser.process === 'function') {
    try {
      console.log('browser.process() result:', browser.process());
    } catch (err) {
      console.error('browser.process() error:', err);
    }
  }
  await browser.close();
})();
