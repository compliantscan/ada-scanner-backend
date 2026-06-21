const SEVERITY_WEIGHT = { critical: 12, serious: 7, moderate: 3, minor: 1 };
const SEVERITY_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

const GENERIC_TITLES = {
  'aria-allowed-attr': 'Unsupported accessibility information is present',
  'aria-hidden-body': 'Page content is hidden from screen readers',
  'aria-prohibited-attr': 'A control has conflicting accessibility information',
  'aria-required-attr': 'Required accessibility information is missing',
  'aria-valid-attr-value': 'Invalid accessibility information is present',
  'button-name': 'Button missing accessible label',
  'color-contrast': 'Text does not have sufficient color contrast',
  'document-title': 'Page is missing a descriptive title',
  'duplicate-id-aria': 'Duplicate identifiers may confuse screen readers',
  'heading-order': 'Heading structure is out of order',
  'html-has-lang': 'Page language is not identified',
  'image-alt': 'Image missing alternative text',
  'image-redundant-alt': 'Image alternative text repeats nearby content',
  label: 'Form field missing accessible label',
  'landmark-main-is-top-level': 'Main content landmark is nested incorrectly',
  'landmark-no-duplicate-main': 'Page contains multiple main content landmarks',
  'landmark-one-main': 'Page is missing a main content landmark',
  'link-name': 'Link missing accessible text',
  'meta-viewport': 'Page prevents users from zooming',
  region: 'Content is outside a navigable landmark',
  'select-name': 'Selection field missing accessible label',
};

function countAffectedElements(violation) {
  if (Number.isFinite(violation.affectedElements)) return violation.affectedElements;
  return Array.isArray(violation.nodes) ? violation.nodes.length : 0;
}

function calculateScore(violations = []) {
  const penalty = violations.reduce((total, violation) => {
    const weight = SEVERITY_WEIGHT[violation.impact] || 1;
    const affected = Math.min(countAffectedElements(violation), 10);
    return total + weight + (affected * weight * 0.2);
  }, 0);
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

function scoreGrade(score) {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function riskLevel(violations = [], score = calculateScore(violations)) {
  const counts = violations.reduce((result, violation) => {
    if (Object.hasOwn(result, violation.impact)) result[violation.impact] += 1;
    return result;
  }, { critical: 0, serious: 0, moderate: 0, minor: 0 });

  if (counts.critical > 0 || score < 40) return 'CRITICAL RISK';
  if (counts.serious > 0 || score < 65) return 'HIGH RISK';
  if (counts.moderate > 0 || score < 85) return 'MODERATE RISK';
  return 'LOW RISK';
}

function genericTitle(violation) {
  return GENERIC_TITLES[violation.id] || 'Accessibility barrier detected';
}

function selectFreePreview(violations = []) {
  const selected = [];
  const used = new Set();
  const take = (impact, limit) => {
    violations.forEach((violation, index) => {
      if (selected.length >= 3 || limit <= 0 || used.has(index) || violation.impact !== impact) return;
      selected.push({ title: genericTitle(violation), impact: violation.impact });
      used.add(index);
      limit -= 1;
    });
  };

  take('critical', 1);
  take('serious', 2);
  [...violations]
    .map((violation, index) => ({ violation, index }))
    .sort((a, b) => (SEVERITY_ORDER[a.violation.impact] ?? 4) - (SEVERITY_ORDER[b.violation.impact] ?? 4))
    .forEach(({ violation, index }) => {
      if (selected.length < 3 && !used.has(index)) {
        selected.push({ title: genericTitle(violation), impact: violation.impact || 'minor' });
        used.add(index);
      }
    });
  return selected;
}

function buildFreeReport({ id, url, timestamp, violations = [] }) {
  const score = calculateScore(violations);
  const previewViolations = selectFreePreview(violations);
  const createdAt = timestamp ? new Date(timestamp) : new Date();
  const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    tier: 'free',
    id,
    url,
    timestamp: createdAt.toISOString(),
    expiresAt,
    score,
    grade: scoreGrade(score),
    riskLevel: riskLevel(violations, score),
    totalViolations: violations.length,
    previewViolations,
    hiddenViolationCount: Math.max(0, violations.length - previewViolations.length),
    capabilities: { pdfDownload: false, sharing: false, fixes: false },
  };
}

module.exports = {
  buildFreeReport,
  calculateScore,
  genericTitle,
  riskLevel,
  scoreGrade,
  selectFreePreview,
};
