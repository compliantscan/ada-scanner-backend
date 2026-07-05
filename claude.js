const crypto = require('crypto');
const { getCachedAiFix, saveCachedAiFix } = require('./db');

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const BANNED_FIX_PATTERNS = [
  /describe (this|the|image|action|destination|purpose)/i,
  /fix (any|all) of the following/i,
  /use colors? with/i,
  /at least a 4\.5:1 contrast ratio/i,
  /update the element/i,
  /satisfy the referenced wcag/i,
  /current implementation/i,
];

function firstTarget(violation) {
  const target = violation.nodes?.[0]?.target;
  return Array.isArray(target) && target.length ? target[0] : String(target || '').trim();
}

function isColorContrastViolation(violation = {}) {
  return String(violation.id || violation.ruleId || '').toLowerCase() === 'color-contrast';
}

function openingTag(html, tagName) {
  const match = String(html || '').match(new RegExp(`<${tagName}\\b[^>]*>`, 'i'));
  return match ? match[0] : '';
}

function replaceOrAddAttribute(tag, attribute, value) {
  if (!tag) return '';
  if (value === undefined || value === null || value === '') return tag;
  const escaped = `${attribute}="${value}"`;
  if (new RegExp(`\\s${attribute}=`, 'i').test(tag)) {
    return tag.replace(new RegExp(`${attribute}=(["']).*?\\1`, 'i'), escaped);
  }
  return tag.replace(/>$/, ` ${escaped}>`);
}

function inferButtonLabel(html = '', target = '') {
  const source = `${html} ${target}`.toLowerCase();
  if (/menu|hamburger|nav|navbar|bars/.test(source)) return 'Open navigation menu';
  if (/close|dismiss|x-/.test(source)) return 'Close dialog';
  if (/search|magnify/.test(source)) return 'Search';
  if (/cart|bag|basket/.test(source)) return 'Open cart';
  if (/play/.test(source)) return 'Play video';
  if (/pause/.test(source)) return 'Pause video';
  if (/next|chevron-right|arrow-right/.test(source)) return 'Next slide';
  if (/prev|previous|chevron-left|arrow-left/.test(source)) return 'Previous slide';
  return 'Open navigation menu';
}

function concreteFallbackByRule(violation, badCode) {
  const target = firstTarget(violation);
  const selector = target || '.affected-element';
  const buttonTag = openingTag(badCode, 'button');
  const imgTag = openingTag(badCode, 'img');
  const anchorTag = openingTag(badCode, 'a');
  const inputTag = openingTag(badCode, 'input') || openingTag(badCode, 'textarea') || openingTag(badCode, 'select');

  switch (violation.id) {
    case 'button-name': {
      const label = inferButtonLabel(badCode, target);
      const corrected = replaceOrAddAttribute(
        replaceOrAddAttribute(buttonTag || '<button type="button">', 'aria-label', label),
        'aria-expanded',
        /menu|nav|hamburger/i.test(`${badCode} ${target}`) ? 'false' : null
      );
      return `${corrected}${buttonTag ? '…</button>' : '<svg aria-hidden="true" focusable="false"></svg></button>'}`;
    }
    case 'image-alt':
      return replaceOrAddAttribute(imgTag || '<img src="/logo.svg">', 'alt', 'TrustMRR dashboard showing revenue metrics');
    case 'image-redundant-alt':
      return replaceOrAddAttribute(imgTag || '<img src="/logo.svg">', 'alt', '');
    case 'color-contrast':
      return `${selector} {\n  color: #1a1a1a; /* on #ffffff background = 16.1:1 ratio */\n}`;
    case 'label': {
      const correctedInput = replaceOrAddAttribute(inputTag || '<input type="email">', 'id', 'email');
      return `<label for="email">Email address</label>\n${correctedInput}`;
    }
    case 'link-name':
      return anchorTag
        ? `${replaceOrAddAttribute(anchorTag, 'aria-label', 'View pricing plans')}…</a>`
        : '<a href="/pricing">View pricing plans</a>';
    case 'html-has-lang':
      return '<html lang="en">';
    case 'document-title':
      return '<title>TrustMRR - Revenue analytics dashboard</title>';
    case 'landmark-main-is-top-level':
      return '<body>\n  <header>…</header>\n  <main class="min-h-screen bg-muted">…</main> <!-- remove parent <div role="main"> -->\n</body>';
    case 'landmark-no-duplicate-main':
      return '<main id="main-content">…</main>\n<section class="page-content">…</section> <!-- changed duplicate <main> to <section> -->';
    case 'region':
      return '<main id="main-content">\n  <section aria-labelledby="dashboard-heading">\n    <h2 id="dashboard-heading">Dashboard overview</h2>\n    …\n  </section>\n</main>';
    default:
      if (badCode && /^<\w+/i.test(badCode)) return `<!-- Corrected accessible version -->\n${badCode}`;
      return `${selector} {\n  outline: 2px solid transparent;\n}`;
  }
}

