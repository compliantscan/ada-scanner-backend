require('dotenv').config();
const { saveScanResults } = require('./db');

const testUrl = 'https://example.com';
const fakeResults = {
  violations: [
    { id: 'test-violation', impact: 'minor', description: 'test', nodes: [] }
  ],
  passes: [],
  incomplete: []
};

(async () => {
  try {
    const res = await saveScanResults(testUrl, fakeResults, 'test@example.com');
    console.log('Insert result:', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('Insert failed:', err);
    process.exit(1);
  }
})();
