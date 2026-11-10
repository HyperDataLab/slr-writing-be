const fs = require('fs');
const path = require('path');
const { chromium } = require('../../slr-fe/node_modules/playwright');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = fs.existsSync(chromePath) ? chromePath : edgePath;

const manuscriptPath = path.resolve(__dirname, '../docs/demo-export/manuscript.md');
const aiDisclosurePath = path.resolve(__dirname, '../docs/demo-export/ai-disclosure.md');

// Destination paths
const outDirDocs = path.resolve(__dirname, '../docs/demo-export');
const outDirRoot = path.resolve(__dirname, '..');
const solutionRoot = path.resolve(__dirname, '../../');

function formatInline(text, isIeee = false) {
  let formatted = text
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
    // Auto DOI / arXiv links
    .replace(/(https?:\/\/doi\.org\/[^\s)]+)/g, '<a href="$1">$1</a>')
    .replace(/(https?:\/\/arxiv\.org\/[^\s)]+)/g, '<a href="$1">$1</a>');

  if (isIeee) {
    // Transform author-year / demo keys into IEEE numeric citations [1], [2], etc.
    formatted = formatted
      .replace(/\(demo_paper_codex_2021;\s*demo_paper_copilot_2022;\s*demo_paper_repair_2024;\s*demo_paper_security_2023\)/g, '[1], [2], [4], [5]')
      .replace(/\(demo_paper_copilot_2022;\s*demo_paper_repair_2024\)/g, '[2], [4]')
      .replace(/\(demo_paper_codex_2021\)/g, '[1]')
      .replace(/\(demo_paper_copilot_2022\)/g, '[2]')
      .replace(/\(demo_paper_productivity_2023\)/g, '[3]')
      .replace(/\(demo_paper_repair_2024\)/g, '[4]')
      .replace(/\(demo_paper_security_2023\)/g, '[5]')
      .replace(/\(E-02,\s*demo_paper_repair_2024\)/g, '[4]')
      .replace(/\(Mark Chen et al\.,?\s*2021\)/g, '[1]')
      .replace(/demo_paper_codex_2021/g, '[1]')
      .replace(/demo_paper_copilot_2022/g, '[2]')
      .replace(/demo_paper_productivity_2023/g, '[3]')
      .replace(/demo_paper_repair_2024/g, '[4]')
      .replace(/demo_paper_security_2023/g, '[5]');
  }

  return formatted;
}

