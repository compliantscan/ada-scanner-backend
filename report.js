const puppeteer = require('puppeteer');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function severityColor(severity) {
  return { critical: '#dc2626', serious: '#d97706', moderate: '#ca8a04', minor: '#64748b' }[severity] || '#64748b';
}

function renderFixBlock(item) {
  // Priority 1: color-contrast with real data
  if (item.fixType === 'color-contrast' && item.fix?.colorContrast) {
    const contrast = item.fix.colorContrast || {};
    return `
      <div class="contrast-fix-grid">
        <div><strong>Current text color</strong><span>${escapeHtml(contrast.currentTextColor || '—')}</span></div>
        <div><strong>Current background color</strong><span>${escapeHtml(contrast.currentBackgroundColor || 'Not detectable')}</span></div>
        <div><strong>Suggested text color</strong><span>${escapeHtml(contrast.suggestedTextColor || '—')}</span></div>
        <div><strong>Resulting contrast ratio</strong><span>${escapeHtml(contrast.resultingContrastRatio || '—')}</span></div>
      </div>
    `;
  }

  // Priority 2: color-contrast manual review required
  if (item.fixType === 'color-contrast' && item.fix?.manualReviewRequired) {
    return `
      <p class="muted" style="padding: 14px; border-radius: 8px; background: #f3f4f6; border-left: 3px solid #9ca3af;">
        Manual review required — automatic color detection was not available for this violation.
      </p>
    `;
  }

  // Priority 3: other violation types (code fix)
  return `
    <div class="replace-grid">
      <div><strong>Replace this</strong>${(item.fix.replaceThis || item.elementHtml)
        ? `<pre>${escapeHtml(item.fix.replaceThis || item.elementHtml)}</pre>`
        : '<p class="muted">No element snippet available for this violation</p>'}</div>
      <div><strong>With this</strong><pre>${escapeHtml(item.fix.withThis)}</pre></div>
    </div>
  `;
}

