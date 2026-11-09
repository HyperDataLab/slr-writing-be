import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * SLR AI Writing Engine - Live End-to-End HTTP Smoke Test
 *
 * Exercises the entire manuscript generation pipeline against a running backend (default :5100)
 * and running SLR backend (default :5000), using live Google Gemini API for section drafting.
 *
 * Usage:
 *   npx tsx src/scripts/live-http-smoke.ts
 *
 * Optional environment variables:
 *   BE_URL   (default: http://localhost:5100)
 *   SLR_URL  (default: http://localhost:5000)
 *   AUTH_USER (default: dev_user)
 */

const BE_URL = process.env.BE_URL || 'http://localhost:5100';
const SLR_URL = process.env.SLR_URL || 'http://localhost:5000';
const AUTH_USER = process.env.AUTH_USER || 'dev_user';
const HEADERS = {
  Authorization: `Bearer ${AUTH_USER}`,
  'Content-Type': 'application/json',
};

async function req<T = any>(
  endpoint: string,
  options: { method?: string; body?: any; baseUrl?: string; expectStatus?: number } = {}
): Promise<T> {
  const baseUrl = options.baseUrl ?? BE_URL;
  const url = `${baseUrl}${endpoint}`;
  const method = options.method || 'GET';
  const expectStatus = options.expectStatus || 200;

  const init: RequestInit = {
    method,
    headers: HEADERS,
  };
  if (options.body) {
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, init);
  if (res.status !== expectStatus && !(expectStatus === 200 && (res.status === 200 || res.status === 201))) {
    const errorBody = await res.text();
    throw new Error(`HTTP ${method} ${url} failed with status ${res.status} (expected ${expectStatus}): ${errorBody}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = (await res.json()) as any;
    return (json.data !== undefined ? json.data : json) as T;
  }
  return (await res.text()) as unknown as T;
}

async function runLiveHttpSmokeTest() {
  console.log('========================================================================');
  console.log('       SLR AI Writing Platform — Live Real-Server Smoke Test            ');
  console.log('========================================================================');
  console.log(`Target Backend: ${BE_URL}`);
  console.log(`SLR Mock/BE:   ${SLR_URL}`);
  console.log(`Auth Actor:     ${AUTH_USER}\n`);

  // --------------------------------------------------------------------------
  // Check Connectivity
  // --------------------------------------------------------------------------
  console.log('>>> [Stage 1/11] Checking Server Connectivity...');
  try {
    const beHealth = await req('/health');
    console.log(`  ✓ Backend Health: ${JSON.stringify(beHealth)}`);
  } catch (err: any) {
    throw new Error(`Backend on ${BE_URL} is unreachable. Ensure 'node dist/server.js' is running. Details: ${err.message}`);
  }

  let slrProjectId = 'proj_slr_artifacts_demo';
  try {
    const slrProjects = await req('/api/projects', { baseUrl: SLR_URL });
    const list = slrProjects.items || slrProjects;
    if (Array.isArray(list) && list.length > 0) {
      slrProjectId = list[0].id || slrProjectId;
    }
    console.log(`  ✓ SLR Server reachable. Using SLR Project ID: ${slrProjectId}`);
  } catch (err: any) {
    console.warn(`  ⚠ SLR server check on ${SLR_URL} returned error, proceeding with default '${slrProjectId}': ${err.message}`);
  }

  // --------------------------------------------------------------------------
  // Create Writing Project
  // --------------------------------------------------------------------------
  console.log('\n>>> [Stage 2/11] Creating Writing Project...');
  const projectTag = `live-smoke-${Date.now()}`;
  const project = await req('/api/projects', {
    method: 'POST',
    body: {
      name: `Live Smoke Project (${projectTag})`,
      slrProjectId,
    },
    expectStatus: 201,
  });
  console.log(`  ✓ Project Created: ID=${project.id}, Name="${project.name}"`);

  // --------------------------------------------------------------------------
  // Import Snapshot from SLR Backend
  // --------------------------------------------------------------------------
  console.log('\n>>> [Stage 3/11] Importing Snapshot from SLR Backend...');
  const runs = await req(`/api/projects/${slrProjectId}/runs`, { baseUrl: SLR_URL });
  const runList = runs.items || runs;
  const runId = runList[0]?.id || 'run-20261030101014-gbekjc';
  console.log(`  ✓ Discovered completed SLR run: ${runId}`);

  const snapshotImport = await req(`/api/projects/${project.id}/snapshots/from-slr`, {
    method: 'POST',
    body: { runId },
    expectStatus: 201,
  });
  const snapshotId = snapshotImport.id;
  console.log(`  ✓ Snapshot Imported: ID=${snapshotId}, CorpusHash=${snapshotImport.corpusHash}`);

  // Base path for manuscript operations
  const msBase = `/api/projects/${project.id}/snapshots/${snapshotId}/manuscript`;

  // --------------------------------------------------------------------------
  // Generate Methods (Layered Deterministic Engine)
  // --------------------------------------------------------------------------
  console.log('\n>>> [Stage 4/11] Generating Methods Section (3-Layer Deterministic Engine)...');
  const methods = await req(`${msBase}/methods`, { method: 'POST', expectStatus: 201 });
  console.log(`  ✓ Methods Section: v${methods.version}, Hash=${methods.contentHash?.slice(0, 16)}... (${methods.markdown?.length || 0} chars)`);

  // --------------------------------------------------------------------------
  // Generate Blueprint & H1 Human Approval
  // --------------------------------------------------------------------------
  console.log('\n>>> [Stage 5/11] Generating Blueprint & Approving H1 Checkpoint...');
  const blueprintBase = `/api/projects/${project.id}/snapshots/${snapshotId}/blueprint`;
  const blueprint = await req(blueprintBase, {
    method: 'POST',
    body: { profileId: 'generic-imrad' },
    expectStatus: 201,
  });
  console.log(`  ✓ Blueprint Generated: v${blueprint.version}, Profile=${blueprint.profileId}`);

  const h1Res = await req(`${blueprintBase}/approve`, {
    method: 'POST',
    body: {
      version: blueprint.version,
      decision: 'APPROVED',
      note: 'H1 Blueprint approved by Owner in live smoke test',
    },
  });
  console.log(`  ✓ H1 Approval: Decision=${h1Res.approval?.decision || h1Res.decision}, Seq=${h1Res.approval?.seq || h1Res.seq}`);

  // --------------------------------------------------------------------------
  // Generate Paragraph Plans
  // --------------------------------------------------------------------------
  console.log('\n>>> [Stage 6/11] Generating Paragraph Plans & Evidence Allocation...');
  const plans = await req(`/api/projects/${project.id}/snapshots/${snapshotId}/paragraph-plans`, {
    method: 'POST',
    expectStatus: 201,
  });
  console.log(`  ✓ Paragraph Plans: v${plans.version}, Total=${plans.totalParagraphs}, Ready=${plans.readyParagraphs}`);

  // --------------------------------------------------------------------------
  // Draft Core Sections with Real Gemini API & Approve H2
  // --------------------------------------------------------------------------
  console.log('\n>>> [Stage 7/11] Drafting Core Sections with Live Gemini API & H2 Approval...');
  const coreSections = ['introduction', 'results', 'discussion'];
  for (const sectionKey of coreSections) {
    console.log(`  • Drafting section: '${sectionKey}' via Gemini... (may pace requests)`);
    const draft = await req(`${msBase}/sections/${sectionKey}/draft`, {
      method: 'POST',
      body: {},
      expectStatus: 201,
    });
    console.log(`    ✓ Drafted '${sectionKey}' v${draft.version}: Hash=${draft.contentHash?.slice(0, 16)}...`);

    const approve = await req(`${msBase}/sections/${sectionKey}/approve`, {
      method: 'POST',
      body: {
        version: draft.version,
        decision: 'APPROVED',
        note: `H2 approved for ${sectionKey} via live smoke test`,
      },
    });
    console.log(`    ✓ H2 Approved: Decision=${approve.decision}, Seq=${approve.seq}`);
  }

  // --------------------------------------------------------------------------
  // Draft Synthesis Sections (Abstract & Conclusion) & Approve H2
  // --------------------------------------------------------------------------
  console.log('\n>>> [Stage 8/11] Drafting Synthesis Sections (Conclusion & Abstract) with Live Gemini...');
  const synthSections = ['conclusion', 'abstract'];
  for (const sectionKey of synthSections) {
    console.log(`  • Drafting synthesis section: '${sectionKey}' via Gemini...`);
    const synth = await req(`${msBase}/synthesis/${sectionKey}`, {
      method: 'POST',
      body: {},
      expectStatus: 201,
    });
    console.log(`    ✓ Drafted '${sectionKey}' v${synth.version}: Hash=${synth.contentHash?.slice(0, 16)}...`);

    const approve = await req(`${msBase}/synthesis/${sectionKey}/approve`, {
      method: 'POST',
      body: {
        version: synth.version,
        decision: 'APPROVED',
        note: `H2 approved for ${sectionKey} via live smoke test`,
      },
    });
    console.log(`    ✓ H2 Approved: Decision=${approve.decision}, Seq=${approve.seq}`);
  }

  // --------------------------------------------------------------------------
  // Run Quality Gates Verification (G1–G7)
  // --------------------------------------------------------------------------
  console.log('\n>>> [Stage 9/11] Running Quality Gates Verification Engine (G1–G7)...');
  const verif = await req(`${msBase}/verification/run`, {
    method: 'POST',
    body: {},
    expectStatus: 201,
  });
  const summary = verif.summary;
  console.log(`  ✓ Verification Report: v${verif.version}, Status=${verif.status}`);
  console.log(`  ✓ Gates Passed: ${summary.passed}/${summary.totalGates}, Warnings: ${summary.warnings}, Blocking: ${summary.blockingIssues}`);

  if (summary.blockingIssues > 0) {
    throw new Error(`Verification failed with ${summary.blockingIssues} blocking issues! Cannot proceed to H3.`);
  }

  // --------------------------------------------------------------------------
  // H3 Final Human Approval
  // --------------------------------------------------------------------------
  console.log('\n>>> [Stage 10/11] Checking Prerequisites & Approving H3 Final Checkpoint...');
  const h3Status = await req(`${msBase}/final/status`);
  console.log(`  ✓ Can Approve H3: ${h3Status.canApprove}`);
  if (!h3Status.canApprove) {
    throw new Error(`Cannot approve H3: ${JSON.stringify(h3Status.blockingReasons)}`);
  }

  const h3Approve = await req(`${msBase}/final/approve`, {
    method: 'POST',
    body: {
      note: 'H3 Final Manuscript Approval via Automated Live Smoke Test',
    },
  });
  console.log(`  ✓ H3 Approved: Decision=${h3Approve.decision}, Stage=${h3Approve.stage}, Seq=${h3Approve.seq}`);

  // --------------------------------------------------------------------------
  // Export Submission Package & Download ZIP
  // --------------------------------------------------------------------------
  console.log('\n>>> [Stage 11/11] Exporting Submission Package & Verifying ZIP Download...');
  const exportPkg = await req(`${msBase}/export`, {
    method: 'POST',
    body: {},
    expectStatus: 201,
  });
  console.log(`  ✓ Export Package Created: v${exportPkg.version}, PackageHash=${exportPkg.packageHash?.slice(0, 16)}...`);
  console.log(`  ✓ Package Manifest: ${exportPkg.manifest?.length} immutable files`);

  const downloadUrl = `${BE_URL}${msBase}/export/download`;
  const zipRes = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${AUTH_USER}` } });
  if (!zipRes.ok) {
    throw new Error(`Failed to download zip: HTTP ${zipRes.status}`);
  }
  const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
  console.log(`  ✓ Downloaded ZIP Archive: ${zipBuffer.length} bytes`);

  const outDir = resolve(process.cwd(), 'dist/live-smoke-export');
  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, 'submission-package.zip');
  writeFileSync(zipPath, zipBuffer);
  console.log(`  ✓ Saved ZIP to: ${zipPath}`);

  // Unpack files
  let offset = 0;
  let fileCount = 0;
  while (offset < zipBuffer.length - 22) {
    const sig = zipBuffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;

    const method = zipBuffer.readUInt16LE(offset + 8);
    const compSize = zipBuffer.readUInt32LE(offset + 18);
    const filenameLen = zipBuffer.readUInt16LE(offset + 26);
    const extraLen = zipBuffer.readUInt16LE(offset + 28);

    const fName = zipBuffer.toString('utf8', offset + 30, offset + 30 + filenameLen);
    const dataStart = offset + 30 + filenameLen + extraLen;
    const compData = zipBuffer.subarray(dataStart, dataStart + compSize);
    const uncomp = method === 8 ? inflateRawSync(compData) : compData;

    writeFileSync(join(outDir, fName), uncomp);
    console.log(`    -> Unpacked: ${fName.padEnd(26)} (${uncomp.length} bytes)`);
    fileCount++;
    offset = dataStart + compSize;
  }

  console.log('\n========================================================================');
  console.log(`  🎉 LIVE END-TO-END SMOKE TEST PASSED COMPLETELY! (${fileCount} files verified) `);
  console.log('========================================================================\n');
}

runLiveHttpSmokeTest().catch((err) => {
  console.error('\n❌ Live Smoke Test Failed:', err);
  process.exit(1);
});
