import { createHash } from 'node:crypto';
import { createZipArchive, type ZipEntry } from '../../shared/utils/zip.js';
import type { ExportManifestItem, LineageItem } from './export.types.js';

export interface AssembleBundleParams {
  manuscriptId: string;
  snapshot: {
    id: string;
    title: string;
    runId: string;
    slrProjectId: string;
    corpusHash: string;
    integrityHash: string;
    studies: Array<{
      id: string;
      externalId: string;
      title: string;
      authors: string[];
      year: number | null;
      doi: string | null;
      venue: string | null;
    }>;
  };
  journalProfile: {
    id: string;
    version: number;
    name: string;
    sections: Array<{ key: string; order: number; required: boolean }>;
  };
  sections: Array<{
    sectionKey: string;
    latestRevision: {
      version: number;
      markdown: string;
      generator: string;
      contentHash: string;
      createdAt: Date;
    };
  }>;
  verificationReport: {
    id: string;
    version: number;
    status: string;
    manifest: unknown;
    gates: unknown;
    issues: unknown;
    summary: unknown;
    runAt: Date | string;
  };
  approvals: Array<{
    id: string;
    seq: number;
    stage: string;
    targetKind: string;
    targetId: string;
    decision: string;
    note: string | null;
    decidedBy: string;
    slrRole: string;
    decidedAt: Date;
  }>;
  blueprintRevision?: {
    version: number;
    profileId: string;
    profileVersion: number;
    origin: string;
    createdAt: Date;
  } | null;
  lineage: LineageItem[];
  exportVersion: number;
  exportedBy: string;
}

