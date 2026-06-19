const puppeteer = require('puppeteer');

async function getFixSuggestion(violation) {
  const apiKey = process.env.GEMINI_API_KEY;
  const endpoint = process.env.GEMINI_API_ENDPOINT || 'https://api.openai.com/v1/responses';
  const model = process.env.GEMINI_MODEL || 'gemini-1.5';

  if (!apiKey) {
    return 'AI fix suggestion unavailable because GEMINI_API_KEY is not configured.';
  }

  const brokenElement = violation.nodes && violation.nodes.length ? violation.nodes[0].target.join(', ') : 'Unknown element';
  const htmlSnippet = violation.nodes && violation.nodes.length ? violation.nodes[0].html : 'No HTML snippet available.';

  const prompt = `You are a web accessibility expert. Fix the broken HTML below and provide a one-sentence plain-English explanation.\n\nWCAG criterion: ${violation.id}\nBroken HTML element: ${brokenElement}\nBroken HTML snippet:\n${htmlSnippet}\n\nOutput format exactly as:\nCorrected HTML:\n<corrected html>\nFix explanation:\n<one-sentence explanation>`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: prompt,
        max_output_tokens: 300,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      const message = result.error?.message || JSON.stringify(result);
      return `AI fix suggestion unavailable: ${message}`;
    }

    let text = '';
    if (result.output) {
      const output = Array.isArray(result.output) ? result.output[0] : result.output;
      if (output?.content) {
        const content = Array.isArray(output.content) ? output.content : [output.content];
        const textPart = content.find((item) => item.type === 'output_text');
        text = textPart?.text || content[0]?.text || '';
      }
    }
    if (!text && result.choices?.[0]?.message?.content) {
      text = result.choices[0].message.content;
    }
    if (!text && result.choices?.[0]?.text) {
      text = result.choices[0].text;
    }

    return text.trim() || 'AI fix suggestion unavailable.';
  } catch (error) {
    return `AI fix suggestion unavailable: ${error.message}`;
  }
}

async function enrichViolationsWithFixes(violations) {
  return Promise.all(
    violations.map(async (violation) => {
      let fixSuggestion = 'AI fix suggestion unavailable.';
      try {
        fixSuggestion = await getFixSuggestion(violation);
      } catch (error) {
        fixSuggestion = `AI fix suggestion unavailable: ${error.message}`;
      }
      return { ...violation, fixSuggestion };
    })
  );
}

