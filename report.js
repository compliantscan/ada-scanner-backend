const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const LOGO_DATA_URL = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, 'assets', 'compliantscan-mark.png')).toString('base64')}`;
const SITE_URL = 'https://www.compliantscan.com/';

const SEVERITY_ORDER = { critical: 4, serious: 3, moderate: 2, minor: 1 };

const FINDING_GUIDANCE = {
  'color-contrast': {
    title: 'Some text may be difficult to read',
    area: 'Color and visual clarity',
    summary: 'Some text and interface elements do not meet the selected contrast threshold.',
    relatedCheck: 'Minimum color contrast',
    why: 'Low contrast can make text harder to read for people with low vision or in bright light.',
    check: 'Verify the text and background color pair meets the selected contrast target.',
    value: 'A shared color-token fix can improve many repeated elements.',
  },
  label: {
    title: 'Form fields need clearer labels',
    area: 'Forms and lead capture',
    summary: 'Some form fields are missing clear, programmatically associated labels.',
    relatedCheck: 'Accessible form label',
    why: 'Visitors using screen readers may not know what information a field is asking them to enter.',
    check: 'Connect every visible label to its input and give icon-only fields an accessible name.',
    value: 'Clearer forms reduce friction in contact, quote, and signup flows.',
  },
  'button-name': {
    title: 'Some buttons need a meaningful name',
    area: 'Navigation and interaction',
    summary: 'Some controls do not expose a clear programmatic name.',
    relatedCheck: 'Accessible button name',
    why: 'An unlabeled button can be announced only as “button,” leaving its purpose unclear.',
    check: 'Add visible text or an accessible name that describes the action.',
    value: 'Reusable button fixes improve navigation across the whole site.',
  },
  'link-name': {
    title: 'Some links do not explain where they go',
    area: 'Navigation and calls to action',
    summary: 'Some links are missing text that clearly explains their destination.',
    relatedCheck: 'Accessible link name',
    why: 'Unclear link names make destinations hard to understand with assistive technology.',
    check: 'Add descriptive text or an accessible name to icon-only links.',
    value: 'Clear link names reduce ambiguity and make navigation easier for all visitors.',
  },
  'image-alt': {
    title: 'Important images need text alternatives',
    area: 'Images and content',
    summary: 'Some meaningful images are missing a useful text alternative.',
    relatedCheck: 'Image text alternative',
    why: 'Without alternative text, meaningful image content may be missed by screen-reader users.',
    check: 'Add concise alt text for informative images and empty alt text for decorative images.',
    value: 'Good image descriptions make portfolio and case-study content more useful.',
  },
  'heading-order': {
    title: 'The page heading structure needs refinement',
    area: 'Content structure',
    summary: 'Some heading levels do not follow a clear content hierarchy.',
    relatedCheck: 'Logical heading order',
    why: 'A logical heading order helps visitors understand and navigate the page.',
    check: 'Keep heading levels in a clear hierarchy without skipping levels.',
    value: 'A stronger outline improves accessibility and editorial consistency.',
  },
  region: {
    title: 'Some content sits outside clear page regions',
    area: 'Page structure',
    summary: 'Some page content is not contained within a meaningful landmark.',
    relatedCheck: 'Content landmark regions',
    why: 'Landmarks help assistive-technology users move between major page areas.',
    check: 'Wrap major sections in meaningful header, nav, main, aside, or footer regions.',
    value: 'One layout fix can improve every page using the same template.',
  },
  'landmark-one-main': {
    title: 'The page needs one clear main content region',
    area: 'Page structure',
    summary: 'The page does not expose one clear main content region.',
    relatedCheck: 'Single main landmark',
    why: 'A single main landmark lets visitors skip repeated navigation and reach the primary content.',
    check: 'Use one main element around the page’s unique primary content.',
    value: 'This is usually a quick template-level improvement with site-wide value.',
  },
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function domainFrom(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url || 'website').replace(/^https?:\/\//, '').split('/')[0];
  }
}

function agencyFrom(domain) {
  if (String(domain).toLowerCase() === 'dd.nyc') return 'DD.NYC';
  const label = String(domain).split('.')[0].replace(/[-_]+/g, ' ').trim();
  return label
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || 'Your Agency';
}

function reportFilename(report) {
  const agency = agencyFrom(domainFrom(report?.url));
  const safeName = agency.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'Agency';
  return `${safeName}-Accessibility-Snapshot.pdf`;
}

function findingCopy(item = {}) {
  const guide = FINDING_GUIDANCE[item.ruleId] || {
    title: item.title || item.description || 'An accessibility improvement was identified',
    area: 'Website experience',
    summary: item.description || item.help || 'The automated scan identified a pattern that should be reviewed.',
    relatedCheck: item.ruleId || 'Automated accessibility check',
    why: item.description || 'This issue may create unnecessary friction for some visitors using assistive technology.',
    check: item.fix?.explanation || 'Review the affected component and test the updated experience with keyboard and screen-reader navigation.',
    value: 'Resolving a shared component can improve the experience wherever it appears.',
  };
  return { ...item, ...guide };
}

function findingLocation(item) {
  const target = String(item.target || '').toLowerCase();
  if (/header|nav|menu/.test(target)) return 'Homepage header navigation';
  if (/footer/.test(target)) return 'Homepage footer';
  if (/form|input|select|textarea/.test(target)) return 'Homepage form';
  if (/button|cta|hero/.test(target)) return 'Homepage primary content';
  if (/main|section|article/.test(target)) return 'Homepage content area';
  return 'Homepage';
}

function brand() {
  return `<a class="brand" href="${SITE_URL}"><img src="${LOGO_DATA_URL}" alt=""><strong>CompliantScan</strong></a>`;
}

function siteLink() {
  return `<a class="site-link" href="${SITE_URL}">compliantscan.com</a>`;
}

function header(title) {
  return `<header>${brand()}<span class="header-title">${escapeHtml(title)}</span>${siteLink()}</header>`;
}

function footer(page) {
  return `<footer><span>CompliantScan · Accessibility Snapshot</span><span>${page} / 5</span></footer>`;
}

function findingCard(item, index, domain) {
  const finding = findingCopy(item);
  const screenshot = /^data:image\/(png|jpe?g|webp);base64,/i.test(finding.screenshotDataUrl || '')
    ? `<figure><img src="${finding.screenshotDataUrl}" alt=""></figure>`
    : `<div class="placeholder"><span>Detected on</span><strong>${escapeHtml(domain)}</strong></div>`;
  const facts = [
    ['&#8982;', 'Found on', findingLocation(finding)],
    ['&#9678;', 'Affected', `${Number(finding.affectedElements || 0)} element${Number(finding.affectedElements || 0) === 1 ? '' : 's'}`],
    ['&#10003;', 'Related check', finding.relatedCheck],
    ['?', 'Why it matters', finding.why],
    ['&lt;/&gt;', 'Developer check', finding.check],
    ['&#9635;', 'Agency value', finding.value],
  ];
  return `
    <article class="finding">
      <div class="finding-rail"><strong>0${index + 1}</strong><i></i></div>
      <div class="finding-main">
        <div class="finding-title">
          <div><span>${escapeHtml(finding.area)}</span><h3>${escapeHtml(finding.title)}</h3><p>${escapeHtml(finding.summary)}</p></div>
          <em class="${escapeHtml(finding.severity || 'minor')}"><b>!</b>${escapeHtml(finding.severity || 'review')}</em>
        </div>
        <div class="finding-lower">
          <aside class="finding-evidence">
            <span>Example from scan</span>
            ${screenshot}
            <div class="evidence-note"><b>!</b><p>${escapeHtml(finding.why)}</p></div>
          </aside>
          <dl class="finding-facts">
            ${facts.map(([icon, label, value]) => `<div><i>${icon}</i><section><dt>${label}</dt><dd>${escapeHtml(value)}</dd></section></div>`).join('')}
          </dl>
        </div>
      </div>
    </article>`;
}

function renderPaidReportHtml(report) {
  const domain = domainFrom(report.url);
  const agency = agencyFrom(domain);
  const summary = report.executiveSummary || {};
  const severity = summary.severityCounts || {};
  const violations = (report.violations || []).slice().sort((a, b) => (
    (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0)
    || Number(b.affectedElements || 0) - Number(a.affectedElements || 0)
  ));
  const totalIssues = Number(summary.totalViolations ?? violations.length);
  const affectedElements = violations.reduce((sum, item) => sum + Number(item.affectedElements || 0), 0);
  const repeatedComponents = violations.filter(item => Number(item.affectedElements || 0) > 1).length;
  const pagesScanned = Math.max(1, Number(report.pages?.length || 1));
  const scanScope = pagesScanned === 1 ? 'Homepage only' : `${pagesScanned} pages`;
  const scanDate = new Date(report.pages?.[0]?.scannedAt || report.generatedAt || Date.now())
    .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const top = violations.length
    ? violations.slice(0, 3)
    : [{
      severity: 'minor',
      affectedElements: 0,
      title: 'No automated violations were detected',
      area: 'Automated scan result',
      why: 'The selected automated checks did not identify a failure on this page.',
      check: 'Complete keyboard, zoom, screen-reader, and content review before treating the site as fully accessible.',
      value: 'This provides a strong baseline for ongoing quality checks.',
    }];

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(agency)} Accessibility Snapshot</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #17241f; font-family: Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { position: relative; width: 210mm; height: 297mm; padding: 15mm 16mm 18mm; overflow: hidden; page-break-after: always; background: #fff; }
  .page:last-child { page-break-after: auto; }
  header { height: 12mm; padding-bottom: 4mm; border-bottom: .25mm solid #d8d7ce; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; color: #56655d; font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; }
  .header-title { justify-self: center; }
  .brand { display: flex; align-items: center; gap: 2.5mm; width: max-content; color: #111b17; font-size: 13pt; letter-spacing: -.03em; text-transform: none; text-decoration: none; }
  .brand img { width: 9mm; height: 9mm; object-fit: contain; }
  .brand strong { font-weight: 700; }
  .site-link { justify-self: end; color: #214b39; font-size: 7.5pt; font-weight: 700; letter-spacing: .02em; text-transform: lowercase; text-decoration: none; }
  footer { position: absolute; left: 16mm; right: 16mm; bottom: 7mm; padding-top: 3mm; border-top: .25mm solid #e4e2da; display: flex; justify-content: space-between; color: #68756e; font-size: 8pt; letter-spacing: .06em; text-transform: uppercase; }
  .eyebrow { color: #955f16; font-size: 8.5pt; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  h1, h2, h3, p { margin-top: 0; }
  h2 { margin: 3mm 0; font-family: Georgia, 'Times New Roman', serif; font-size: 31pt; line-height: 1.02; font-weight: 400; letter-spacing: -.035em; }
  .intro { margin-top: 16mm; max-width: 165mm; }
  .intro p { max-width: 155mm; color: #45534b; font-size: 10.5pt; line-height: 1.6; }

  .cover { padding: 0; }
  .cover-top { margin: 9mm 12mm 0; height: 14mm; display: flex; align-items: center; justify-content: space-between; font-size: 8pt; }
  .cover-rule { height: .25mm; margin: 0 12mm; background: #ccc9bf; }
  .cover-body { display: grid; grid-template-columns: 1.05fr .95fr; padding: 22mm 13mm 0; }
  .cover h1 { margin: 0; font-family: Georgia, 'Times New Roman', serif; font-size: 51pt; line-height: .94; font-weight: 400; letter-spacing: -.045em; }
  .cover-for { margin: 5mm 0 0; font-family: Georgia, 'Times New Roman', serif; font-size: 24pt; }
  .cover-for strong { color: #2b6a52; font-weight: 400; }
  .gold-rule { width: 18mm; height: .7mm; margin: 12mm 0 10mm; background: #bc8127; }
  .cover dl { display: grid; gap: 7mm; margin: 0; }
  .cover dl div { min-height: 12mm; padding-left: 17mm; position: relative; }
  .cover dt { font-size: 9pt; font-weight: 700; }
  .cover dt span { position: absolute; left: 0; top: -2mm; display: grid; place-items: center; width: 13mm; height: 13mm; border-radius: 50%; background: #efeee8; color: #214b39; font-size: 15pt; }
  .cover dd { margin: 2mm 0 0; color: #3e4542; font-size: 10pt; }
  .cover-note { margin-top: 12mm; max-width: 78mm; color: #35423b; font-size: 10.5pt; line-height: 1.65; }
  .art { position: relative; min-height: 125mm; margin-top: 34mm; }
  .glow { position: absolute; inset: 0 -12mm 3mm -7mm; border-radius: 50%; background: radial-gradient(circle at 48% 43%,#fff 0,#f3f1eb 54%,rgba(243,241,235,0) 73%); }
  .browser { position: absolute; left: 0; top: 20mm; width: 78mm; height: 65mm; overflow: hidden; border: .3mm solid #d6d5cd; border-radius: 5mm; background: rgba(255,255,255,.97); box-shadow: 0 6mm 14mm rgba(28,62,46,.14); }
  .browser-top { height: 12mm; padding: 0 5mm; border-bottom: .3mm solid #e2e1da; display: flex; align-items: center; justify-content: space-between; }
  .browser-dots { color: #c4c0b5; font-size: 10pt; letter-spacing: 1.2mm; }
  .browser-top b { color: #66736c; font-size: 6pt; letter-spacing: .09em; text-transform: uppercase; }
  .browser-address { height: 10mm; margin: 4mm 4mm 0; padding: 0 3mm; border: .3mm solid #e0dfd7; border-radius: 2.5mm; background: #faf9f6; display: flex; align-items: center; gap: 2mm; color: #3f4b45; font-size: 7pt; }
  .browser-address i { color: #2f6950; font-size: 10pt; font-style: normal; }
  .browser-body { height: 32mm; margin-top: 3mm; border-top: .3mm solid #eceae4; display: grid; grid-template-columns: 12mm 1fr; }
  .browser-body aside { padding-top: 4mm; border-right: .3mm solid #eceae4; display: grid; align-content: start; justify-content: center; gap: 2.5mm; }
  .browser-body aside i { width: 5mm; height: 5mm; border-radius: 1.5mm; background: #e6eee9; }
  .browser-body aside i:first-child { background: #2f684e; }
  .browser-lines { padding: 5mm; display: grid; align-content: start; gap: 2.5mm; }
  .browser-lines span { display: block; width: 75%; height: 2mm; border-radius: 2mm; background: #e5e2da; }
  .browser-lines span:first-child { width: 55%; height: 3mm; margin-bottom: 1mm; background: #b9c9c0; }
  .browser-lines span:last-child { width: 48%; }
  .art-logo-badge { position: absolute; right: -1mm; top: 8mm; width: 23mm; height: 23mm; padding: 4.5mm; border: .3mm solid rgba(34,91,61,.12); border-radius: 6mm; background: white; box-shadow: 0 4mm 10mm rgba(22,58,40,.16); transform: rotate(4deg); }
  .art-logo-badge img { width: 100%; height: 100%; object-fit: contain; }
  .art-status { position: absolute; right: -2mm; top: 74mm; min-width: 55mm; padding: 4mm; border-radius: 4mm; background: linear-gradient(135deg,#173f2e,#286047); color: white; box-shadow: 0 4mm 9mm rgba(20,55,38,.25); display: flex; align-items: center; gap: 3mm; }
  .art-status > b { width: 10mm; height: 10mm; flex: 0 0 auto; border-radius: 50%; background: white; color: #1f563b; display: grid; place-items: center; font-size: 13pt; }
  .art-status span strong, .art-status span small { display: block; }
  .art-status span strong { font-size: 8pt; }
  .art-status span small { margin-top: 1mm; color: #d8e7df; font-size: 5.5pt; }
  .browser-top:empty, .browser-top:not(:has(*)) { color: transparent; font-size: 0; }
  .browser-top:empty:before, .browser-top:not(:has(*)):before { content: '\\2022\\2022\\2022'; color: #c4c0b5; font-size: 10pt; letter-spacing: 1.2mm; }
  .browser-top:empty:after, .browser-top:not(:has(*)):after { content: 'Accessibility scan'; color: #66736c; font-size: 6pt; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
  .browser > .browser-lines { position: relative; height: 45mm; margin: 4mm; padding: 17mm 5mm 4mm 17mm; border: .3mm solid #ece9e2; border-radius: 3mm; color: transparent; font-size: 0; background: #faf9f6; }
  .browser > .browser-lines:before { content: ''; position: absolute; left: 4mm; top: 4mm; right: 4mm; height: 8mm; border: .3mm solid #dfddd5; border-radius: 2mm; background: linear-gradient(90deg,#e3ebe6 0 13%,transparent 13%); }
  .browser > .browser-lines:after { content: ''; position: absolute; left: 4mm; bottom: 5mm; width: 55mm; height: 20mm; border-radius: 2mm; background: linear-gradient(90deg,#31684f 0 15%,transparent 15%),linear-gradient(#b9c9c0 0 12%,transparent 12% 30%,#e5e2da 30% 40%,transparent 40% 58%,#e5e2da 58% 68%,transparent 68%); }
  .art-logo { position: absolute; right: -1mm; top: 8mm; width: 23mm; height: 23mm; padding: 4.5mm; border: .3mm solid rgba(34,91,61,.12); border-radius: 6mm; background: white; box-shadow: 0 4mm 10mm rgba(22,58,40,.16); object-fit: contain; transform: rotate(4deg); }
  .art:after { content: '\\2713  Snapshot ready'; position: absolute; right: -2mm; top: 74mm; min-width: 55mm; padding: 6mm 5mm; border-radius: 4mm; background: linear-gradient(135deg,#173f2e,#286047); color: white; box-shadow: 0 4mm 9mm rgba(20,55,38,.25); font-size: 8pt; font-weight: 700; letter-spacing: .02em; text-align: center; }
  .disclaimer { position: absolute; left: 0; right: 0; bottom: 0; height: 34mm; padding: 10mm 14mm; background: #f5f2ec; display: flex; align-items: center; gap: 7mm; }
  .disclaimer b { display: grid; place-items: center; width: 11mm; height: 11mm; border-radius: 50%; background: #194a31; color: white; font-family: Georgia,serif; font-size: 15pt; }
  .disclaimer p { margin: 0; padding-left: 6mm; border-left: .25mm solid #aaa89f; font-size: 9.5pt; line-height: 1.65; }

  .automated-summary { margin-top: 9mm; padding: 6mm 7mm; border-radius: 4mm; background: #173f2e; color: white; }
  .automated-summary > span { color: #d5e3dc; font-size: 8pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .automated-summary p { margin: 3mm 0 0; color: #f5f8f6; font-size: 10.5pt; line-height: 1.55; }
  .automated-summary p strong { color: #f0c77d; }
  .summary-grid { margin-top: 3mm; display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; }
  .score { grid-row: 1 / 3; padding: 7mm; border-radius: 4mm; background: #173f2e; color: white; }
  .score span, .metric span { font-size: 8.5pt; letter-spacing: .1em; text-transform: uppercase; }
  .score strong { display: block; margin-top: 8mm; font: 400 43pt Georgia,serif; }
  .score strong small { font: 400 11pt Arial; color: #b7c8c0; }
  .score p { margin-top: 6mm; color: #dce7e2; font-size: 9.5pt; line-height: 1.5; }
  .metric { padding: 5mm; border-radius: 4mm; background: #f4f2ed; display: flex; flex-direction: column; justify-content: center; }
  .metric strong { font: 400 24pt Georgia,serif; }
  .metric span { margin-top: 1mm; color: #69736e; }
  .severity-grid { margin-top: 8mm; border-top: .25mm solid #dbd9d0; border-bottom: .25mm solid #dbd9d0; display: grid; grid-template-columns: repeat(4,1fr); }
  .severity-grid div { padding: 5mm 4mm; border-right: .25mm solid #dbd9d0; display: flex; align-items: center; gap: 2mm; font-size: 9.5pt; text-transform: capitalize; }
  .severity-grid div:last-child { border: 0; }
  .severity-grid i { width: 2.2mm; height: 2.2mm; border-radius: 50%; }
  .severity-grid strong { margin-left: auto; }
  .critical { background-color: #a4403c !important; } .serious { background-color: #c26835 !important; } .moderate { background-color: #c2973e !important; } .minor { background-color: #6c8678 !important; }
  .opportunity { margin-top: 9mm; padding: 7mm 8mm; border-left: 1mm solid #b77a22; background: #f7f4ee; }
  .opportunity span { color: #76562a; font-size: 8.5pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .opportunity h3 { margin: 2.5mm 0; font: 400 19pt Georgia,serif; }
  .opportunity p { margin: 0; color: #45524b; font-size: 9.5pt; line-height: 1.65; }

  .findings-intro { margin-top: 8mm; }
  .findings-intro h2 { font-size: 25pt; }
  .findings-intro p { color: #46534c; font-size: 9.5pt; }
  .findings { margin-top: 6mm; display: grid; gap: 3mm; }
  .finding { position: relative; min-height: 61mm; border: .25mm solid #d4d3cb; border-radius: 3.5mm; overflow: hidden; break-inside: avoid; background: white; box-shadow: 0 1.5mm 4mm rgba(23,63,46,.07); }
  .finding-rail { position: absolute; z-index: 1; left: 0; top: 0; width: 12mm; height: 22mm; border-radius: 3.3mm 0 0 0; background: linear-gradient(155deg,#173f2e,#1f5538); color: white; display: flex; flex-direction: column; align-items: center; }
  .finding-rail strong { margin-top: 4.5mm; font: 400 13pt Georgia,serif; }
  .finding-rail i { width: 5mm; margin-top: 3mm; border-top: .25mm solid rgba(255,255,255,.65); }
  .finding-main { margin-left: 12mm; }
  .finding-title { min-height: 22mm; padding: 2.8mm 4mm; border-bottom: .25mm solid #deddd7; display: flex; justify-content: space-between; gap: 3mm; }
  .finding-title > div { min-width: 0; }
  .finding-title span { color: #214c37; font-size: 6pt; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .finding-title h3 { margin: .6mm 0 .4mm; color: #17231d; font: 400 13.5pt/1.05 Georgia,serif; }
  .finding-title p { max-width: 112mm; margin: 0; color: #536058; font-size: 6.5pt; line-height: 1.35; }
  .finding-title em { flex: 0 0 auto; align-self: flex-start; margin-top: .6mm; padding: 1.2mm 2mm; border-radius: 10mm; color: white; display: flex; align-items: center; gap: 1.2mm; font-size: 5.5pt; font-style: normal; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .finding-title em b { width: 4mm; height: 4mm; border: .4mm solid rgba(255,255,255,.9); border-radius: 50%; display: grid; place-items: center; font-size: 7pt; }
  .finding-lower { display: grid; grid-template-columns: 48mm 1fr; min-height: 38.5mm; }
  .finding-evidence { padding: 2.5mm 3mm; border-right: .25mm solid #e3e1db; background: linear-gradient(145deg,#faf9f6,#f4f1ea); }
  .finding-evidence > span { color: #214c37; font-size: 5.5pt; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .finding-evidence figure { width: 100%; margin: 1.5mm 0 0; }
  .finding-evidence img, .placeholder { width: 100%; height: 19mm; border: .25mm solid #d8d6ce; border-radius: 1.5mm; object-fit: contain; background: white; }
  .placeholder { margin-top: 1.5mm; padding: 3mm; background: linear-gradient(150deg,#f5f2ec,#e8eee9); display: flex; flex-direction: column; justify-content: flex-end; }
  .placeholder span { color: #68746d; font-size: 7pt; text-transform: uppercase; }
  .placeholder strong { margin-top: 1mm; font-size: 8pt; word-break: break-word; }
  .evidence-note { min-height: 10mm; margin-top: 1.5mm; padding: 1.2mm 1.5mm; border-radius: 1.5mm; background: rgba(230,231,220,.75); display: grid; grid-template-columns: 6mm 1fr; align-items: center; gap: 1.5mm; }
  .evidence-note b, .finding-facts i { border-radius: 50%; background: #e8eadf; color: #1d5134; display: grid; place-items: center; font-style: normal; font-weight: 700; }
  .evidence-note b { width: 6mm; height: 6mm; border: .25mm solid #d1d5c7; font-size: 7pt; }
  .evidence-note p { margin: 0; color: #26342d; font-size: 5.5pt; line-height: 1.3; }
  .finding-facts { margin: 0; display: grid; grid-template-columns: 1fr 1fr; }
  .finding-facts > div { min-width: 0; padding: 2.1mm 2.4mm; border-bottom: .25mm solid #e3e1db; display: grid; grid-template-columns: 7mm 1fr; align-items: start; gap: 1.8mm; }
  .finding-facts > div:nth-last-child(-n+2) { border-bottom: 0; }
  .finding-facts i { width: 7mm; height: 7mm; font-size: 6pt; }
  .finding-facts section { min-width: 0; }
  .finding-facts dt { color: #214c37; font-size: 5.2pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .finding-facts dd { margin: .6mm 0 0; color: #26342d; font-size: 6.2pt; line-height: 1.3; }
  .finding-facts > div:nth-child(2) dd { color: #17231d; font-weight: 700; }

  .workflow { margin-top: 13mm; display: grid; grid-template-columns: repeat(5,1fr); border-top: .25mm solid #d7d5cd; border-bottom: .25mm solid #d7d5cd; }
  .workflow div { min-height: 55mm; padding: 7mm 4mm; border-right: .25mm solid #d7d5cd; }
  .workflow div:last-child { border: 0; }
  .workflow span { color: #b27d2d; font: 400 10pt Georgia,serif; }
  .workflow h3 { margin: 9mm 0 2mm; font: 400 13pt Georgia,serif; }
  .workflow p { color: #47554d; font-size: 7.8pt; line-height: 1.5; }
  .monitor { margin-top: 12mm; padding: 9mm; border-radius: 4mm; background: #173f2e; color: white; display: grid; grid-template-columns: .85fr 1.15fr; gap: 9mm; }
  .monitor h3 { margin: 3mm 0 0; font: 400 18pt/1.15 Georgia,serif; }
  .monitor ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 3mm; }
  .monitor li { position: relative; padding-left: 6mm; color: #e3ece7; font-size: 9.2pt; line-height: 1.5; }
  .monitor li:before { content: '✓'; position: absolute; left: 0; color: #e0b76e; }

  .pilot { margin-top: 17mm; max-width: 165mm; }
  .offer { margin-top: 8mm; min-height: 96mm; border-radius: 5mm; overflow: hidden; display: grid; grid-template-columns: .8fr 1.2fr; box-shadow: 0 3mm 10mm rgba(15,48,33,.12); }
  .price { padding: 10mm; background: #173f2e; color: white; }
  .price > span { font-size: 8.5pt; letter-spacing: .13em; text-transform: uppercase; }
  .price strong { display: block; margin-top: 12mm; font: 400 48pt Georgia,serif; }
  .price strong sup { font-size: 16pt; }
  .price p { color: #d9e4df; font-size: 9pt; }
  .offer-details { padding: 10mm; background: #f6f3ed; }
  .offer-details h3 { margin: 0 0 7mm; font: 400 17pt Georgia,serif; }
  .offer-details ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 2.5mm; }
  .offer-details li { position: relative; padding-left: 7mm; color: #34423a; font-size: 8.8pt; }
  .offer-details li:before { content: '✓'; position: absolute; left: 0; color: #286046; font-weight: 700; }
  .after { margin-top: 7mm; padding: 6mm 7mm; border: .25mm solid #dbd9d0; display: grid; grid-template-columns: .7fr 1.3fr; gap: 8mm; align-items: center; }
  .after span { color: #7c8781; font-size: 6pt; letter-spacing: .1em; text-transform: uppercase; }
  .after strong { display: block; margin-top: 1.5mm; font: 400 17pt Georgia,serif; }
  .after p { margin: 0; color: #46534c; font-size: 9pt; line-height: 1.55; }
  .pilot-cta { margin-top: 5mm; padding: 5mm 6mm; border-radius: 3mm; background: #b87b25; color: white; display: flex; align-items: center; justify-content: space-between; gap: 7mm; }
  .pilot-cta span { display: block; font-size: 7.5pt; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .pilot-cta p { margin: 1.5mm 0 0; max-width: 128mm; font-size: 8.5pt; line-height: 1.45; }
  .pilot-cta > a { color: white; font: 400 16pt Georgia,serif; white-space: nowrap; text-decoration: none; }
  .pilot-footer { margin-top: 4mm; display: flex; align-items: flex-end; justify-content: space-between; }
  .pilot-footer span, .pilot-footer small { display: block; color: #7b8580; font-size: 6pt; letter-spacing: .09em; text-transform: uppercase; }
  .pilot-footer strong { display: block; margin: 1.5mm 0; font: 400 15pt Georgia,serif; }
  .pilot-footer a { color: #214b39; font-size: 8pt; font-weight: 700; text-decoration: none; }
</style>
</head>
<body>
  <section class="page cover">
    <div class="cover-top">${brand()}${siteLink()}</div>
    <div class="cover-rule"></div>
    <div class="cover-body">
      <div>
        <h1>Accessibility<br>Snapshot</h1>
        <p class="cover-for">for <strong>${escapeHtml(agency)}</strong></p>
        <div class="gold-rule"></div>
        <dl>
          <div><dt><span>◎</span> Website scanned</dt><dd>${escapeHtml(domain)}</dd></div>
          <div><dt><span>□</span> Scan scope</dt><dd>${escapeHtml(scanScope)}</dd></div>
          <div><dt><span>◇</span> Scan date</dt><dd>${escapeHtml(scanDate)}</dd></div>
        </dl>
        <p class="cover-note">Automated accessibility scan based on selected WCAG checks.</p>
      </div>
      <div class="art"><div class="glow"></div><div class="browser"><div class="browser-top">●●●</div><div class="browser-lines">▰ ━━━<br>━━ ━━<br>━ ━━━</div></div><img class="art-logo" src="${LOGO_DATA_URL}" alt=""></div>
    </div>
    <div class="disclaimer"><b>i</b><p>This report covers issues detectable through automated testing.<br>It is not a complete manual accessibility audit or certification of legal compliance.</p></div>
  </section>

  <section class="page">
    ${header('Executive summary')}
    <div class="intro"><span class="eyebrow">What the scan found</span><h2>A clear starting point for<br>${escapeHtml(agency)}</h2><p>This automated review covered ${escapeHtml(scanScope.toLowerCase())}. The opportunity is to fix shared components first, then keep those improvements in place as the site changes.</p></div>
    <div class="automated-summary"><span>Automated scan summary</span><p><strong>${totalIssues} issue types</strong> were detected across <strong>${affectedElements} elements</strong>. Most findings came from repeated navigation and layout patterns, meaning a small number of component-level fixes may resolve many instances.</p></div>
    <div class="summary-grid">
      <div class="metric"><strong>${totalIssues}</strong><span>issue types</span></div>
      <div class="metric"><strong>${affectedElements}</strong><span>affected elements</span></div>
      <div class="metric"><strong>${repeatedComponents}</strong><span>repeated patterns</span></div>
      <div class="metric"><strong>${pagesScanned}</strong><span>page${pagesScanned === 1 ? '' : 's'} scanned</span></div>
    </div>
    <div class="severity-grid">
      ${['critical', 'serious', 'moderate', 'minor'].map(level => `<div><i class="${level}"></i><span>${level}</span><strong>${Number(severity[level] || 0)}</strong></div>`).join('')}
    </div>
    <div class="opportunity"><span>Where to begin</span><h3>Prioritize shared templates and components.</h3><p>When the same navigation, button, form, or color style appears in multiple places, one thoughtful fix can improve many experiences at once. Start with serious and high-frequency findings, then verify the result with a short manual review.</p></div>
    ${footer(2)}
  </section>

  <section class="page">
    ${header('Priority findings')}
    <div class="findings-intro"><span class="eyebrow">Top three findings</span><h2>The most useful places to focus</h2><p>These priorities come directly from this scan, ordered by impact and how often the pattern appears.</p></div>
    <div class="findings">${top.slice(0, 3).map((item, index) => findingCard(item, index, domain)).join('')}</div>
    ${footer(3)}
  </section>

  <section class="page">
    ${header('Monitoring after launch')}
    <div class="intro"><span class="eyebrow">Keep improvements in place</span><h2>Accessibility does not<br>stop at launch</h2><p>New content, plugin updates, campaign pages, and design changes can introduce new accessibility barriers after the original website has been reviewed.</p></div>
    <div class="workflow">
      <div><span>01</span><h3>Baseline scan</h3><p>Establish the current automated accessibility baseline.</p></div>
      <div><span>02</span><h3>Issues fixed</h3><p>Prioritize shared components and verify the updates.</p></div>
      <div><span>03</span><h3>Website changes</h3><p>New content and releases alter the experience.</p></div>
      <div><span>04</span><h3>Rescan</h3><p>Check the website again after those changes.</p></div>
      <div><span>05</span><h3>Report</h3><p>Show new issues and what has been resolved.</p></div>
    </div>
    <div class="monitor"><div><span class="eyebrow">A practical agency rhythm</span><h3>Build checks into handoff and maintenance.</h3></div><ul><li>Scan before client review and again before launch.</li><li>Track recurring component issues across multiple sites.</li><li>Share a concise, client-friendly snapshot after improvements.</li><li>Use manual checks for keyboard flow, content, and real user experience.</li></ul></div>
    ${footer(4)}
  </section>

  <section class="page">
    ${header('Founding agency pilot')}
    <div class="pilot"><span class="eyebrow">Founding agency pilot</span><h2>Add accessibility monitoring<br>to your client care plans.</h2><p>A focused 30-day pilot for one agency that wants to add repeatable accessibility scanning, reporting, and post-launch monitoring to its client services.</p></div>
    <div class="offer"><div class="price"><span>30-day pilot</span><strong><sup>$</sup>99</strong><p>one-time pilot price</p></div><div class="offer-details"><h3>Included in the pilot</h3><ul><li>Up to five client websites</li><li>One baseline automated scan per website</li><li>Prioritized findings in plain language</li><li>Developer implementation guidance</li><li>Client-ready PDF snapshots</li><li>One follow-up rescan per website</li><li>New and resolved issue summary</li><li>Personal onboarding and support</li></ul></div></div>
    <div class="after"><div><span>After the pilot</span><strong>$199/month</strong></div><p>Continue only if the workflow is useful for your agency. No long-term commitment is required for the pilot.</p></div>
    <div class="pilot-cta"><div><span>Start with three websites</span><p>Reply to this email with <strong>“Pilot”</strong> and three website URLs. I’ll prepare the first scans and reports within 48 hours.</p></div><a href="mailto:info@compliantscan.com?subject=Pilot">Pilot →</a></div>
    <div class="pilot-footer"><div><span>Prepared for</span><strong>${escapeHtml(agency)}</strong><small>${escapeHtml(domain)}</small></div><a href="mailto:info@compliantscan.com?subject=Pilot">info@compliantscan.com</a></div>
    ${footer(5)}
  </section>
</body>
</html>`;
}

async function generatePaidReportPdf(report) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(renderPaidReportHtml(report), { waitUntil: 'networkidle0' });
    await page.emulateMediaType('print');
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  } finally {
    await browser.close();
  }
}

module.exports = { escapeHtml, generatePaidReportPdf, renderPaidReportHtml, reportFilename };
