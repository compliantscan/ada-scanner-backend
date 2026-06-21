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
        <div><strong>Source</strong><span>${item.sourceDetected ? `${escapeHtml(item.filePath || 'Unknown file')}:${escapeHtml(item.lineNumber || '?')}` : 'Runtime DOM — source line not detectable'}</span></div>
        <div><strong>Effort</strong><span>${escapeHtml(item.fix.effort)}</span></div>
      </div>
      <p class="code-label">Element HTML snippet</p>
      <pre>${escapeHtml(item.elementHtml || 'No HTML snippet captured.')}</pre>
      <div class="fix-box">
        <h4>${item.fix.aiGenerated ? 'AI-generated fix' : 'Suggested fix'}</h4>
        <div class="replace-grid">
          <div><strong>Replace this</strong><pre>${escapeHtml(item.fix.replaceThis || item.elementHtml || 'Current implementation')}</pre></div>
          <div><strong>With this</strong><pre>${escapeHtml(item.fix.withThis)}</pre></div>
        </div>
        <p>${escapeHtml(item.fix.explanation)}</p>
      </div>
    </article>
  `).join('');

  const priorities = report.priorityChecklist.map(item => `
    <li><strong>#${item.rank} ${escapeHtml(item.title)}</strong><span>${item.riskReductionPerHour} risk-reduction pts/hr · ${item.estimatedMinutes} min</span></li>
  `).join('');
  const pages = report.pages.map(page => `<tr><td>${escapeHtml(page.url)}</td><td>${page.violations}</td><td>${page.density}/page</td></tr>`).join('');
  const badge = report.complianceBadgeHtml ? `<pre>${escapeHtml(report.complianceBadgeHtml)}</pre>` : '<p class="muted">Available on Pro and Business plans.</p>';

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
        .summary-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 22px 0; } .summary-card { padding: 18px; border-radius: 16px; background: white; border: 1px solid #e2e8f0; } .summary-card span { color: #64748b; font-size: 11px; font-weight: 800; text-transform: uppercase; } .summary-card strong { display:block; margin-top: 8px; font-size: 22px; }
        .callout { padding: 20px; border-radius: 18px; background: #fef2f2; border: 1px solid #fecaca; } .muted { color: #64748b; }
        .checklist { padding-left: 20px; } .checklist li { margin: 0 0 12px; } .checklist span { display:block; color:#64748b; font-size: 13px; }
        .violation-card { margin: 0 0 22px; padding: 22px; background: white; border: 1px solid #dce3ea; border-radius: 18px; break-inside: avoid; } .violation-card header { display:flex; justify-content:space-between; gap:18px; }
        .severity { align-self: flex-start; padding: 7px 12px; border-radius: 999px; color: white; font-weight: 800; font-size: 11px; text-transform: uppercase; } .wcag { margin:0; color:#2563eb; font-size: 11px; font-weight:800; text-transform:uppercase; }
        .meta-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 16px 0; } .meta-grid div { padding: 12px; border-radius: 12px; background: #f8fafc; } .meta-grid strong { display:block; font-size: 11px; color:#64748b; text-transform:uppercase; } .meta-grid span { display:block; margin-top:6px; font-size:12px; }
        pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; padding: 12px; border-radius: 12px; background: #0f172a; color: #e2e8f0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
        .code-label { margin: 18px 0 0; color:#64748b; font-weight:800; font-size: 11px; text-transform: uppercase; }
        .fix-box { margin-top: 16px; padding: 16px; border-radius: 14px; background: #f0fdf4; border: 1px solid #bbf7d0; } .fix-box h4 { margin:0 0 10px; color:#15803d; } .fix-box pre { background: #ecfdf5; color: #14532d; border: 1px solid #bbf7d0; }
        .replace-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; } table { width: 100%; border-collapse: collapse; background: white; border-radius: 16px; overflow: hidden; } th, td { padding: 13px; border-bottom: 1px solid #e2e8f0; text-align: left; font-size: 13px; } th { background: #eff6ff; color: #1d4ed8; }
      </style>
    </head>
    <body>
      <section class="page cover"><div class="brand">${logo}</div><p class="label">Paid ADA compliance report</p><h1>Consultant-grade accessibility audit</h1><p class="cover-url">${escapeHtml(report.url)}</p><div class="stat-grid"><div class="stat"><span>Score</span><strong>${report.executiveSummary.score} / ${report.executiveSummary.grade}</strong></div><div class="stat"><span>Risk</span><strong>${escapeHtml(report.executiveSummary.riskLevel)}</strong></div><div class="stat"><span>Report ID</span><strong style="font-size:17px">${escapeHtml(report.reportId)}</strong></div></div></section>
      <section class="page"><h2>Executive summary</h2><div class="summary-grid"><div class="summary-card"><span>Score</span><strong>${report.executiveSummary.score}</strong></div><div class="summary-card"><span>Risk level</span><strong>${escapeHtml(report.executiveSummary.riskLevel)}</strong></div><div class="summary-card"><span>Settlement range</span><strong>${report.executiveSummary.settlementRange}</strong></div><div class="summary-card"><span>Estimated fix time</span><strong>${escapeHtml(report.executiveSummary.estimatedFixTime)}</strong></div></div><div class="callout"><strong>Use fear responsibly:</strong> settlement risk belongs next to a path forward. Start with the top three fixes below, then work through the detailed findings by severity.</div><h2 style="margin-top:32px">Priority checklist</h2><ol class="checklist">${priorities}</ol><h2 style="margin-top:32px">Trend</h2><p>${escapeHtml(report.trend.summary)}</p></section>
      <section class="page"><h2>Page-by-page breakdown</h2><table><thead><tr><th>Page scanned</th><th>Violations</th><th>Density</th></tr></thead><tbody>${pages}</tbody></table><h2 style="margin-top:32px">Compliance badge</h2>${badge}</section>
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