export interface AssembledBundleResult {
  packageHash: string;
  manifest: ExportManifestItem[];
  bundle: Record<string, unknown>;
  zipBuffer: Buffer;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Assembles all 7 submission files into a unified submission package bundle and PKZIP archive.
 */
export function assembleSubmissionBundle(params: {
  manuscriptId: string;
  snapshot: AssembleBundleParams['snapshot'];
  journalProfile: AssembleBundleParams['journalProfile'];
  sections: AssembleBundleParams['sections'];
  verificationReport: AssembleBundleParams['verificationReport'];
  approvals: AssembleBundleParams['approvals'];
  blueprintRevision?: AssembleBundleParams['blueprintRevision'];
  lineage: LineageItem[];
  exportVersion: number;
  exportedBy: string;
}): AssembledBundleResult {
  const exportedAt = new Date().toISOString();

  // 1. Build manuscript.md
  const sectionMap = new Map<string, (typeof params.sections)[0]['latestRevision']>();
  for (const s of params.sections) {
    sectionMap.set(s.sectionKey.toLowerCase(), s.latestRevision);
  }

  const manuscriptParts: string[] = [];
  const paperTitle = params.snapshot.title || 'Systematic Literature Review Manuscript';
  manuscriptParts.push(`# ${paperTitle}\n\n`);

  // Order sections according to Journal Profile
  const orderedSections = [...params.journalProfile.sections].sort((a, b) => a.order - b.order);
  const includedSectionKeys = new Set<string>();

  for (const profSec of orderedSections) {
    const rev = sectionMap.get(profSec.key.toLowerCase());
    if (rev && rev.markdown.trim().length > 0) {
      manuscriptParts.push(`${rev.markdown.trim()}\n\n`);
      includedSectionKeys.add(profSec.key.toLowerCase());
    }
  }

  // Profile-required sections the engine could not produce are disclosed, never silently dropped.
  const missingProfileSections = orderedSections
    .filter((profSec) => profSec.required && !includedSectionKeys.has(profSec.key.toLowerCase()))
    .map((profSec) => profSec.key);

  // Include any extra sections not in profile
  for (const s of params.sections) {
    if (!includedSectionKeys.has(s.sectionKey.toLowerCase()) && s.latestRevision.markdown.trim().length > 0) {
      manuscriptParts.push(`${s.latestRevision.markdown.trim()}\n\n`);
    }
  }

  // Build Bibliography / References List
  manuscriptParts.push('## References\n\n');
  if (params.snapshot.studies.length === 0) {
    manuscriptParts.push('*No primary studies registered in this review corpus.*\n');
  } else {
    params.snapshot.studies.forEach((st, idx) => {
      const authors = st.authors.length > 0 ? st.authors.join(', ') : 'Unknown Authors';
      const year = st.year ? `(${st.year})` : '(n.d.)';
      const venue = st.venue ? `*${st.venue}*` : '';
      const doi = st.doi ? `https://doi.org/${st.doi}` : '';
      const parts = [`${idx + 1}.`, authors, year, `"${st.title}".`, venue, doi].filter((p) => p.length > 0);
      manuscriptParts.push(`${parts.join(' ')}\n`);
    });
  }

  const manuscriptMd = manuscriptParts.join('');

  // 2. Build citation-manifest.json
  const citationManifestJson = JSON.stringify(params.verificationReport.manifest, null, 2);

  // 3. Build verification-report.json
  const verificationReportJson = JSON.stringify(
    {
      reportId: params.verificationReport.id,
      version: params.verificationReport.version,
      status: params.verificationReport.status,
      runAt:
        typeof params.verificationReport.runAt === 'string'
          ? params.verificationReport.runAt
          : params.verificationReport.runAt.toISOString(),
      summary: params.verificationReport.summary,
      gates: params.verificationReport.gates,
      issues: params.verificationReport.issues,
    },
    null,
    2
  );

  // 4. Build ai-disclosure.md
  const aiDisclosureMd = `# Artificial Intelligence Use & Accountability Disclosure

## 1. Compliance Statement
This manuscript was synthesized and drafted with assistance from the **SLR AI Writing Platform** in compliance with the recommendations of the **International Committee of Medical Journal Editors (ICMJE)** and the **Committee on Publication Ethics (COPE)**.

## 2. Model & Generation Specifications
- **Synthesis Platform:** SLR AI Writing Engine (Node.js/PostgreSQL)
- **Primary Generator:** Evidence-grounded Section Drafter
- **Target Journal Profile:** ${params.journalProfile.name} (ID: \`${params.journalProfile.id}\`, Version: \`${params.journalProfile.version}\`)
- **Export Package Version:** ${params.exportVersion}
- **Export Timestamp:** ${exportedAt}

## 3. Human Authorship & Verification Protocol
Artificial intelligence technologies **were not designated as authors** and do not assume responsibility for scientific claims. All claims, numbers, and syntheses underwent a strict three-stage human-in-the-loop verification protocol:

1. **H1 Outline Approval:** Delineation of research question coverage and subsection structure by the project Owner.
2. **H2 Section Draft Approval:** Line-by-line review of drafted sections against evidentiary grounding.
3. **H3 Final Submission Approval:** Exhaustive Quality Gate verification (G1–G7 audit) ensuring 100% registry-only citations, verbatim quote verification, PRISMA flow count reconciliation, and ungrounded number rejection.

## 4. Sections Not Included
${missingProfileSections.length > 0 ? `The journal profile requires the following sections, but this package does not contain them because the engine cannot draft them yet: ${missingProfileSections.map((k) => `\`${k}\``).join(', ')}. They must be written by the authors.` : 'All sections required by the journal profile are included.'}

## 5. Source of Truth
The definitive source of scientific truth remains the immutable snapshot \`${params.snapshot.id}\` (Corpus Hash: \`${params.snapshot.corpusHash}\`).
`;

  // 5. Build revision-history.json
  const revisionHistoryJson = JSON.stringify(
    {
      manuscriptId: params.manuscriptId,
      blueprint: params.blueprintRevision
        ? {
            version: params.blueprintRevision.version,
            profileId: params.blueprintRevision.profileId,
            profileVersion: params.blueprintRevision.profileVersion,
            origin: params.blueprintRevision.origin,
            createdAt: params.blueprintRevision.createdAt.toISOString(),
          }
        : null,
      sections: params.sections.map((s) => ({
        sectionKey: s.sectionKey,
        version: s.latestRevision.version,
        generator: s.latestRevision.generator,
        contentHash: s.latestRevision.contentHash,
        createdAt: s.latestRevision.createdAt.toISOString(),
      })),
      approvals: params.approvals.map((a) => ({
        stage: a.stage,
        seq: a.seq,
        decision: a.decision,
        targetKind: a.targetKind,
        targetId: a.targetId,
        slrRole: a.slrRole,
        decidedBy: a.decidedBy,
        note: a.note,
        decidedAt: a.decidedAt.toISOString(),
      })),
    },
    null,
    2
  );

  // 6. Build evidence-lineage.json
  const evidenceLineageJson = JSON.stringify(params.lineage, null, 2);

  // 7. Build audit-metadata.json
  const auditMetadata = {
    exportVersion: params.exportVersion,
    exportedBy: params.exportedBy,
    exportedAt,
    manuscriptId: params.manuscriptId,
    snapshot: {
      id: params.snapshot.id,
      runId: params.snapshot.runId,
      slrProjectId: params.snapshot.slrProjectId,
      corpusHash: params.snapshot.corpusHash,
      integrityHash: params.snapshot.integrityHash,
    },
    journalProfile: {
      id: params.journalProfile.id,
      version: params.journalProfile.version,
      name: params.journalProfile.name,
    },
    missingProfileSections,
    verificationReportId: params.verificationReport.id,
    verificationStatus: params.verificationReport.status,
  };
  const auditMetadataJson = JSON.stringify(auditMetadata, null, 2);

  // Assemble files list
  const files: Array<{ filename: string; content: string; contentType: string; description: string }> = [
    {
      filename: 'manuscript.md',
      content: manuscriptMd,
      contentType: 'text/markdown; charset=utf-8',
      description: 'Full manuscript text structured according to journal profile with reference bibliography',
    },
    {
      filename: 'citation-manifest.json',
      content: citationManifestJson,
      contentType: 'application/json; charset=utf-8',
      description: 'Manifest of all citations mapped to primary studies and evidence anchors',
    },
    {
      filename: 'verification-report.json',
      content: verificationReportJson,
      contentType: 'application/json; charset=utf-8',
      description: 'Quality gates verification report (G1-G7) and review issue log',
    },
    {
      filename: 'ai-disclosure.md',
      content: aiDisclosureMd,
      contentType: 'text/markdown; charset=utf-8',
      description: 'ICMJE and COPE compliant artificial intelligence usage disclosure statement',
    },
    {
      filename: 'revision-history.json',
      content: revisionHistoryJson,
      contentType: 'application/json; charset=utf-8',
      description: 'Complete revision lineage and H1, H2, H3 approval checkpoints',
    },
    {
      filename: 'evidence-lineage.json',
      content: evidenceLineageJson,
      contentType: 'application/json; charset=utf-8',
      description: 'End-to-end evidence lineage mapping paragraph text to primary source anchors',
    },
    {
      filename: 'audit-metadata.json',
      content: auditMetadataJson,
      contentType: 'application/json; charset=utf-8',
      description: 'Audit metadata with cryptographic hashes for immutable verification',
    },
  ];

  // Build zip entries
  const zipEntries: ZipEntry[] = files.map((f) => ({
    filename: f.filename,
    content: f.content,
  }));
  const zipBuffer = createZipArchive(zipEntries);

  // Package hash across all file hashes and content
  const manifest: ExportManifestItem[] = files.map((f) => {
    const fileBuf = Buffer.from(f.content, 'utf8');
    return {
      filename: f.filename,
      sizeBytes: fileBuf.length,
      sha256: sha256(fileBuf),
      contentType: f.contentType,
      description: f.description,
    };
  });

  const packageHash = sha256(
    manifest.map((m) => `${m.filename}:${m.sha256}`).join('|') + '|zip:' + sha256(zipBuffer)
  );

  const bundle: Record<string, unknown> = {
    metadata: auditMetadata,
    manuscript: manuscriptMd,
    citationManifest: params.verificationReport.manifest,
    verificationReport: {
      id: params.verificationReport.id,
      version: params.verificationReport.version,
      status: params.verificationReport.status,
      summary: params.verificationReport.summary,
    },
    aiDisclosure: aiDisclosureMd,
    lineageSummary: {
      totalParagraphs: params.lineage.length,
      paragraphsWithFindings: params.lineage.filter((p) => p.usedFindingIds.length > 0).length,
      paragraphsWithEvidence: params.lineage.filter((p) => p.usedEvidenceIds.length > 0).length,
    },
    packageHash,
  };

  return {
    packageHash,
    manifest,
    bundle,
    zipBuffer,
  };
}