function renderPaidReportHtml(report) {
  const brandName = escapeHtml(report.branding?.name || 'ADA Scanner');
  const logo = report.branding?.logoUrl
    ? `<img src="${escapeHtml(report.branding.logoUrl)}" alt="${brandName}" class="brand-logo-img">`
    : `<span class="brand-mark">A</span><span>${brandName}</span>`;
  const violations = report.violations.map(item => `
    <article class="violation-card">
      <header>
        <div>
          <p class="wcag">WCAG 2.1 AA ${escapeHtml(item.wcag.id)} · ${escapeHtml(item.wcag.name)}</p>
          <h3>${escapeHtml(item.title)}</h3>
        </div>
        <span class="severity" style="background:${severityColor(item.severity)}">${escapeHtml(item.severity)}</span>
      </header>
      <p>${escapeHtml(item.description)}</p>
      <div class="meta-grid">
        <div><strong>Affected elements</strong><span>${item.affectedElements}</span></div>
        <div><strong>Source</strong><span>${item.sourceDetected ? `${escapeHtml(item.filePath || 'Unknown file')}:${escapeHtml(item.lineNumber || '?')}` : item.target ? `Runtime DOM target: ${escapeHtml(item.target)}` : 'Runtime DOM - source line not detectable'}</span></div>
        <div><strong>Effort</strong><span>${escapeHtml(item.fix.effort)}</span></div>
      </div>
      <p class="code-label">Element HTML snippet</p>
      <pre>${escapeHtml(item.elementHtml || 'No HTML snippet captured.')}</pre>
      <div class="fix-box">
        <h4>${item.fix.aiGenerated ? 'AI-generated fix' : 'Suggested fix'}</h4>
        ${renderFixBlock(item)}
        <p>${escapeHtml(item.fix.explanation)}</p>
      </div>
    </article>
  `).join('');

  const priorities = report.priorityChecklist.map(item => `
    <li><strong>#${item.rank} ${escapeHtml(item.title)}</strong><span>${item.riskReductionPerHour} risk-reduction pts/hr · ${item.estimatedMinutes} min</span></li>
  `).join('');
  const pages = report.pages.map(page => `<tr><td>${escapeHtml(page.url)}</td><td>${page.violations}</td><td>${page.density}/page</td><td>${page.affectedElements || 0}</td></tr>`).join('');
  const badge = report.complianceBadgeHtml ? `<pre>${escapeHtml(report.complianceBadgeHtml)}</pre>` : '<p class="muted">Available with CompliantScan Monitoring — $199/mo.</p>';

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <title>${escapeHtml(report.reportId)}</title>
      <style>
        * { box-sizing: border-box; } body { margin: 0; font-family: Inter, Arial, sans-serif; color: #111827; background: #f8fafc; }
        .page { padding: 38px 42px; page-break-after: always; } .page:last-child { page-break-after: auto; }
        .cover { min-height: 970px; color: white; background: linear-gradient(135deg, #0b1220, #172554); }
        .brand { display: flex; gap: 10px; align-items: center; font-weight: 800; letter-spacing: .04em; }
        .brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; background: #2563eb; }
        .brand-logo-img { max-height: 34px; max-width: 180px; object-fit: contain; }
        .label { margin-top: 110px; color: #93c5fd; font-weight: 800; font-size: 12px; letter-spacing: .16em; text-transform: uppercase; }
        h1 { margin: 16px 0 0; font-size: 42px; line-height: 1.05; letter-spacing: -.04em; } h2 { margin: 0 0 18px; font-size: 28px; } h3 { margin: 4px 0 0; font-size: 18px; }
        .cover-url { margin-top: 18px; font-size: 22px; color: #dbeafe; word-break: break-word; }
        .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 80px; }
        .stat { padding: 20px; border-radius: 18px; background: rgba(255,255,255,.1); } .stat span { display:block; color:#cbd5e1; font-size: 11px; text-transform: uppercase; letter-spacing: .12em; } .stat strong { display:block; margin-top: 10px; font-size: 26px; }
        .summary-grid { display:grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin: 22px 0; } .summary-card { padding: 18px; border-radius: 16px; background: white; border: 1px solid #e2e8f0; } .summary-card span { color: #64748b; font-size: 11px; font-weight: 800; text-transform: uppercase; } .summary-card strong { display:block; margin-top: 8px; font-size: 22px; }
        .risk-alert-bar { display:flex; align-items:stretch; background:#fef2f2; border:1px solid #fecaca; border-radius:14px; padding:16px 24px; margin:22px 0; }
        .risk-alert-item { display:flex; flex-direction:column; gap:3px; flex:1; padding:0 20px; }
        .risk-alert-item:first-child { padding-left:0; }
        .risk-alert-label { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.6px; color:#b91c1c; }
        .risk-alert-value { font-size:16px; font-weight:700; color:#111827; margin-top:4px; }
        .risk-alert-divider { width:1px; background:#fecaca; flex-shrink:0; align-self:stretch; }
        .callout { padding: 20px; border-radius: 18px; background: #fef2f2; border: 1px solid #fecaca; } .muted { color: #64748b; }
        .checklist { padding-left: 20px; } .checklist li { margin: 0 0 12px; } .checklist span { display:block; color:#64748b; font-size: 13px; }
        .violation-card { margin: 0 0 22px; padding: 22px; background: white; border: 1px solid #dce3ea; border-radius: 18px; break-inside: avoid; } .violation-card header { display:flex; justify-content:space-between; gap:18px; }
        .severity { align-self: flex-start; padding: 7px 12px; border-radius: 999px; color: white; font-weight: 800; font-size: 11px; text-transform: uppercase; } .wcag { margin:0; color:#2563eb; font-size: 11px; font-weight:800; text-transform:uppercase; }
        .meta-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 16px 0; } .meta-grid div { padding: 12px; border-radius: 12px; background: #f8fafc; } .meta-grid strong { display:block; font-size: 11px; color:#64748b; text-transform:uppercase; } .meta-grid span { display:block; margin-top:6px; font-size:12px; }
        pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; padding: 12px; border-radius: 12px; background: #0f172a; color: #e2e8f0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
        .code-label { margin: 18px 0 0; color:#64748b; font-weight:800; font-size: 11px; text-transform: uppercase; }
        .fix-box { margin-top: 16px; padding: 16px; border-radius: 14px; background: #f0fdf4; border: 1px solid #bbf7d0; } .fix-box h4 { margin:0 0 10px; color:#15803d; } .fix-box pre { background: #ecfdf5; color: #14532d; border: 1px solid #bbf7d0; }
        .replace-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; } .contrast-fix-grid { display:grid; grid-template-columns: repeat(2, 1fr); gap: 10px; } .contrast-fix-grid div { padding: 12px; border-radius: 12px; background: #ecfdf5; border: 1px solid #bbf7d0; } .contrast-fix-grid strong { display:block; font-size: 11px; color:#64748b; text-transform:uppercase; } .contrast-fix-grid span { display:block; margin-top:6px; font-size:13px; color:#14532d; } table { width: 100%; border-collapse: collapse; background: white; border-radius: 16px; overflow: hidden; } th, td { padding: 13px; border-bottom: 1px solid #e2e8f0; text-align: left; font-size: 13px; } th { background: #eff6ff; color: #1d4ed8; }
      </style>
    </head>
    <body>
      <section class="page cover"><div class="brand">${logo}</div><p class="label">Paid ADA compliance report</p><h1>Consultant-grade accessibility audit</h1><p class="cover-url">${escapeHtml(report.url)}</p><div class="stat-grid"><div class="stat"><span>Score</span><strong>Score: ${report.executiveSummary.score}/100</strong><div class="muted" style="margin-top:8px">Grade: ${report.executiveSummary.grade}</div></div><div class="stat"><span>Risk</span><strong>${escapeHtml(report.executiveSummary.riskLevel)}</strong></div><div class="stat"><span>Report ID</span><strong style="font-size:17px">${escapeHtml(report.reportId)}</strong></div></div></section>
      <section class="page"><h2>Executive summary</h2><div class="risk-alert-bar"><div class="risk-alert-item"><span class="risk-alert-label">Settlement range</span><strong class="risk-alert-value">${escapeHtml(report.executiveSummary.settlementRange)}</strong></div><div class="risk-alert-divider"></div><div class="risk-alert-item"><span class="risk-alert-label">Estimated fix time</span><strong class="risk-alert-value">${escapeHtml(report.executiveSummary.estimatedFixTime)}</strong></div><div class="risk-alert-divider"></div><div class="risk-alert-item"><span class="risk-alert-label">Risk level</span><strong class="risk-alert-value">${escapeHtml(report.executiveSummary.riskLevel)}</strong></div><div class="risk-alert-divider"></div><div class="risk-alert-item"><span class="risk-alert-label">Score</span><strong class="risk-alert-value">${report.executiveSummary.score}/100</strong></div><div class="risk-alert-divider"></div><div class="risk-alert-item"><span class="risk-alert-label">Grade</span><strong class="risk-alert-value">${report.executiveSummary.grade}</strong></div></div><div class="summary-grid"><div class="summary-card"><span>Critical</span><strong>${report.executiveSummary.severityCounts?.critical || 0}</strong></div><div class="summary-card"><span>Serious</span><strong>${report.executiveSummary.severityCounts?.serious || 0}</strong></div><div class="summary-card"><span>Moderate</span><strong>${report.executiveSummary.severityCounts?.moderate || 0}</strong></div><div class="summary-card"><span>Minor</span><strong>${report.executiveSummary.severityCounts?.minor || 0}</strong></div></div><div class="callout">Start with the fixes below, ordered by risk-reduction impact.</div><h2 style="margin-top:32px">Priority checklist</h2><ol class="checklist">${priorities}</ol><h2 style="margin-top:32px">Trend</h2><p>${escapeHtml(report.trend.summary)}</p></section>
      <section class="page"><h2>Page-by-page breakdown</h2><table><thead><tr><th>Page scanned</th><th>Violations</th><th>Density</th><th>Affected elements</th></tr></thead><tbody>${pages}</tbody></table><h2 style="margin-top:32px">Compliance badge</h2>${badge}</section>
      <section class="page"><h2>Full violation list</h2>${violations}</section>
    </body>
  </html>`;
}

async function generatePaidReportPdf(report) {
  const html = renderPaidReportHtml(report);
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-family:Arial,sans-serif;font-size:8px;color:#64748b;width:100%;padding:0 38px;">${escapeHtml(report.branding?.name || 'ADA Scanner')} · ${escapeHtml(report.reportId)}</div>`,
      footerTemplate: '<div style="font-family:Arial,sans-serif;font-size:8px;color:#64748b;width:100%;padding:0 38px;text-align:right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      margin: { top: '18mm', right: '14mm', bottom: '18mm', left: '14mm' },
    });
  } finally {
    await browser.close();
  }
}

module.exports = { escapeHtml, generatePaidReportPdf, renderPaidReportHtml };
