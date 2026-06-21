const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const RESEND_API_URL = 'https://api.resend.com/emails';
const DELIVERY_DEADLINE_MS = 55_000;
const PAGE = { width: 595.28, height: 841.89, left: 48, right: 547, top: 58, bottom: 770 };

const COLORS = {
  ink: '#111827', muted: '#64748B', line: '#DCE3EA', navy: '#0B1220', blue: '#2563EB',
  critical: '#DC2626', criticalTint: '#FEF2F2', serious: '#D97706', seriousTint: '#FFF7ED',
  moderate: '#CA8A04', moderateTint: '#FEFCE8', minor: '#64748B', minorTint: '#F1F5F9',
  success: '#15803D', successTint: '#F0FDF4', white: '#FFFFFF', surface: '#F8FAFC',
};

const WCAG_BY_RULE = {
  'aria-allowed-attr': '4.1.2', 'aria-hidden-body': '4.1.2', 'aria-prohibited-attr': '4.1.2',
  'aria-required-attr': '4.1.2', 'aria-valid-attr-value': '4.1.2', 'button-name': '4.1.2',
  'color-contrast': '1.4.3', 'document-title': '2.4.2', 'duplicate-id-aria': '4.1.1',
  'heading-order': '1.3.1', 'html-has-lang': '3.1.1', 'image-alt': '1.1.1',
  label: '3.3.2', 'landmark-one-main': '1.3.1', 'link-name': '2.4.4',
  'meta-viewport': '1.4.4', region: '1.3.1', 'select-name': '4.1.2',
};

const PLAIN_TITLES = {
  'aria-allowed-attr': 'Assistive technology receives unsupported information',
  'aria-hidden-body': 'Screen readers cannot access the page content',
  'aria-prohibited-attr': 'Assistive technology may misinterpret this control',
  'aria-required-attr': 'Assistive technology is missing required context',
  'aria-valid-attr-value': 'Assistive technology receives invalid control information',
  'button-name': 'Screen reader users cannot identify this button',
  'color-contrast': 'People with low vision may not be able to read this content',
  'document-title': 'Users cannot identify this page from its browser tab',
  'duplicate-id-aria': 'Assistive technology may identify the wrong element',
  'heading-order': 'Screen reader users may lose the page hierarchy',
  'html-has-lang': 'Screen readers may pronounce this page incorrectly',
  'image-alt': 'Screen reader users cannot understand this image',
  label: 'Users cannot identify what this form field requires',
  'landmark-one-main': 'Screen reader users cannot quickly find the main content',
  'link-name': 'Screen reader users cannot tell where this link goes',
  'meta-viewport': 'People with low vision may be unable to zoom the page',
  region: 'Screen reader users may struggle to navigate this content',
  'select-name': 'Users cannot identify what this selection field requires',
};

function severityStyle(impact = 'minor') {
  const key = ['critical', 'serious', 'moderate', 'minor'].includes(impact) ? impact : 'minor';
  return { key, color: COLORS[key], tint: COLORS[`${key}Tint`] };
}

function calculateRisk(scan) {
  const counts = scan.violationsBySeverity || {};
  if ((counts.critical || 0) > 0) return { label: 'Critical Risk', color: COLORS.critical, tint: COLORS.criticalTint };
  if ((counts.serious || 0) > 0) return { label: 'High Risk', color: COLORS.serious, tint: COLORS.seriousTint };
  if ((counts.moderate || 0) > 0) return { label: 'Moderate Risk', color: COLORS.moderate, tint: COLORS.moderateTint };
  return { label: 'Low Risk', color: COLORS.minor, tint: COLORS.minorTint };
}

function plainTitle(violation) {
  if (PLAIN_TITLES[violation.id]) return PLAIN_TITLES[violation.id];
  const description = String(violation.description || '').replace(/\s+/g, ' ').trim();
  if (description) return description.replace(/^Ensures?\s+/i, '').replace(/^Elements?\s+/i, 'This content ');
  return String(violation.id || 'Accessibility issue').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
}