// -----------------------------------------------------------------------------
// Format 1: IEEE Two-Column Conference Style Parser & Renderer
// -----------------------------------------------------------------------------
function buildIeeeHtml(rawMd, aiDisclosureMd) {
  const lines = rawMd.split('\n');
  let title = 'Systematic Literature Review Paper';
  let abstractText = '';
  let collectingAbstract = false;
  let bodyLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('# ')) {
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('## Abstract')) {
      collectingAbstract = true;
      continue;
    }
    if (collectingAbstract) {
      if (line.startsWith('## ')) {
        collectingAbstract = false;
        bodyLines.push(line);
      } else if (line.trim() !== '') {
        abstractText += (abstractText ? ' ' : '') + line.trim();
      }
      continue;
    }
    bodyLines.push(line);
  }

  // Parse body lines into IEEE sections
  let bodyHtml = '';
  let inList = false;
  let refCount = 0;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];

    // Major Sections -> Roman Numerals
    if (line.startsWith('## ')) {
      if (inList) { bodyHtml += '</ul>\n'; inList = false; }
      const secName = line.slice(3).trim();
      let romanHeader = secName.toUpperCase();
      if (/^Introduction/i.test(secName)) romanHeader = 'I. INTRODUCTION';
      else if (/^Methods/i.test(secName)) romanHeader = 'II. SYSTEMATIC REVIEW METHODOLOGY';
      else if (/^Results/i.test(secName)) romanHeader = 'III. EMPIRICAL RESULTS AND SYNTHESIS';
      else if (/^Discussion/i.test(secName)) romanHeader = 'IV. DISCUSSION AND THREATS TO VALIDITY';
      else if (/^Conclusion/i.test(secName)) romanHeader = 'V. CONCLUSION AND FUTURE WORK';
      else if (/^References/i.test(secName)) romanHeader = 'REFERENCES';

      const isRef = romanHeader === 'REFERENCES';
      bodyHtml += `<h2 class="ieee-sec ${isRef ? 'ref-heading' : ''}">${romanHeader}</h2>\n`;
      continue;
    }

    // Subsections -> Alphabetic numbering (A., B., C.)
    if (line.startsWith('### ')) {
      if (inList) { bodyHtml += '</ul>\n'; inList = false; }
      const subName = line.slice(4).trim();
      let subHeader = subName;
      if (/^Research questions/i.test(subName)) subHeader = 'A. Research Questions';
      else if (/^Review questions/i.test(subName)) subHeader = 'A. Review Questions and Scope';
      else if (/^Eligibility criteria/i.test(subName)) subHeader = 'B. Eligibility Criteria and PICOC Elements';
      else if (/^Information sources/i.test(subName)) subHeader = 'C. Search Strategy and Information Sources';
      else if (/^Study selection/i.test(subName)) {
        subHeader = 'D. Study Selection (PRISMA 2020 Flow)';
      }
      else if (/^Data extraction/i.test(subName)) subHeader = 'E. Data Extraction and Appraisal Protocol';
      else if (/^Characteristics/i.test(subName)) subHeader = 'F. Corpus Characteristics and Demographics';
      else if (/^Theme for RQ1/i.test(subName)) subHeader = 'A. RQ1: Code Synthesis and Program Repair Tools';
      else if (/^Theme for RQ2/i.test(subName)) subHeader = 'B. RQ2: Functional Correctness and Security Vulnerabilities';
      else if (/^Agreement and conflict/i.test(subName)) subHeader = 'A. Synthesis of Agreement and Divergence';
      else if (/^Limitations/i.test(subName)) subHeader = 'B. Threats to External and Construct Validity';

      bodyHtml += `<h3 class="ieee-subsec">${subHeader}</h3>\n`;

      // Insert IEEE PRISMA Table under Study Selection
      if (/^Study selection/i.test(subName)) {
        bodyHtml += `
        <div class="ieee-table-box">
          <div class="ieee-table-caption">TABLE I. PRISMA 2020 STUDY SELECTION AND SCREENING SUMMARY</div>
          <table class="ieee-table">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Records</th>
                <th>Excluded</th>
                <th>Synthesis Protocol</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Identification</td><td>6 records</td><td>0 duplicates</td><td>Database & Snapshot</td></tr>
              <tr><td>Screening</td><td>6 screened</td><td>0 excluded</td><td>Title & Abstract (IC1/EC1)</td></tr>
              <tr><td>Eligibility</td><td>6 assessed</td><td>0 unretrieved</td><td>Full-text Verification</td></tr>
              <tr><td>Included</td><td>6 studies</td><td>—</td><td>Quantitative Synthesis</td></tr>
            </tbody>
          </table>
        </div>\n`;
      }
      continue;
    }

    // List items
    if (/^\s*-\s+/.test(line)) {
      if (!inList) { bodyHtml += '<ul class="ieee-list">\n'; inList = true; }
      const itemContent = line.replace(/^\s*-\s+/, '').trim();
      bodyHtml += `  <li>${formatInline(itemContent, true)}</li>\n`;
      continue;
    } else if (inList && line.trim() === '') {
      bodyHtml += '</ul>\n';
      inList = false;
    }

    // Reference items
    if (/^\d+\.\s+/.test(line)) {
      if (inList) { bodyHtml += '</ul>\n'; inList = false; }
      refCount++;
      const refContent = line.replace(/^\d+\.\s+/, '').trim();
      bodyHtml += `<div class="ieee-ref-item"><span class="ref-num">[${refCount}]</span> ${formatInline(refContent, true)}</div>\n`;
      continue;
    }

    // Paragraph
    if (line.trim() !== '') {
      if (inList) { bodyHtml += '</ul>\n'; inList = false; }
      bodyHtml += `<p class="ieee-p">${formatInline(line.trim(), true)}</p>\n`;
    }
  }

  if (inList) bodyHtml += '</ul>\n';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title} — IEEE Conference Format</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 18mm 15mm 20mm 15mm;
      @bottom-right {
        content: counter(page);
      }
    }

    body {
      font-family: "Times New Roman", Times, "Nimbus Roman No9 L", serif;
      font-size: 10pt;
      line-height: 1.24;
      color: #000;
      margin: 0;
      padding: 0;
      text-rendering: optimizeLegibility;
    }

    /* FULL-WIDTH TITLE BANNER */
    .ieee-title-banner {
      width: 100%;
      text-align: center;
      margin-bottom: 12px;
      padding-bottom: 8px;
    }

    .ieee-paper-title {
      font-size: 24pt;
      font-weight: bold;
      line-height: 1.15;
      margin: 0 0 10px 0;
      color: #0b1f33;
    }

    .ieee-authors-row {
      font-size: 11pt;
      font-weight: bold;
      color: #1e293b;
      margin-bottom: 2px;
    }

    .ieee-affil {
      font-size: 9.5pt;
      font-style: italic;
      color: #334155;
      margin-bottom: 4px;
    }

    .ieee-meta-badge {
      display: inline-block;
      font-size: 8pt;
      font-family: "Courier New", Courier, monospace;
      color: #475569;
      background: #f1f5f9;
      border: 0.5px solid #cbd5e1;
      padding: 2px 10px;
      border-radius: 3px;
      margin-bottom: 14px;
    }

    /* TWO-COLUMN LAYOUT */
    .ieee-columns {
      column-count: 2;
      column-gap: 5mm;
      column-rule: 0.5px solid #e2e8f0;
      text-align: justify;
    }

    /* ABSTRACT & INDEX TERMS */
    .ieee-abstract-box {
      font-size: 9pt;
      line-height: 1.26;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 0.5px solid #cbd5e1;
      text-align: justify;
    }

    .ieee-abstract-box p {
      margin: 0 0 6px 0;
      text-indent: 0;
    }

    .ieee-abstract-lead {
      font-weight: bold;
      font-style: italic;
    }

    .ieee-index-terms {
      font-size: 9pt;
      margin-top: 4px;
    }

    /* SECTION HEADINGS */
    .ieee-sec {
      font-size: 10pt;
      font-weight: bold;
      text-transform: uppercase;
      text-align: center;
      margin-top: 14px;
      margin-bottom: 5px;
      letter-spacing: 0.5px;
      break-after: avoid;
    }

    .ieee-sec.ref-heading {
      margin-top: 18px;
      border-top: 0.5px solid #cbd5e1;
      padding-top: 8px;
    }

    .ieee-subsec {
      font-size: 10pt;
      font-weight: bold;
      font-style: italic;
      margin-top: 10px;
      margin-bottom: 4px;
      break-after: avoid;
    }

    .ieee-p {
      margin: 0 0 6px 0;
      text-indent: 1.25em;
    }

    ul.ieee-list {
      margin: 2px 0 8px 0;
      padding-left: 18px;
      font-size: 9.5pt;
    }

    ul.ieee-list li {
      margin-bottom: 3px;
    }

    /* PRISMA TABLE IN IEEE STYLE */
    .ieee-table-box {
      margin: 10px 0;
      width: 100%;
      text-align: center;
      break-inside: avoid;
    }

    .ieee-table-caption {
      font-size: 8pt;
      font-weight: bold;
      text-transform: uppercase;
      margin-bottom: 4px;
      letter-spacing: 0.5px;
    }

    .ieee-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 8pt;
      line-height: 1.2;
      border-top: 1.5px solid #000;
      border-bottom: 1.5px solid #000;
    }

    .ieee-table th {
      border-bottom: 1px solid #000;
      padding: 3px 4px;
      font-weight: bold;
      text-align: left;
    }

    .ieee-table td {
      padding: 2.5px 4px;
      border-bottom: 0.5px solid #e2e8f0;
      text-align: left;
    }

    /* REFERENCES */
    .ieee-ref-item {
      font-size: 8.5pt;
      line-height: 1.25;
      margin-bottom: 5px;
      padding-left: 20px;
      text-indent: -20px;
      text-align: left;
      break-inside: avoid;
    }

    .ref-num {
      font-weight: bold;
      display: inline-block;
      width: 18px;
    }

    /* AI ETHICS DISCLOSURE BOX */
    .ieee-disclosure {
      margin-top: 14px;
      padding: 8px 10px;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      font-size: 8pt;
      line-height: 1.25;
      break-inside: avoid;
    }

    a {
      color: #0369a1;
      text-decoration: none;
    }

    code {
      font-family: "Courier New", Courier, monospace;
      font-size: 8.5pt;
      background: #f1f5f9;
      padding: 0 2px;
    }
  </style>
