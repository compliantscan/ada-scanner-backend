const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

function buildPdfReport(scan, url) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(24).text('ADA Accessibility Scan Report', { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(12).fillColor('#333');
    doc.text(`URL: ${url}`);
    doc.text(`Total violations: ${scan.summary.totalViolations}`);
    doc.text(`Passes: ${scan.summary.passes}`);
    doc.text(`Incomplete: ${scan.summary.incomplete}`);
    doc.moveDown(1);
    doc.text('Severity breakdown:', { underline: true });
    Object.entries(scan.violationsBySeverity || {}).forEach(([severity, count]) => {
      doc.text(`- ${severity.charAt(0).toUpperCase() + severity.slice(1)}: ${count}`);
    });
    doc.addPage();
    doc.fontSize(18).text('Top Violations', { underline: true });
    doc.moveDown(0.5);

    (scan.violations || []).slice(0, 10).forEach((violation, index) => {
      doc.fontSize(14).fillColor('#1f2937').text(`${index + 1}. ${violation.id}`);
      doc.fontSize(12).fillColor('#111827').text(`Impact: ${violation.impact}`);
      doc.text(`Description: ${violation.description}`);
      doc.text(`Why it matters: ${violation.help}`);
      doc.text(`Affected elements: ${violation.affectedElements}`);
      if (violation.nodes && violation.nodes.length) {
        doc.text(`Example HTML: ${violation.nodes[0].html}`);
      }
      doc.moveDown(1);
    });

    doc.end();
  });
}

async function createMailTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = process.env.SMTP_SECURE === 'true';

  if (!host || !user || !pass) {
    throw new Error('SMTP configuration is missing. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in environment variables.');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

async function sendReportEmail(email, scan, url) {
  const transporter = await createMailTransport();
  const pdfBuffer = await buildPdfReport(scan, url);
  const from = process.env.EMAIL_FROM || `no-reply@${process.env.SMTP_HOST || 'localhost'}`;

  const mailOptions = {
    from,
    to: email,
    subject: 'Your ADA scan report',
    text: `Attached is your ADA accessibility scan report for ${url}.`,
    html: `<p>Thanks for scanning ${url}. Attached is your ADA accessibility report.</p>`,
    attachments: [
      {
        filename: 'ada-scan-report.pdf',
        content: pdfBuffer,
      },
    ],
  };

  const info = await transporter.sendMail(mailOptions);
  return info;
}

module.exports = {
  buildPdfReport,
  sendReportEmail,
};
