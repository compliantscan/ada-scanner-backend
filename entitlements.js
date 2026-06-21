const crypto = require('crypto');

const PLAN_CAPABILITIES = {
  starter: { paidReport: true, pdf: true, badge: false, whiteLabel: false },
  pro: { paidReport: true, pdf: true, badge: true, whiteLabel: false },
  business: { paidReport: true, pdf: true, badge: true, whiteLabel: true },
};

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateAccessKey() {
  return crypto.randomBytes(24).toString('base64url');
}

function safeHashMatch(value, expectedHash) {
  if (!value || !expectedHash) return false;
  const actual = Buffer.from(hashSecret(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function planCapabilities(plan) {
  return PLAN_CAPABILITIES[plan] || null;
}

module.exports = { bearerToken, generateAccessKey, hashSecret, planCapabilities, safeHashMatch };