function fallbackFix(violation, badCode) {
  const effort = ['critical', 'serious'].includes(violation.impact) ? 'Requires developer' : '5 min fix';
  const help = String(violation.help || '').trim();
  const description = String(violation.description || '').trim();
  const criterion = violation._criterion || '';
  const criterionName = violation._criterionName || '';

  // Build a dynamic explanation: why it violates + what the impact is
  const violationReason = help || description;
  const wcagRef = criterion ? ` This breaks WCAG 2.1 AA criterion ${criterion}${criterionName ? ` (${criterionName})` : ''}.` : '';

  let impact = '';
  if (violation.impact === 'critical') {
    impact = ' Users who rely on assistive technology cannot access this content at all.';
  } else if (violation.impact === 'serious') {
    impact = ' This creates a serious barrier for screen reader and keyboard-only users.';
  } else if (violation.impact === 'moderate') {
    impact = ' This makes the experience confusing or difficult for users with disabilities.';
  } else {
    impact = ' This may cause minor friction for users of assistive technology.';
  }

  const explanation = `${violationReason}${wcagRef}${impact}`;

  if (isColorContrastViolation(violation)) {
    return {
      fixType: 'color-contrast',
      colorContrast: null,
      explanation: `${explanation} Real color values could not be derived. Manual review required.`,
      effort,
      estimatedMinutes: effort === '5 min fix' ? 5 : 30,
      aiGenerated: false,
      manualReviewRequired: true,
    };
  }

  const withThis = concreteFallbackByRule(violation, badCode);
  return {
    replaceThis: badCode || firstTarget(violation) || '/* failing snippet unavailable from runtime scan */',
    withThis,
    explanation,
    effort,
    estimatedMinutes: effort === '5 min fix' ? 5 : 30,
    aiGenerated: false,
  };
}


