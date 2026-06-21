const PLACEHOLDER_PATTERNS = [
  'describe this',
  'click here',
  '...',
  '…',
  'fix any of the following',
  'corrected accessible version',
  'manual review',
  'TODO',
  'replace this',
  'with this',
  'corrected code',
  'fixed version',
];

const GENERIC_ARIA_VALUES = new Set(['close', 'open', 'menu', 'button', 'link']);

function normalizeCode(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isIdenticalFix(originalCode, fixedCode) {
  return normalizeCode(originalCode) === normalizeCode(fixedCode);
}

function violationRuleId(violation = {}) {
  return String(violation.ruleId || violation.id || '').toLowerCase();
}

function violationDescription(violation = {}) {
  return String(violation.description || violation.help || '').toLowerCase();
}

function extractAriaReferences(fixedCode) {
  const text = String(fixedCode || '');
  const values = [];
  const ariaPattern = /\s(aria-label|aria-labelledby)=["']([^"']*)["']/gi;
  let match;
  while ((match = ariaPattern.exec(text))) {
    values.push({ attribute: match[1].toLowerCase(), value: match[2].trim() });
  }
  return values;
}

function wcagUnderstandingLink(ruleId) {
  const slug = String(ruleId || 'accessibility')
    .toLowerCase()
    .replace(/^wcag\d+-?/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'accessibility';
  return `https://www.w3.org/WAI/WCAG21/Understanding/${slug}`;
}

function manualReviewFix(violation = {}) {
  const ruleId = violation.ruleId || violation.id || 'accessibility';
  const guidelineUrl = wcagUnderstandingLink(ruleId);
  return {
    replaceThis: String(violation.htmlSnippet || violation.nodes?.[0]?.html || '').slice(0, 500) || 'Failing runtime DOM snippet unavailable.',
    withThis: 'MANUAL_REVIEW_REQUIRED',
    explanation: `This violation requires manual review. See WCAG guideline: ${guidelineUrl}`,
    effort: 'Complex',
    estimatedMinutes: 60,
    aiGenerated: false,
    manualReviewRequired: true,
    guidelineUrl,
  };
}

function validateFix(originalCode, fixedCode, violation = {}) {
  const failures = [];
  const original = String(originalCode || '');
  const fixed = String(fixedCode || '');
  const ruleId = violationRuleId(violation);
  const description = violationDescription(violation);

  if (isIdenticalFix(original, fixed)) {
    failures.push({
      errorType: 'ERROR_IDENTICAL',
      description: 'The corrected code is identical to the original failing code.',
    });
  }

  const fixedLower = fixed.toLowerCase();
  const placeholder = PLACEHOLDER_PATTERNS.find(pattern => fixedLower.includes(pattern.toLowerCase()));
  if (placeholder) {
    failures.push({
      errorType: 'ERROR_PLACEHOLDER',
      description: `The corrected code contains placeholder or meta text: ${placeholder}`,
    });
  }

  if (/(landmark|region|heading|main|banner)/i.test(ruleId)) {
    if (!fixed.includes('<') || !fixed.includes('>')) {
      failures.push({
        errorType: 'ERROR_INCOMPLETE',
        description: 'Structural accessibility fixes must include complete HTML tags.',
      });
    }
  }

  for (const reference of extractAriaReferences(fixed)) {
    if (reference.attribute === 'aria-label') {
      const normalized = reference.value.trim().toLowerCase();
      if (reference.value.length < 3 || GENERIC_ARIA_VALUES.has(normalized)) {
        failures.push({
          errorType: 'ERROR_GENERIC_ARIA',
          description: `ARIA label is too generic: ${reference.value}`,
        });
      }
    }
  }

  if (/contrast/i.test(description)) {
    if (!/#|rgb\s*\(|hsl\s*\(|color\s*:/i.test(fixed)) {
      failures.push({
        errorType: 'ERROR_MISSING_COLOR',
        description: 'Contrast fixes must include actual CSS color values.',
      });
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

module.exports = {
  PLACEHOLDER_PATTERNS,
  extractAriaReferences,
  isIdenticalFix,
  manualReviewFix,
  validateFix,
  wcagUnderstandingLink,
};