function affectedUsers(violation) {
  const id = violation.id || '';
  if (/color-contrast|meta-viewport/.test(id)) return 'People with low vision, color-vision deficiencies, or users who enlarge content are affected.';
  if (/label|button|link|aria|image-alt|heading|landmark|region|html-has-lang/.test(id)) return 'Screen reader and keyboard users may be unable to understand or navigate this content reliably.';
  return 'People using assistive technologies may be unable to perceive, understand, or operate this part of the page.';
}

function wcagCriterion(violation) {
  const tag = (violation.tags || []).find(value => /^wcag\d{3,4}$/i.test(value));
  if (tag) {
    const digits = tag.replace(/\D/g, '');
    return digits.length === 3 ? `${digits[0]}.${digits[1]}.${digits[2]}` : `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
  }
  return WCAG_BY_RULE[violation.id] || 'Review required';
}

function cleanText(value, fallback) {
  return String(value || fallback).replace(/\s+/g, ' ').trim();
}

function fixText(violation) {
  const failure = violation.nodes?.[0]?.failureSummary;
  if (!failure) return cleanText(violation.help, 'Review this component against the linked WCAG success criterion and correct its accessible implementation.');
  return cleanText(failure, violation.help)
    .replace(/^Fix (?:any|all) of the following:\s*/i, '')
    .replace(/^Fix the following:\s*/i, '');
}

function drawLogo(doc, x, y, color = COLORS.white, compact = false) {
  doc.save();
  doc.roundedRect(x, y, compact ? 16 : 22, compact ? 16 : 22, 4).fill(COLORS.blue);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(compact ? 8 : 11)
    .text('A', x, y + (compact ? 4 : 6), { width: compact ? 16 : 22, align: 'center' });
  doc.fillColor(color).font('Helvetica-Bold').fontSize(compact ? 8 : 11)
    .text('ADA SCANNER', x + (compact ? 22 : 30), y + (compact ? 3 : 5), { lineBreak: false });
  doc.restore();
}

function drawBadge(doc, label, x, y, color, tint, width) {
  const badgeWidth = width || Math.max(70, doc.widthOfString(label) + 24);
  doc.save().roundedRect(x, y, badgeWidth, 24, 12).fill(tint);
  doc.fillColor(color).font('Helvetica-Bold').fontSize(8).text(label.toUpperCase(), x, y + 8, { width: badgeWidth, align: 'center' });
  doc.restore();
  return badgeWidth;
}

function newContentPage(doc, title, eyebrow) {
  doc.addPage();
  drawLogo(doc, PAGE.left, 34, COLORS.ink, true);
  doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(8).text(eyebrow.toUpperCase(), PAGE.left, 74, { characterSpacing: 1.2 });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(25).text(title, PAGE.left, 91);
  doc.moveTo(PAGE.left, 127).lineTo(PAGE.right, 127).strokeColor(COLORS.line).lineWidth(1).stroke();
  return 148;
}

function drawCover(doc, scan, url, reportId, scanDate, risk) {
  doc.rect(0, 0, PAGE.width, PAGE.height).fill(COLORS.navy);
  doc.rect(0, 0, 8, PAGE.height).fill(COLORS.blue);
  drawLogo(doc, 52, 48);
  doc.fillColor('#93C5FD').font('Helvetica-Bold').fontSize(10).text('ADA COMPLIANCE REPORT', 52, 175, { characterSpacing: 1.6 });
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(34)
    .text(url, 52, 205, { width: 490, height: 110, ellipsis: true });
  doc.fillColor('#94A3B8').font('Helvetica').fontSize(10).text(`Scan date  ${scanDate}`, 52, 335);
  doc.text(`Report ID  ${reportId}`, 52, 355);

  const stats = [
    { label: 'TOTAL VIOLATIONS', value: String(scan.summary?.totalViolations || 0) },
    { label: 'STANDARD TESTED', value: 'WCAG 2.1 AA' },
    { label: 'CALCULATED RISK', value: risk.label, risk: true },
  ];
  const gap = 12;
  const width = (491 - gap * 2) / 3;
  stats.forEach((stat, index) => {
    const x = 52 + index * (width + gap);
    doc.roundedRect(x, 470, width, 116, 10).fill('#172033');
    doc.fillColor('#94A3B8').font('Helvetica-Bold').fontSize(7).text(stat.label, x + 14, 488, { width: width - 28, characterSpacing: 0.8 });
    if (stat.risk) drawBadge(doc, stat.value, x + 14, 526, risk.color, risk.tint, width - 28);
    else doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(index === 0 ? 30 : 15).text(stat.value, x + 14, 523, { width: width - 28 });
  });
  doc.fillColor('#CBD5E1').font('Helvetica').fontSize(9)
    .text('Automated accessibility audit • Prioritized findings • Actionable remediation guidance', 52, 640, { width: 490 });
}

function drawExecutiveSummary(doc, scan, risk) {
  let y = newContentPage(doc, 'Executive summary', 'Assessment overview');
  const total = scan.summary?.totalViolations || 0;
  const critical = scan.violationsBySeverity?.critical || 0;
  const serious = scan.violationsBySeverity?.serious || 0;
  const summary = total
    ? `This automated audit identified ${total} accessibility violation${total === 1 ? '' : 's'}, including ${critical} critical and ${serious} serious finding${serious === 1 ? '' : 's'}. The current result is classified as ${risk.label.toLowerCase()}, meaning some visitors may be prevented from understanding or using important content. Prioritize barriers affecting navigation, forms, controls, and essential information.`
    : 'This automated audit did not identify violations in the tested page. Automated testing cannot detect every accessibility barrier, so manual keyboard and screen reader review is still recommended.';
  const boxColor = critical > 0 ? COLORS.critical : risk.color;
  const boxTint = critical > 0 ? COLORS.criticalTint : risk.tint;
  doc.roundedRect(PAGE.left, y, 499, 170, 12).fill(boxTint);
  doc.rect(PAGE.left, y, 5, 170).fill(boxColor);
  drawBadge(doc, risk.label, PAGE.left + 20, y + 18, risk.color, COLORS.white, 106);
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(11).text(summary, PAGE.left + 20, y + 56, { width: 459, lineGap: 4 });
  y += 195;

  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(15).text('Why this matters', PAGE.left, y);
  y += 29;
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(10.5)
    .text('The reported average ADA website settlement range is $5,000–$25,000 before legal fees. Industry tracking recorded more than 4,000 digital accessibility lawsuits in 2025, reinforcing the need for documented, timely remediation.', PAGE.left, y, { width: 499, lineGap: 4 });
  y += 70;

  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(15).text('What to do next', PAGE.left, y);
  y += 34;
  [
    ['1', 'Fix critical barriers first', 'Address controls, forms, navigation, and content that block assistive technology users.'],
    ['2', 'Validate the corrections', 'Retest automatically, then verify key journeys using only a keyboard and a screen reader.'],
    ['3', 'Prevent regressions', 'Add recurring scans and accessibility checks to every release workflow.'],
  ].forEach(([number, title, body]) => {
    doc.circle(PAGE.left + 14, y + 14, 14).fill(COLORS.blue);
    doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(9).text(number, PAGE.left + 9, y + 10, { width: 10, align: 'center' });
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10.5).text(title, PAGE.left + 42, y + 2);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9.5).text(body, PAGE.left + 42, y + 20, { width: 445 });
    y += 65;
  });
}

function cardHeight(doc, violation) {
  const width = 459;
  const titleHeight = doc.font('Helvetica-Bold').fontSize(13).heightOfString(plainTitle(violation), { width: 335 });
  const body = `${affectedUsers(violation)} ${violation.affectedElements || violation.nodes?.length || 0} element(s) were detected.`;
  const bodyHeight = doc.font('Helvetica').fontSize(9.5).heightOfString(body, { width });
  const snippet = cleanText(violation.nodes?.[0]?.html, 'No code sample was captured.').slice(0, 500);
  const codeHeight = Math.min(70, doc.font('Courier').fontSize(8).heightOfString(snippet, { width: 431 }) + 18);
  const fixHeight = doc.font('Helvetica').fontSize(9).heightOfString(fixText(violation).slice(0, 500), { width: 421 });
  const bodyStart = Math.max(78, 51 + titleHeight);
  const fixBoxHeight = Math.max(58, fixHeight + 35);
  return Math.max(245, bodyStart + bodyHeight + 12 + codeHeight + 12 + fixBoxHeight + 10);
}

function drawViolationCard(doc, violation, y) {
  const height = cardHeight(doc, violation);
  const style = severityStyle(violation.impact);
  doc.roundedRect(PAGE.left, y, 499, height, 10).fillAndStroke(COLORS.white, COLORS.line);
  doc.rect(PAGE.left, y, 5, height).fill(style.color);
  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7)
    .text(`WCAG ${wcagCriterion(violation)}`, PAGE.left + 20, y + 18, { characterSpacing: 0.5 });
  drawBadge(doc, style.key, PAGE.right - 92, y + 13, style.color, style.tint, 76);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(13)
    .text(plainTitle(violation), PAGE.left + 20, y + 39, { width: 335, lineGap: 2 });
  let cursor = Math.max(y + 78, doc.y + 12);
  const count = violation.affectedElements || violation.nodes?.length || 0;
  const body = `${affectedUsers(violation)} ${count} element${count === 1 ? '' : 's'} ${count === 1 ? 'was' : 'were'} detected on the scanned page.`;
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9.5).text(body, PAGE.left + 20, cursor, { width: 459, lineGap: 2 });
  cursor = doc.y + 12;

  const snippet = cleanText(violation.nodes?.[0]?.html, 'No code sample was captured.').slice(0, 500);
  const codeHeight = Math.min(70, doc.font('Courier').fontSize(8).heightOfString(snippet, { width: 431 }) + 18);
  doc.roundedRect(PAGE.left + 20, cursor, 459, codeHeight, 6).fill('#0F172A');
  doc.fillColor('#E2E8F0').font('Courier').fontSize(8).text(snippet, PAGE.left + 34, cursor + 9, { width: 431, height: codeHeight - 14, ellipsis: true });
  cursor += codeHeight + 12;

  const fix = fixText(violation).slice(0, 500);
  const fixBoxHeight = Math.max(58, doc.font('Helvetica').fontSize(9).heightOfString(fix, { width: 421 }) + 35);
  doc.roundedRect(PAGE.left + 20, cursor, 459, fixBoxHeight, 7).fill(COLORS.successTint);
  doc.fillColor(COLORS.success).font('Helvetica-Bold').fontSize(9).text('HOW TO FIX THIS', PAGE.left + 34, cursor + 11);
  doc.fillColor('#166534').font('Helvetica').fontSize(9).text(fix, PAGE.left + 34, cursor + 27, { width: 431, height: fixBoxHeight - 32, ellipsis: true });
  return height;
}

function drawViolations(doc, scan) {
  const violations = scan.violations || [];
  let y = newContentPage(doc, 'Detailed findings', `${violations.length} prioritized violations`);
  if (!violations.length) {
    doc.roundedRect(PAGE.left, y, 499, 110, 10).fill(COLORS.successTint);
    doc.fillColor(COLORS.success).font('Helvetica-Bold').fontSize(16).text('No automated violations detected', PAGE.left + 22, y + 24);
    doc.fillColor('#166534').font('Helvetica').fontSize(10).text('Continue with manual keyboard, screen reader, zoom, and usability testing.', PAGE.left + 22, y + 55);
    return;
  }

  violations.forEach((violation) => {
    const height = cardHeight(doc, violation);
    if (y + height > PAGE.bottom) y = newContentPage(doc, 'Detailed findings', 'Continued');
    y += drawViolationCard(doc, violation, y) + 18;
  });
}

function drawClosingPage(doc, url) {
  doc.addPage();
  doc.rect(0, 0, PAGE.width, PAGE.height).fill(COLORS.navy);
  drawLogo(doc, 52, 48);
  doc.fillColor('#93C5FD').font('Helvetica-Bold').fontSize(9).text('ACCESSIBILITY IS AN ONGOING PRACTICE', 52, 205, { characterSpacing: 1.1 });
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(31)
    .text('Keep every release accessible.', 52, 235, { width: 470, lineGap: 4 });
  doc.fillColor('#CBD5E1').font('Helvetica').fontSize(12)
    .text(`A one-time audit is a snapshot. Upgrade to continuous monitoring to detect new accessibility regressions on ${url} before they reach customers.`, 52, 335, { width: 470, lineGap: 6 });
  doc.roundedRect(52, 455, 250, 50, 8).fill(COLORS.blue);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(11).text('UPGRADE TO CONTINUOUS MONITORING', 68, 475, { width: 218, align: 'center' });
  doc.fillColor('#94A3B8').font('Helvetica').fontSize(9).text('ADA Scanner • Automated checks support—but do not replace—a complete manual accessibility audit.', 52, 560, { width: 470 });
}

function addFooters(doc, reportId) {
  const range = doc.bufferedPageRange();
  for (let pageIndex = 0; pageIndex < range.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    const dark = pageIndex === 0 || pageIndex === range.count - 1;
    const color = dark ? '#94A3B8' : COLORS.muted;
    doc.save();
    doc.moveTo(PAGE.left, 794).lineTo(PAGE.right, 794).strokeColor(dark ? '#334155' : COLORS.line).lineWidth(0.7).stroke();
    drawLogo(doc, PAGE.left, 806, dark ? '#CBD5E1' : COLORS.ink, true);
    doc.fillColor(color).font('Helvetica').fontSize(7.5).text(reportId, 210, 810, { width: 175, align: 'center', lineBreak: false });
    doc.text(`PAGE ${pageIndex + 1} OF ${range.count}`, 438, 810, { width: 109, align: 'right', lineBreak: false });
    doc.restore();
  }
}

function buildPdfReport(scan, url, options = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `ADA Compliance Report — ${url}`, Author: 'ADA Scanner' } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const reportId = options.reportId || `ADA-${crypto.randomUUID().split('-')[0].toUpperCase()}`;
    const dateValue = scan.timestamp ? new Date(scan.timestamp) : new Date();
    const scanDate = Number.isNaN(dateValue.getTime()) ? new Date().toLocaleDateString('en-US') : dateValue.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const risk = calculateRisk(scan);

    drawCover(doc, scan, url, reportId, scanDate, risk);
    drawExecutiveSummary(doc, scan, risk);
    drawViolations(doc, scan);
    drawClosingPage(doc, url);
    addFooters(doc, reportId);
    doc.end();
  });
}

async function sendReportEmail(email, scan, url) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) throw new Error('Email service is not configured. Set RESEND_API_KEY and RESEND_FROM.');

  const startedAt = Date.now();
  const pdfBuffer = await buildPdfReport(scan, url);
  const remainingMs = DELIVERY_DEADLINE_MS - (Date.now() - startedAt);
  if (remainingMs <= 0) throw new Error('Report generation exceeded the email delivery deadline.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `Your ADA compliance report for ${url}.`,
        text: `Attached is your ADA compliance report for ${url}. The PDF contains the complete accessibility scan findings.`,
        attachments: [{ filename: 'ada-compliance-report.pdf', content: pdfBuffer.toString('base64') }],
      }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `Resend rejected the email (${response.status}).`);
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Resend did not accept the email within 55 seconds.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendPdfAttachmentEmail(email, url, pdfBuffer, filename = 'ada-compliance-report.pdf') {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) throw new Error('Email service is not configured. Set RESEND_API_KEY and RESEND_FROM.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_DEADLINE_MS);
  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `Your ADA compliance report for ${url}.`,
        text: `Attached is your full ADA compliance report for ${url}. The PDF includes all findings, source snippets, and generated code fixes.`,
        attachments: [{ filename, content: pdfBuffer.toString('base64') }],
      }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `Resend rejected the email (${response.status}).`);
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Resend did not accept the email within 55 seconds.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { buildPdfReport, calculateRisk, plainTitle, sendPdfAttachmentEmail, sendReportEmail, wcagCriterion };