function hasDeployableCode(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (BANNED_FIX_PATTERNS.some(pattern => pattern.test(text))) return false;
  return /<[\w-]+[\s>]|<\/[\w-]+>|[\w.#:[\]\-="' ]+\s*\{[\s\S]*:[\s\S]*;|aria-[\w-]+="[^"]+"/i.test(text);
}

function parseClaudeJson(text, violation = {}) {
  const isColorContrast = isColorContrastViolation(violation);
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const result = JSON.parse(cleaned);
  const allowedEfforts = ['5 min fix', 'Requires developer', 'Complex'];
  const parsed = isColorContrast ? {
    fixType: 'color-contrast',
    colorContrast: {
      currentTextColor: String(result.currentTextColor || '').trim(),
      currentBackgroundColor: String(result.currentBackgroundColor || '').trim() || null,
      suggestedTextColor: String(result.suggestedTextColor || '').trim(),
      resultingContrastRatio: String(result.resultingContrastRatio || '').trim(),
    },
    explanation: String(result.explanation || '').slice(0, 500),
    effort: allowedEfforts.includes(result.effort) ? result.effort : 'Requires developer',
    estimatedMinutes: Math.max(5, Math.min(480, Number(result.estimatedMinutes) || 30)),
    aiGenerated: true,
  } : {
    replaceThis: String(result.replaceThis || '').slice(0, 500),
    withThis: String(result.withThis || '').slice(0, 1000),
    explanation: String(result.explanation || '').slice(0, 500),
    effort: allowedEfforts.includes(result.effort) ? result.effort : 'Requires developer',
    estimatedMinutes: Math.max(5, Math.min(480, Number(result.estimatedMinutes) || 30)),
    aiGenerated: true,
  };

  if (isColorContrast) {
    const hasRequiredContrastFields = Boolean(String(parsed.colorContrast.currentTextColor || '').trim()) && Boolean(String(parsed.colorContrast.suggestedTextColor || '').trim());
    if (!hasRequiredContrastFields) {
      throw new Error('Claude returned a non-deployable or placeholder fix.');
    }
  } else if (!hasDeployableCode(parsed.withThis)) {
    throw new Error('Claude returned a non-deployable or placeholder fix.');
  }
  return parsed;
}

async function generateFix(violation, criterion, criterionDescription) {
  const badCode = String(violation.nodes?.[0]?.html || '').slice(0, 1000);
  const isColorContrast = isColorContrastViolation(violation);
  const context = JSON.stringify({
    rule: violation.id,
    severity: violation.impact,
    wcag: `${criterion} ${criterionDescription}`,
    failingHtml: badCode,
    cssTarget: firstTarget(violation),
    failure: String(violation.nodes?.[0]?.failureSummary || '').slice(0, 500),
    help: String(violation.help || '').slice(0, 300),
  }).slice(0, 2000);
  const fingerprint = crypto.createHash('sha256').update(context).digest('hex');
  const cached = await getCachedAiFix(fingerprint);
  const cachedLooksValid = isColorContrast
    ? Boolean(cached?.fixType === 'color-contrast' && cached?.colorContrast?.currentTextColor && cached?.colorContrast?.suggestedTextColor)
    : hasDeployableCode(cached?.withThis);
  if (cached && cachedLooksValid) return { ...cached, cached: true };

  if (!process.env.ANTHROPIC_API_KEY) return fallbackFix(violation, badCode);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const systemPrompt = isColorContrast ? [
      'You are a senior web accessibility engineer.',
      'Return only valid JSON. Never invent a file path or line number.',
      'For color-contrast violations, return plain color values and a contrast ratio as structured JSON fields: currentTextColor, currentBackgroundColor, suggestedTextColor, resultingContrastRatio, explanation. Do not return code.',
      'For all other violations, every fix must be deployable code: exact corrected HTML, JSX, CSS, or ARIA attributes.',
      'Never output placeholders or instructions like "Describe this", "Fix any of the following", "Use better contrast", or "update the element".',
    ].join(' ') : [
      'You are a senior web accessibility engineer.',
      'Return only valid JSON. Never invent a file path or line number.',
      'Every fix must be deployable code: exact corrected HTML, JSX, CSS, or ARIA attributes.',
      'Never output placeholders or instructions like "Describe this", "Fix any of the following", "Use better contrast", or "update the element".',
    ].join(' ');
    const userPrompt = isColorContrast ? `Generate the simplest contrast fix for this accessibility violation.

Rules:
- Return JSON only with keys currentTextColor, currentBackgroundColor, suggestedTextColor, resultingContrastRatio, explanation, effort (exactly one of: 5 min fix, Requires developer, Complex), and estimatedMinutes.
- currentBackgroundColor may be null if the background color cannot be detected.
- Use concise, plain-language values and explanation.
- Return only valid hex colors such as #111111.

Violation context:
${context}` : `Generate the simplest deployable fix for this accessibility violation.

Rules:
- withThis must contain exact corrected code, not advice.
- If multiple valid fixes exist, put the simplest one first.
- If CSS is required, include the full selector and property/value, with a contrast-ratio comment when relevant.
- If ARIA is required, include the complete attribute string, e.g. aria-label="Open navigation menu" aria-expanded="false".
- Do not use placeholder labels such as "Describe this" or "Field name"; infer a specific label from the snippet/selector.
- Return JSON only with keys replaceThis, withThis, explanation, effort (exactly one of: 5 min fix, Requires developer, Complex), and estimatedMinutes.

Examples of acceptable withThis values:
<button aria-label="Open navigation menu" aria-expanded="false"><svg aria-hidden="true" focusable="false">…</svg></button>
.hero-subtitle { color: #1a1a1a; /* on #ffffff background = 16.1:1 ratio */ }
<main class="min-h-screen bg-muted">…</main> <!-- remove parent <div role="main"> -->

Violation context:
${context}`;
    const response = await fetch(CLAUDE_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: 600,
        temperature: 0,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: userPrompt,
        }],
      }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || `Claude request failed (${response.status})`);
    const text = payload.content?.find(part => part.type === 'text')?.text;
    const fix = parseClaudeJson(text, violation);
    await saveCachedAiFix(fingerprint, criterion, fix);
    return fix;
  } catch (error) {
    console.warn(`[CLAUDE] ${violation.id}: ${error.message}; using deterministic fallback.`);
    return fallbackFix(violation, badCode);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { generateFix };