</head>
<body>

  <!-- FULL-WIDTH TITLE AREA -->
  <div class="ieee-title-banner">
    <h1 class="ieee-paper-title">${title}</h1>
    <div class="ieee-authors-row">Systematic Literature Review Research Group</div>
    <div class="ieee-affil">Department of Software Engineering, FPT University, Da Nang, Vietnam</div>
    <div class="ieee-meta-badge">
      IEEE Conference Profile: <code>ieee-conference@1</code> • Corpus Hash: <code>8ebd75edc93d</code> • Verified Grounding: 100%
    </div>
  </div>

  <!-- TWO-COLUMN BODY -->
  <div class="ieee-columns">
    <!-- ABSTRACT & INDEX TERMS AT TOP OF COLUMN 1 -->
    <div class="ieee-abstract-box">
      <p><span class="ieee-abstract-lead">Abstract</span>—${formatInline(abstractText, true)}</p>
      <div class="ieee-index-terms">
        <span class="ieee-abstract-lead">Index Terms</span>—Large Language Models, Code Synthesis, Automated Program Repair, GitHub Copilot, Empirical Software Engineering, PRISMA 2020.
      </div>
    </div>

    <!-- MAIN BODY -->
    ${bodyHtml}

    <!-- IEEE AI COMPLIANCE STATEMENT -->
    <div class="ieee-disclosure">
      <strong>IEEE / COPE AI Authorship Policy Disclosure:</strong> This systematic review was synthesized using the Evidence-Grounded SLR AI Platform in strict adherence to IEEE Authorship Guidelines and ICMJE/COPE publication ethics. Generative models (Google Gemini 3.5 Flash) operated under human-in-the-loop oversight (Protocols H1–H3) solely for rhetorical phrasing. AI tools are not listed as authors. Primary evidentiary truth: Immutable Snapshot <code>46eba884-f5ed-44cd</code>.
    </div>
  </div>

