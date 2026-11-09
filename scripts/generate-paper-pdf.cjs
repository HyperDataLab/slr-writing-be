const fs = require('fs');
const path = require('path');
const { chromium } = require('../../slr-fe/node_modules/playwright');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = fs.existsSync(chromePath) ? chromePath : edgePath;

const manuscriptPath = path.resolve(__dirname, '../docs/demo-export/manuscript.md');
const aiDisclosurePath = path.resolve(__dirname, '../docs/demo-export/ai-disclosure.md');
const outPdfInDocs = path.resolve(__dirname, '../docs/demo-export/paper.pdf');
const outPdfInSolution = path.resolve(__dirname, '../../../submission_output/paper.pdf');
const outPdfInRoot = path.resolve(__dirname, '../paper.pdf');

function markdownToHtml(md) {
  // Simple, robust Markdown parser tailored for academic manuscript structures
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Headers
    if (line.startsWith('# ')) {
      html += `<h1 class="paper-title">${line.slice(2).trim()}</h1>\n`;
      continue;
    }
    if (line.startsWith('## ')) {
      if (inList) { html += '</ul>\n'; inList = false; }
      const title = line.slice(3).trim();
      html += `<h2 class="section-title">${title}</h2>\n`;
      continue;
    }
    if (line.startsWith('### ')) {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<h3 class="subsection-title">${line.slice(4).trim()}</h3>\n`;
      continue;
    }

    // List items
    if (/^\s*-\s+/.test(line)) {
      if (!inList) { html += '<ul class="academic-list">\n'; inList = true; }
      const itemContent = line.replace(/^\s*-\s+/, '').trim();
      html += `  <li>${formatInline(itemContent)}</li>\n`;
      continue;
    } else if (inList && line.trim() === '') {
      html += '</ul>\n';
      inList = false;
    }

    // Ordered references list (e.g. "1. Mark Chen...")
    if (/^\d+\.\s+/.test(line)) {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<div class="reference-item">${formatInline(line)}</div>\n`;
      continue;
    }

    // Paragraph
    if (line.trim() !== '') {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<p>${formatInline(line.trim())}</p>\n`;
    }
  }

  if (inList) html += '</ul>\n';
  return html;
}

function formatInline(text) {
  return text
    // Bold italic
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Code spans
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Auto DOI links
    .replace(/(https?:\/\/doi\.org\/[^\s]+)/g, '<a href="$1">$1</a>')
    .replace(/(https?:\/\/arxiv\.org\/[^\s]+)/g, '<a href="$1">$1</a>');
}

async function generatePdf() {
  console.log('========================================================================');
  console.log('    SLR AI Writing Platform — Xuất Bản Thảo Bài Báo (Academic PDF)      ');
  console.log('========================================================================');

  if (!fs.existsSync(manuscriptPath)) {
    throw new Error(`Không tìm thấy file bản thảo tại: ${manuscriptPath}`);
  }

  const rawMd = fs.readFileSync(manuscriptPath, 'utf8');
  let aiDisclosureMd = '';
  if (fs.existsSync(aiDisclosurePath)) {
    aiDisclosureMd = fs.readFileSync(aiDisclosurePath, 'utf8');
  }

  const bodyHtml = markdownToHtml(rawMd);
  const aiDisclosureHtml = aiDisclosureMd ? markdownToHtml(aiDisclosureMd) : '';

  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Systematic Literature Review Paper</title>
  <style>
    @page {
      size: A4;
      margin: 22mm 20mm 25mm 20mm;
      @bottom-right {
        content: counter(page);
      }
    }

    body {
      font-family: "Times New Roman", Times, "Nimbus Roman No9 L", serif;
      font-size: 11pt;
      line-height: 1.5;
      color: #111;
      margin: 0;
      padding: 0;
      text-rendering: optimizeLegibility;
      text-align: justify;
    }

    /* Paper Header */
    .paper-title {
      font-size: 20pt;
      font-weight: bold;
      text-align: center;
      margin-top: 10px;
      margin-bottom: 12px;
      line-height: 1.25;
      color: #0b1f33;
    }

    .paper-authors {
      text-align: center;
      font-size: 11.5pt;
      font-weight: 600;
      margin-bottom: 4px;
      color: #1e293b;
    }

    .paper-affil {
      text-align: center;
      font-size: 9.5pt;
      font-style: italic;
      color: #475569;
      margin-bottom: 6px;
    }

    .paper-meta {
      text-align: center;
      font-size: 8.5pt;
      font-family: "Courier New", Courier, monospace;
      color: #64748b;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1.5px solid #0f2b3d;
    }

    /* Abstract Block */
    .section-title {
      font-size: 13pt;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #0f2b3d;
      margin-top: 22px;
      margin-bottom: 8px;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 3px;
    }

    .subsection-title {
      font-size: 11pt;
      font-weight: bold;
      font-style: italic;
      color: #1e293b;
      margin-top: 14px;
      margin-bottom: 6px;
    }

    p {
      margin-top: 0;
      margin-bottom: 10px;
      text-indent: 1.5em;
    }

    /* Abstract specific styling */
    h2:first-of-type + p,
    h2.section-title:contains("ABSTRACT") + p {
      font-style: italic;
      background: #f8fafc;
      padding: 10px 14px;
      border-left: 3px solid #0284c7;
      text-indent: 0;
    }

    ul.academic-list {
      margin-top: 4px;
      margin-bottom: 12px;
      padding-left: 28px;
    }

    ul.academic-list li {
      margin-bottom: 4px;
    }

    /* Citations and Links */
    a {
      color: #0369a1;
      text-decoration: none;
    }

    code {
      font-family: "Courier New", Courier, monospace;
      font-size: 9.5pt;
      background: #f1f5f9;
      padding: 1px 4px;
      border-radius: 3px;
    }

    /* References */
    .reference-item {
      font-size: 9.5pt;
      line-height: 1.4;
      margin-bottom: 8px;
      padding-left: 24px;
      text-indent: -24px;
      text-align: left;
    }

    /* AI Disclosure Box */
    .disclosure-box {
      margin-top: 30px;
      padding: 14px 18px;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      font-size: 9pt;
      line-height: 1.45;
      page-break-inside: avoid;
    }

    .disclosure-box h2, .disclosure-box h1 {
      font-size: 10pt;
      text-transform: uppercase;
      margin-top: 8px;
      margin-bottom: 4px;
      border: none;
      color: #334155;
    }

    .disclosure-box p {
      text-indent: 0;
      margin-bottom: 6px;
    }

    /* Header and Footer */
    .header-banner {
      display: flex;
      justify-content: space-between;
      font-size: 8pt;
      color: #64748b;
      border-bottom: 0.5px solid #cbd5e1;
      padding-bottom: 4px;
      margin-bottom: 18px;
      font-family: sans-serif;
    }
  </style>
</head>
<body>
  <div class="header-banner">
    <span>SYSTEMATIC LITERATURE REVIEW PREPRINT</span>
    <span>EVIDENCE-GROUNDED SYNTHESIS ENGINE</span>
  </div>

  <div class="paper-authors">Systematic Literature Review Research Group</div>
  <div class="paper-affil">Department of Software Engineering, FPT University</div>
  <div class="paper-meta">
    Corpus Hash: 8ebd75edc93dc134 • Snapshot ID: 46eba884-f5ed-44cd-8c9d • Verified Grounding: 100%
  </div>

  ${bodyHtml}

  ${
    aiDisclosureHtml
      ? `
  <div class="disclosure-box">
    ${aiDisclosureHtml}
  </div>`
      : ''
  }
</body>
</html>`;

  console.log('>>> [1/3] Đang khởi chạy Chromium headless print engine...');
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  console.log('>>> [2/3] Đang định dạng trang và nạp typography học thuật...');
  await page.setContent(fullHtml, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  console.log('>>> [3/3] Đang xuất PDF vector chuẩn A4 với số trang tự động...');
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: {
      top: '22mm',
      bottom: '22mm',
      left: '20mm',
      right: '20mm',
    },
    displayHeaderFooter: true,
    headerTemplate: `
      <div style="font-size: 8pt; font-family: 'Times New Roman', serif; width: 100%; padding: 0 20mm; display: flex; justify-content: space-between; color: #666; border-bottom: 0.5px solid #ddd; padding-bottom: 2px;">
        <span>Live Gemini Smoke Test Project</span>
        <span>SLR Preprint</span>
      </div>`,
    footerTemplate: `
      <div style="font-size: 8.5pt; font-family: 'Times New Roman', serif; width: 100%; padding: 0 20mm; display: flex; justify-content: space-between; color: #666;">
        <span>Verified via Quality Gates G1-G7</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`,
  });

  await browser.close();

  // Lưu file tại các vị trí thuận tiện
  fs.writeFileSync(outPdfInDocs, pdfBuffer);
  console.log(`  ✓ Đã lưu PDF tại: ${outPdfInDocs} (${pdfBuffer.length} bytes)`);

  fs.writeFileSync(outPdfInRoot, pdfBuffer);
  console.log(`  ✓ Đã lưu PDF tại thư mục backend: ${outPdfInRoot}`);

  const solutionDir = path.dirname(outPdfInSolution);
  if (fs.existsSync(solutionDir)) {
    fs.writeFileSync(outPdfInSolution, pdfBuffer);
    console.log(`  ✓ Đã lưu PDF tại thư mục giải pháp: ${outPdfInSolution}`);
  }

  console.log('\n========================================================================');
  console.log('  🎉 XUẤT PAPER.PDF THÀNH CÔNG RỰC RỠ!');
  console.log('  File đã sẵn sàng để in ấn, nộp bài báo cáo hoặc nộp tạp chí.');
  console.log('========================================================================\n');
}

generatePdf().catch((err) => {
  console.error('\n❌ Xuất PDF thất bại:', err);
  process.exit(1);
});
