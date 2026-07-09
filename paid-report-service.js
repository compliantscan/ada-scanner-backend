const crypto = require('crypto');
const { generateFix } = require('./claude');
const { getScanHistory } = require('./db');
const { planCapabilities } = require('./entitlements');
const { calculateScore, riskLevel, scoreGrade } = require('./scoring');
const { criterionDescription, criterionId } = require('./wcag');

const SEVERITY_WEIGHT = { critical: 12, serious: 7, moderate: 3, minor: 1 };
const SEVERITY_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

function normalizeViolations(results = {}) {
  return (results.violations || []).map(violation => ({
    id: violation.id,
    impact: violation.impact || 'minor',
    tags: violation.tags || [],
    description: violation.description,
    help: violation.help,
    affectedElements: violation.nodes?.length || 0,
    nodes: violation.nodes || [],
  }));
}

function detectedSource(node = {}) {
  const location = node.sourceLocation || node.location;
  const filePath = node.filePath || node.filename || location?.filePath || location?.filename || null;
  const lineNumber = node.lineNumber || location?.line || location?.start?.line || null;
  return { filePath, lineNumber };
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function formatFixTime(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} developer hour${hours === 1 ? '' : 's'}`;
}

function safeBadgeUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin + parsed.pathname : '';
  } catch {
    return '';
  }
}

function riskReductionPerMinute(item) {
  const minutes = Math.max(1, Number(item.fix?.estimatedMinutes) || 30);
  return (SEVERITY_WEIGHT[item.severity] || 1) / minutes;
}

function sortByRemediationPriority(a, b) {
  const severityDelta = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
  if (severityDelta !== 0) return severityDelta;
  return riskReductionPerMinute(b) - riskReductionPerMinute(a);
}

function severityCounts(violations) {
  const counts = violations.reduce((acc, item) => {
    const severity = item.severity || item.impact || 'minor';
    if (Object.hasOwn(acc, severity)) acc[severity] += 1;
    return acc;
  }, { critical: 0, serious: 0, moderate: 0, minor: 0 });

  counts.totalAffectedElements = violations.reduce((sum, item) => {
    return sum + (Number.isFinite(item.affectedElements) ? item.affectedElements : 0);
  }, 0);

  return counts;
}

async function buildReport(scanRecord, options = {}) {
  const results = scanRecord.results_json || {};
  const violations = normalizeViolations(results);
  const score = calculateScore(violations);
  const capabilities = options.capabilities || planCapabilities(options.subscription?.plan || 'pro');
  const enriched = await mapWithConcurrency(violations, 3, async violation => {
    const criterion = criterionId(violation);
    const criterionName = criterionDescription(criterion);
    const firstNode = violation.nodes[0] || {};
    const source = detectedSource(firstNode);
    const fix = await generateFix({ ...violation, _criterion: criterion, _criterionName: criterionName }, criterion, criterionName);
    return {
      ruleId: violation.id,
      fixType: violation.id === 'color-contrast' ? 'color-contrast' : 'code',
      severity: violation.impact,
      title: violation.description || violation.help || violation.id,
      description: violation.help || violation.description,
      wcag: { id: criterion, name: criterionDescription(criterion), level: 'AA' },
      affectedElements: violation.affectedElements,
      elementHtml: String(firstNode.html || '').slice(0, 200),
      target: Array.isArray(firstNode.target) ? firstNode.target.join(' ') : String(firstNode.target || ''),
      filePath: source.filePath,
      lineNumber: source.lineNumber,
      sourceDetected: Boolean(source.filePath || source.lineNumber),
      fix,
    };
  }).then(items => items.sort(sortByRemediationPriority));

  const estimatedMinutes = enriched.reduce((sum, item) => sum + item.fix.estimatedMinutes, 0);
  const priorities = enriched
    .map(item => ({
      ruleId: item.ruleId,
      title: item.title,
      severity: item.severity,
      estimatedMinutes: item.fix.estimatedMinutes,
      riskReductionPerMinute: Number(riskReductionPerMinute(item).toFixed(2)),
      riskReductionPerHour: Math.round(riskReductionPerMinute(item) * 60),
    }))
    .sort((a, b) => {
      const severityDelta = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
      if (severityDelta !== 0) return severityDelta;
      return b.riskReductionPerMinute - a.riskReductionPerMinute;
    })
    .slice(0, 3)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  let history = [];
  if (options.includeHistory && (options.subscription?.user_id || scanRecord.user_id)) {
    try {
      history = await getScanHistory(scanRecord.url, options.subscription?.user_id || scanRecord.user_id, 20);
    } catch (error) {
      console.warn('[REPORT] Trend history unavailable:', error.message);
    }
  }
  const trendPoints = history.map(record => ({
    scanId: record.id,
    date: record.created_at,
    score: Number.isFinite(record.score) ? record.score : calculateScore(normalizeViolations(record.results_json)),
  }));
  if (!trendPoints.some(point => point.scanId === scanRecord.id)) {
    trendPoints.push({ scanId: scanRecord.id, date: scanRecord.created_at, score });
  }
  const previous = trendPoints.length > 1 ? trendPoints[trendPoints.length - 2].score : null;

  const badgeUrl = safeBadgeUrl(scanRecord.url);
  const reportId = `ADA-${String(scanRecord.id).padStart(6, '0')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  return {
    tier: options.tier || 'paid',
    plan: options.subscription?.plan || options.plan || 'email-unlocked',
    capabilities,
    reportId,
    scanId: scanRecord.id,
    url: scanRecord.url,
    generatedAt: new Date().toISOString(),
    executiveSummary: {
      score,
      grade: scoreGrade(score),
      riskLevel: riskLevel(violations, score),
      settlementRange: '$5,000–$25,000',
      estimatedFixTime: formatFixTime(estimatedMinutes),
      totalViolations: violations.length,
      severityCounts: severityCounts(enriched),
    },
    violations: enriched,
    priorityChecklist: priorities,
    pages: [{
      url: scanRecord.url,
      violations: violations.length,
      density: violations.length,
      affectedElements: violations.reduce((sum, v) => sum + (v.affectedElements || 0), 0),
      scannedAt: scanRecord.created_at,
    }],
    trend: {
      points: trendPoints,
      previousScore: previous,
      currentScore: score,
      summary: previous === null ? 'No previous scan is available yet.' : `Score ${score >= previous ? 'improved' : 'changed'} from ${previous} to ${score}.`,
    },
    complianceBadgeHtml: capabilities.badge && badgeUrl
      ? `<a href="${badgeUrl}" aria-label="View accessibility status"><img src="${badgeUrl}/ada-compliance-badge.svg" alt="ADA accessibility monitoring enabled"></a>`
      : null,
    branding: capabilities.whiteLabel && options.subscription?.customer_logo_url
      ? { name: options.subscription.user_email, logoUrl: options.subscription.customer_logo_url, whiteLabel: true }
      : { name: 'ADA Scanner', logoUrl: null, whiteLabel: false },
  };
}

async function buildPaidReport(scanRecord, subscription) {
  return buildReport(scanRecord, {
    tier: 'paid',
    subscription,
    capabilities: planCapabilities(subscription.plan),
    includeHistory: true,
  });
}

async function buildFreePaidBoundaryReport(scanRecord) {
  return buildReport(scanRecord, {
    tier: 'free-paid-boundary',
    plan: 'email-unlocked',
    capabilities: { pdfDownload: true, sharing: true, fixes: true, badge: true, monitoring: true },
    includeHistory: false,
  });
}

module.exports = {
  buildFreePaidBoundaryReport,
  buildPaidReport,
  detectedSource,
  normalizeViolations,
  riskReductionPerMinute,
  sortByRemediationPriority,
};