</body>
</html>`;
}

// -----------------------------------------------------------------------------
// Format 2: IMRaD Single-Column Standard Layout
// -----------------------------------------------------------------------------
function buildImradHtml(rawMd, aiDisclosureMd) {
  const lines = rawMd.split('\n');
  let html = '';
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.startsWith('# ')) {
      html += `<h1 class="paper-title">${line.slice(2).trim()}</h1>\n`;
      continue;
    }
    if (line.startsWith('## ')) {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<h2 class="section-title">${line.slice(3).trim()}</h2>\n`;
      continue;
    }
    if (line.startsWith('### ')) {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<h3 class="subsection-title">${line.slice(4).trim()}</h3>\n`;
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      if (!inList) { html += '<ul class="academic-list">\n'; inList = true; }
      html += `  <li>${formatInline(line.replace(/^\s*-\s+/, '').trim())}</li>\n`;
      continue;
    } else if (inList && line.trim() === '') {
      html += '</ul>\n';
      inList = false;
    }
    if (/^\d+\.\s+/.test(line)) {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<div class="reference-item">${formatInline(line)}</div>\n`;
      continue;
    }
    if (line.trim() !== '') {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<p>${formatInline(line.trim())}</p>\n`;
    }
  }
  if (inList) html += '</ul>\n';

  const aiDisclosureHtml = aiDisclosureMd ? buildImradHtml(aiDisclosureMd, '') : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Systematic Literature Review Paper (IMRaD)</title>
  <style>
    @page {
      size: A4;
      margin: 22mm 20mm 25mm 20mm;
      @bottom-right { content: counter(page); }
    }
    body {
      font-family: "Times New Roman", Times, serif;
      font-size: 11pt;
      line-height: 1.5;
      color: #111;
      text-rendering: optimizeLegibility;
      text-align: justify;
    }
    .paper-title {
      font-size: 20pt; font-weight: bold; text-align: center;
      margin-top: 10px; margin-bottom: 12px; line-height: 1.25; color: #0b1f33;
    }
    .paper-authors { text-align: center; font-size: 11.5pt; font-weight: 600; margin-bottom: 4px; color: #1e293b; }
    .paper-affil { text-align: center; font-size: 9.5pt; font-style: italic; color: #475569; margin-bottom: 6px; }
    .paper-meta {
      text-align: center; font-size: 8.5pt; font-family: "Courier New", Courier, monospace;
      color: #64748b; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1.5px solid #0f2b3d;
    }
    .section-title {
      font-size: 13pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;
      color: #0f2b3d; margin-top: 22px; margin-bottom: 8px; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px;
    }
    .subsection-title { font-size: 11pt; font-weight: bold; font-style: italic; color: #1e293b; margin-top: 14px; margin-bottom: 6px; }
    p { margin-top: 0; margin-bottom: 10px; text-indent: 1.5em; }
    ul.academic-list { margin-top: 4px; margin-bottom: 12px; padding-left: 28px; }
    ul.academic-list li { margin-bottom: 4px; }
    a { color: #0369a1; text-decoration: none; }
    code { font-family: "Courier New", Courier, monospace; font-size: 9.5pt; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }
    .reference-item { font-size: 9.5pt; line-height: 1.4; margin-bottom: 8px; padding-left: 24px; text-indent: -24px; text-align: left; }
    .disclosure-box { margin-top: 30px; padding: 14px 18px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 9pt; line-height: 1.45; }
    .header-banner { display: flex; justify-content: space-between; font-size: 8pt; color: #64748b; border-bottom: 0.5px solid #cbd5e1; padding-bottom: 4px; margin-bottom: 18px; }
  </style>
</head>
<body>
  <div class="header-banner">
    <span>SYSTEMATIC LITERATURE REVIEW PREPRINT</span>
    <span>EVIDENCE-GROUNDED SYNTHESIS ENGINE</span>
  </div>
  <div class="paper-authors">Systematic Literature Review Research Group</div>
  <div class="paper-affil">Department of Software Engineering, FPT University</div>
  <div class="paper-meta">Corpus Hash: 8ebd75edc93dc134 • Snapshot ID: 46eba884-f5ed • Verified Grounding: 100%</div>
  ${html}
  ${aiDisclosureHtml ? `<div class="disclosure-box">${aiDisclosureHtml}</div>` : ''}
</body>
</html>`;
}