function renderReportHtml(scanRecord) {
  const scan = scanRecord.results_json || {};
  const url = scanRecord.url || 'Unknown URL';
  const totalViolations = Array.isArray(scan.violations) ? scan.violations.length : 0;
  const totalPasses = Array.isArray(scan.passes) ? scan.passes.length : 0;

  const severityCounts = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  };

  const violations = Array.isArray(scan.violations) ? scan.violations : [];
  violations.forEach((v) => {
    const impact = v.impact || 'unknown';
    if (severityCounts[impact] !== undefined) {
      severityCounts[impact] += 1;
    }
  });

  const severityRows = Object.entries(severityCounts)
    .map(([level, count]) => `
      <div class="severity-row">
        <span class="severity-label">${level.charAt(0).toUpperCase() + level.slice(1)}</span>
        <span class="severity-count">${count}</span>
      </div>
    `)
    .join('');

  const violationRows = violations.map((violation, index) => {
    const element = violation.nodes && violation.nodes.length ? violation.nodes[0].target.join(', ') : 'Unknown element';
    const failureSummary = violation.nodes && violation.nodes.length ? violation.nodes[0].failureSummary : '';
    const htmlSnippet = violation.nodes && violation.nodes.length ? violation.nodes[0].html : '';
    const fixSuggestion = violation.fixSuggestion || 'Fix suggestion unavailable.';

    return `
      <div class="violation-card">
        <div class="violation-header">
          <div>
            <span class="violation-rank">#${index + 1}</span>
            <span class="violation-id">${violation.id}</span>
          </div>
          <span class="violation-impact ${violation.impact}">${violation.impact || 'unknown'}</span>
        </div>
        <div class="violation-body">
          <p><strong>WCAG criterion:</strong> ${violation.id}</p>
          <p><strong>Description:</strong> ${violation.description || 'No description provided.'}</p>
          <p><strong>Why it matters:</strong> ${violation.help || 'No help text provided.'}</p>
          <p><strong>Element that failed:</strong> ${element}</p>
          <p><strong>Failure summary:</strong> ${failureSummary}</p>
          <div class="html-snippet"><strong>HTML snippet:</strong><pre>${escapeHtml(htmlSnippet)}</pre></div>
          <div class="fix-suggestion"><strong>How to fix this:</strong><p>${escapeHtml(fixSuggestion)}</p></div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>ADA Scan Report</title>
        <style>
          body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 24px; color: #111827; background: #f8fafc; }
          .report-shell { max-width: 900px; margin: 0 auto; background: #ffffff; padding: 32px; border-radius: 24px; box-shadow: 0 30px 80px rgba(15,23,42,0.08); }
          .logo { font-size: 1rem; letter-spacing: 0.18em; text-transform: uppercase; color: #2563eb; font-weight: 700; margin-bottom: 16px; }
          .hero { display: flex; flex-direction: column; gap: 6px; }
          .hero h1 { margin: 0; font-size: 2.3rem; line-height: 1.05; }
          .hero p { margin: 0; color: #475569; font-size: 1rem; }
          .meta { margin-top: 20px; display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
          .meta-card { padding: 18px; border-radius: 18px; background: #f1f5f9; }
          .meta-card strong { display: block; font-size: 0.86rem; margin-bottom: 8px; color: #0f172a; }
          .meta-card span { font-size: 1.8rem; font-weight: 700; color: #0f172a; }
          .section-title { margin: 40px 0 18px; font-size: 1.35rem; color: #0f172a; }
          .severity-summary { display: grid; gap: 10px; }
          .severity-row { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-radius: 16px; background: #eef2ff; }
          .severity-row span { font-weight: 700; }
          .violation-card { margin-bottom: 18px; padding: 20px; border-radius: 20px; border: 1px solid #e2e8f0; background: #ffffff; }
          .violation-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
          .violation-rank { display: inline-block; font-weight: 700; margin-right: 12px; color: #2563eb; }
          .violation-id { font-size: 1.05rem; font-weight: 700; color: #0f172a; }
          .violation-impact { text-transform: uppercase; font-size: 0.82rem; letter-spacing: 0.08em; padding: 8px 12px; border-radius: 999px; color: white; }
          .violation-impact.critical { background: #dc2626; }
          .violation-impact.serious { background: #f97316; }
          .violation-impact.moderate { background: #facc15; color: #0f172a; }
          .violation-impact.minor { background: #14b8a6; }
          .violation-body p { margin: 8px 0; line-height: 1.5; }
          .html-snippet pre { white-space: pre-wrap; word-wrap: break-word; background: #f8fafc; padding: 12px; border-radius: 14px; overflow-x: auto; font-size: 0.9rem; }
          .fix-suggestion { margin-top: 12px; padding: 14px; border-radius: 16px; background: #f8fafc; border: 1px solid #e2e8f0; }
          .fix-suggestion p { margin: 6px 0 0; }
        </style>
      </head>
      <body>
        <div class="report-shell">
          <div class="logo">ADA Scanner</div>
          <div class="hero">
            <h1>Accessibility scan report</h1>
            <p>${escapeHtml(url)}</p>
          </div>

          <div class="meta">
            <div class="meta-card"><strong>Scan ID</strong><span>${scanRecord.id}</span></div>
            <div class="meta-card"><strong>Total violations</strong><span>${totalViolations}</span></div>
            <div class="meta-card"><strong>Total passes</strong><span>${totalPasses}</span></div>
          </div>

          <div class="section-title">Severity summary</div>
          <div class="severity-summary">${severityRows}</div>

          <div class="section-title">Violations</div>
          ${violationRows}
        </div>
      </body>
    </html>
  `;
}

async function generateReportPdf(scanRecord) {
  const scan = scanRecord.results_json || {};
  if (Array.isArray(scan.violations) && scan.violations.length) {
    scan.violations = await enrichViolationsWithFixes(scan.violations);
  }
  const html = renderReportHtml({ ...scanRecord, results_json: scan });
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' },
  });
  await browser.close();
  return pdfBuffer;
}

function escapeHtml(value) {
  if (!value) return '';
  return value
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  generateReportPdf,
};