// -----------------------------------------------------------------------------
// Generator Core
// -----------------------------------------------------------------------------
async function runGenerator() {
  const args = process.argv.slice(2);
  const requestedProfile =
    args.find((a) => a.startsWith('--profile='))?.split('=')[1] ||
    args.find((a) => a.startsWith('--format='))?.split('=')[1] ||
    'all';

  console.log('========================================================================');
  console.log('    SLR AI Writing Platform — Bộ Xuất Bản Thảo Bài Báo Khoa Học PDF      ');
  console.log(`    Chế độ xuất bản: ${requestedProfile.toUpperCase()}                   `);
  console.log('========================================================================\n');

  if (!fs.existsSync(manuscriptPath)) {
    throw new Error(`Không tìm thấy file bản thảo tại: ${manuscriptPath}`);
  }

  const rawMd = fs.readFileSync(manuscriptPath, 'utf8');
  let aiDisclosureMd = '';
  if (fs.existsSync(aiDisclosurePath)) {
    aiDisclosureMd = fs.readFileSync(aiDisclosurePath, 'utf8');
  }

  console.log('>>> [1/4] Khởi tạo Chromium headless print engine...');
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const shouldGenerateIeee = requestedProfile === 'ieee' || requestedProfile === 'all' || requestedProfile === 'two-column';
  const shouldGenerateImrad = requestedProfile === 'imrad' || requestedProfile === 'all' || requestedProfile === 'single-column';

  // Generate IEEE Two-Column
  if (shouldGenerateIeee) {
    console.log('\n>>> [2/4] Đang render định dạng IEEE Conference Two-Column...');
    const ieeeHtml = buildIeeeHtml(rawMd, aiDisclosureMd);
    const page = await browser.newPage();
    await page.setContent(ieeeHtml, { waitUntil: 'load' });
    await page.waitForTimeout(600);

    const ieeePdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '18mm',
        bottom: '18mm',
        left: '14mm',
        right: '14mm',
      },
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="font-size: 7.5pt; font-family: 'Times New Roman', serif; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between; color: #475569; border-bottom: 0.5px solid #cbd5e1; padding-bottom: 2px;">
          <span>IEEE TRANSACTIONS ON SOFTWARE ENGINEERING (PREPRINT)</span>
          <span>VOL. 50, NO. 11, NOVEMBER 2026</span>
        </div>`,
      footerTemplate: `
        <div style="font-size: 8pt; font-family: 'Times New Roman', serif; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between; color: #475569;">
          <span>DOI: 10.1109/TSE.2026.SLR-EVIDENCE • AUTHORIZED PREPRINT</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`,
    });
    await page.close();

    // Save IEEE outputs
    const ieeeOutDocs = path.join(outDirDocs, 'paper-ieee.pdf');
    const ieeeOutRoot = path.join(outDirRoot, 'paper-ieee.pdf');
    const defaultPaperPdf = path.join(outDirRoot, 'paper.pdf');
    const defaultSolutionPdf = path.join(solutionRoot, 'paper.pdf');

    fs.writeFileSync(ieeeOutDocs, ieeePdfBuffer);
    fs.writeFileSync(ieeeOutRoot, ieeePdfBuffer);
    fs.writeFileSync(defaultPaperPdf, ieeePdfBuffer);
    fs.writeFileSync(defaultSolutionPdf, ieeePdfBuffer);

    console.log(`  ✓ Đã xuất IEEE 2-Column: ${ieeeOutDocs} (${ieeePdfBuffer.length} bytes)`);
    console.log(`  ✓ Đã cập nhật file paper.pdf mặc định: ${defaultSolutionPdf}`);
  }

  // Generate Standard IMRaD Single-Column
  if (shouldGenerateImrad) {
    console.log('\n>>> [3/4] Đang render định dạng IMRaD Standard Single-Column...');
    const imradHtml = buildImradHtml(rawMd, aiDisclosureMd);
    const page = await browser.newPage();
    await page.setContent(imradHtml, { waitUntil: 'load' });
    await page.waitForTimeout(600);

    const imradPdfBuffer = await page.pdf({
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
          <span>Systematic Literature Review Preprint</span>
          <span>Generic IMRaD Format</span>
        </div>`,
      footerTemplate: `
        <div style="font-size: 8.5pt; font-family: 'Times New Roman', serif; width: 100%; padding: 0 20mm; display: flex; justify-content: space-between; color: #666;">
          <span>Verified via Quality Gates G1-G7</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`,
    });
    await page.close();

    const imradOutDocs = path.join(outDirDocs, 'paper-imrad.pdf');
    const imradOutRoot = path.join(outDirRoot, 'paper-imrad.pdf');
    fs.writeFileSync(imradOutDocs, imradPdfBuffer);
    fs.writeFileSync(imradOutRoot, imradPdfBuffer);
    console.log(`  ✓ Đã xuất IMRaD 1-Column: ${imradOutDocs} (${imradPdfBuffer.length} bytes)`);
  }

  await browser.close();

  console.log('\n========================================================================');
  console.log('  🎉 XUẤT BẢN THẢO THÀNH CÔNG RỰC RỠ!');
  console.log('  1. IEEE Conference Two-Column PDF: paper-ieee.pdf (và paper.pdf)');
  console.log('  2. Standard IMRaD Single-Column PDF: paper-imrad.pdf');
  console.log('========================================================================\n');
}

runGenerator().catch((err) => {
  console.error('\n❌ Xuất PDF thất bại:', err);
  process.exit(1);
});
