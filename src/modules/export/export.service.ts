import { createHash } from 'node:crypto';
import type { Prisma, Approval } from '../../generated/prisma/client.js';
import { prisma } from '../../config/prisma.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { assertSlrOwner, latestDecision, statusOf } from '../approvals/approvals.service.js';
import { getApprovedBlueprint } from '../blueprint/blueprint.service.js';
import type { BlueprintContent } from '../blueprint/blueprint.types.js';
import { SECTION_TARGET_KIND } from '../drafting/drafting.service.js';
import { getJournalProfile } from '../journal-profiles/journal-profiles.service.js';
import { fingerprintSections, loadRequiredSections } from '../manuscripts/required-sections.js';
import { exclusiveForSnapshot, takeSnapshotLock, WRITE_TRANSACTION_OPTIONS } from '../manuscripts/manuscript.store.js';
import { getLatestVerificationReport } from '../verification/verification.service.js';
import type { VerificationReportView } from '../verification/verification.types.js';
import type { H3StatusView, ExportPackageView, LineageItem } from './export.types.js';
import { buildManuscriptLineage, filterLineage } from './lineage.service.js';
import { assembleSubmissionBundle } from './package-assembler.js';

export const MANUSCRIPT_FINAL_TARGET_KIND = 'manuscript_final';
const json = (value: unknown) => value as Prisma.InputJsonValue;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function findManuscript(projectId: string, snapshotId: string) {
  const manuscript = await prisma.manuscript.findFirst({
    where: { snapshotId, projectId },
  });
  if (!manuscript) {
    throw new NotFoundError('Manuscript not found for this snapshot', 'MANUSCRIPT_NOT_FOUND');
  }
  return manuscript;
}

/**
 * Computes a deterministic composite hash for the manuscript sections and the verification report.
 * If any section is edited or a new verification report is run, this hash changes, invalidating previous H3 approvals.
 */
export async function computeCompositeManuscriptHash(
  manuscriptId: string,
  verificationReportId?: string
): Promise<string> {
  const sections = await prisma.manuscriptSection.findMany({
    where: { manuscriptId },
    include: {
      revisions: {
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
    orderBy: { sectionKey: 'asc' },
  });

  const parts = sections.map((s) => `${s.sectionKey}:${s.revisions[0]?.contentHash || 'empty'}`);

  if (verificationReportId) {
    parts.push(`verification:${verificationReportId}`);
  }

  return sha256(parts.join(';'));
}

/**
 * Evaluates the prerequisites and readiness for H3 approval and submission package export.
 * Fail-closed: returns detailed blocking reasons if anything is unapproved, failing, or missing.
 */
export async function getH3Status(params: { projectId: string; snapshotId: string }): Promise<H3StatusView> {
  const manuscript = await findManuscript(params.projectId, params.snapshotId);
  const blockingReasons: string[] = [];

  // 1. Check Blueprint (H1)
  const approvedBlueprint = await getApprovedBlueprint(manuscript.id);
  if (!approvedBlueprint) {
    blockingReasons.push('Manuscript blueprint (H1) has not been approved by the project Owner');
  }

  // 2. Check Section Drafts (H2)
  const sections = await prisma.manuscriptSection.findMany({
    where: { manuscriptId: manuscript.id },
    include: {
      revisions: {
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
  });

  let requiredSections: string[] = [];
  let omittedSections: string[] = [];
  let undraftableSections = new Set<string>();
  if (approvedBlueprint) {
    const computed = await loadRequiredSections(manuscript.id, approvedBlueprint.content as unknown as BlueprintContent);
    requiredSections = computed.required;
    omittedSections = computed.omitted;
    undraftableSections = new Set(computed.undraftable);
    const drafted = new Set(sections.filter((sec) => sec.revisions.length > 0).map((sec) => sec.sectionKey));
    for (const key of requiredSections) {
      if (!drafted.has(key)) blockingReasons.push(
          undraftableSections.has(key)
            ? `Required section '${key}' has not been drafted yet and no paragraph plan for it is ready to draft; resolve the missing evidence in the paragraph plans first`
            : `Required section '${key}' has not been drafted yet`,
        );
    }
  }

  if (sections.length === 0) {
    blockingReasons.push('No manuscript sections have been generated or drafted yet');
  } else {
    for (const sec of sections) {
      const latestRev = sec.revisions[0];
      if (!latestRev) {
        blockingReasons.push(`Section '${sec.sectionKey}' has no revisions`);
        continue;
      }
      const decision = await latestDecision(prisma, {
        manuscriptId: manuscript.id,
        stage: 'H2',
        targetKind: SECTION_TARGET_KIND,
        targetId: latestRev.id,
      });

      if (statusOf(decision) !== 'APPROVED') {
        blockingReasons.push(
          `Section '${sec.sectionKey}' draft revision v${latestRev.version} is not approved (current status: ${statusOf(decision)})`
        );
      }
    }
  }

  // 3. Check Verification Report (M8)
  let latestVerification: VerificationReportView | null = null;
  try {
    latestVerification = await getLatestVerificationReport(params.projectId, params.snapshotId);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }

  let verificationSummary: H3StatusView['verificationSummary'] = null;

  if (!latestVerification) {
    blockingReasons.push('Quality gates verification has not been run. Run POST /verification/run first');
  } else {
    const sum = latestVerification.summary as {
      passed?: number;
      warnings?: number;
      failed?: number;
      needsReview?: number;
      blockingIssues?: number;
    };
    const failedCount = sum.failed || 0;
    const blockingIssuesCount = sum.blockingIssues || 0;

    verificationSummary = {
      version: latestVerification.version,
      status: latestVerification.status,
      passed: sum.passed || 0,
      warnings: sum.warnings || 0,
      failed: failedCount,
      needsReview: sum.needsReview || 0,
      blockingIssuesCount,
    };

    // A report only vouches for the section revisions it checked. Reports from before this check carry no
    // fingerprint and are treated as stale (fail-closed).
    const currentFingerprint = fingerprintSections(
      sections.filter((sec) => sec.revisions[0]).map((sec) => ({ sectionKey: sec.sectionKey, contentHash: sec.revisions[0].contentHash })),
    );
    if ((latestVerification.summary as { verifiedContentHash?: string }).verifiedContentHash !== currentFingerprint) {
      blockingReasons.push(
        'The verification report is stale: sections changed after it was run. Run POST /verification/run again',
      );
    }

    if (latestVerification.status === 'FAILED') {
      blockingReasons.push('Latest verification report failed quality gate audits');
    }
    if (failedCount > 0 || blockingIssuesCount > 0) {
      blockingReasons.push(
        `Verification report contains ${failedCount} failed quality gates and ${blockingIssuesCount} blocking issues`
      );
    }
  }

  // 4. Compute composite hash and check existing H3 decision
  const compositeTargetHash = await computeCompositeManuscriptHash(manuscript.id, latestVerification?.id);

  const target = {
    manuscriptId: manuscript.id,
    stage: 'H3' as const,
    targetKind: MANUSCRIPT_FINAL_TARGET_KIND,
    targetId: manuscript.id,
  };

  const latestApproval = await latestDecision(prisma, target);
  let h3Status: 'PENDING' | 'APPROVED' | 'REJECTED' = 'PENDING';

  if (latestApproval) {
    if (latestApproval.decision === 'APPROVED') {
      if (latestApproval.targetHash !== compositeTargetHash) {
        h3Status = 'PENDING';
        blockingReasons.push('Manuscript sections or verification report were modified after previous H3 approval');
      } else {
        h3Status = 'APPROVED';
      }
    } else {
      h3Status = 'REJECTED';
      blockingReasons.push(`H3 was rejected by ${latestApproval.decidedBy}: ${latestApproval.note || 'No reason provided'}`);
    }
  }

  const canApprove = blockingReasons.length === 0;

  return {
    h3Status,
    canApprove,
    blockingReasons,
    compositeTargetHash,
    requiredSections,
    omittedSections,
    latestApproval: latestApproval
      ? {
          id: latestApproval.id,
          seq: latestApproval.seq,
          stage: 'H3',
          decision: latestApproval.decision as 'APPROVED' | 'REJECTED',
          note: latestApproval.note,
          decidedBy: latestApproval.decidedBy,
          slrRole: latestApproval.slrRole,
          decidedAt: latestApproval.decidedAt.toISOString(),
          targetHash: latestApproval.targetHash,
        }
      : null,
    verificationSummary,
  };
}

/**
 * H3 Approval / Rejection checkpoint.
 * Only the OWNER of the SLR project on slr-be can decide.
 */
export async function decideH3(params: {
  projectId: string;
  snapshotId: string;
  slrProjectId: string;
  authorization: string | undefined;
  actor: string;
  decision: 'APPROVED' | 'REJECTED';
  note?: string;
}): Promise<Approval> {
  const slrRole = await assertSlrOwner({
    slrProjectId: params.slrProjectId,
    authorization: params.authorization,
  });

  const manuscript = await findManuscript(params.projectId, params.snapshotId);

  return exclusiveForSnapshot(params.snapshotId, async () => {
    return prisma.$transaction(async (tx) => {
      // Take the lock first, then read the status: every writer of sections or reports takes the same lock, so what
      // we check is what we record, even with several server instances.
      await takeSnapshotLock(tx, params.snapshotId);

      const status = await getH3Status({
        projectId: params.projectId,
        snapshotId: params.snapshotId,
      });

      if (params.decision === 'APPROVED' && !status.canApprove) {
        throw new AppError(
          `Cannot approve H3: ${status.blockingReasons.join('; ')}`,
          422,
          'QUALITY_GATES_BLOCKED',
          true,
          { blockingReasons: status.blockingReasons }
        );
      }

      const target = {
        manuscriptId: manuscript.id,
        stage: 'H3' as const,
        targetKind: MANUSCRIPT_FINAL_TARGET_KIND,
        targetId: manuscript.id,
      };

      const previous = await latestDecision(tx, target);
      if (
        previous &&
        previous.decision === params.decision &&
        previous.targetHash === status.compositeTargetHash &&
        (params.note === undefined || previous.note === params.note)
      ) {
        return previous;
      }

      const approval = await tx.approval.create({
        data: {
          ...target,
          targetHash: status.compositeTargetHash,
          decision: params.decision,
          note: params.note || null,
          decidedBy: params.actor,
          slrRole,
        },
      });

      await tx.provenanceEvent.create({
        data: {
          projectId: params.projectId,
          snapshotId: params.snapshotId,
          actor: params.actor,
          activity: `approval.H3.${params.decision.toLowerCase()}`,
          method: 'owner-decision',
          inputRefs: json({
            manuscriptId: manuscript.id,
            targetHash: status.compositeTargetHash,
            verificationReportId: status.verificationSummary?.version,
          }),
          outputRefs: json({ approvalId: approval.id, slrRole }),
          notes: params.note || null,
        },
      });

      return approval;
    }, WRITE_TRANSACTION_OPTIONS);
  });
}

/**
 * Creates an immutable, append-only submission package export.
 * Fail-closed: strictly blocked unless H3 is APPROVED and quality gates are satisfied.
 */
export async function createExportPackage(params: {
  projectId: string;
  snapshotId: string;
  slrProjectId: string;
  authorization: string | undefined;
  actor: string;
}): Promise<ExportPackageView> {
  await assertSlrOwner({
    slrProjectId: params.slrProjectId,
    authorization: params.authorization,
  });

  const manuscript = await findManuscript(params.projectId, params.snapshotId);

  return exclusiveForSnapshot(params.snapshotId, async () => {
    // 1. Verify H3 Status & Quality Gates
    const h3Status = await getH3Status({
      projectId: params.projectId,
      snapshotId: params.snapshotId,
    });

    if (h3Status.h3Status !== 'APPROVED' || !h3Status.latestApproval) {
      throw new AppError(
        'Export requires an APPROVED H3 decision from the project Owner. Call POST /final/approve first.',
        422,
        'H3_APPROVAL_REQUIRED',
        true,
        { blockingReasons: h3Status.blockingReasons }
      );
    }

    if (h3Status.latestApproval.targetHash !== h3Status.compositeTargetHash) {
      throw new AppError(
        'The manuscript was modified after the H3 approval was granted. Re-verify and re-approve H3 before exporting.',
        422,
        'MANUSCRIPT_MODIFIED_AFTER_H3_APPROVAL'
      );
    }

    // 2. Load latest verification report
    const latestVerification = await getLatestVerificationReport(params.projectId, params.snapshotId);
    if (!latestVerification || latestVerification.status === 'FAILED') {
      throw new AppError('Quality gates verification report is missing or FAILED', 422, 'QUALITY_GATES_BLOCKED');
    }

    // 3. Load snapshot with studies & project
    const snapshot = await prisma.reviewSnapshot.findUnique({
      where: { id: params.snapshotId },
      include: {
        project: true,
        studies: true,
      },
    });
    if (!snapshot) throw new NotFoundError('Snapshot not found', 'SNAPSHOT_NOT_FOUND');

    // 4. Load sections with latest revisions
    const rawSections = await prisma.manuscriptSection.findMany({
      where: { manuscriptId: manuscript.id },
      include: {
        revisions: {
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    });

    const sections = rawSections
      .filter((s) => s.revisions.length > 0)
      .map((s) => ({
        sectionKey: s.sectionKey,
        latestRevision: s.revisions[0]!,
      }));

    // 5. Load latest blueprint
    const blueprintRevision = await prisma.blueprintRevision.findFirst({
      where: { manuscriptId: manuscript.id },
      orderBy: { version: 'desc' },
    });

    // 6. Load all approvals
    const approvals = await prisma.approval.findMany({
      where: { manuscriptId: manuscript.id },
      orderBy: { seq: 'asc' },
    });

    // 7. Load Journal Profile
    const profileId = blueprintRevision?.profileId || 'generic-imrad';
    const profile = getJournalProfile(profileId);

    // 8. Build Lineage
    const lineage = await buildManuscriptLineage({
      manuscriptId: manuscript.id,
      snapshotId: params.snapshotId,
    });

    // 9. Calculate Next Export Version
    const existingCount = await prisma.exportPackage.count({
      where: { manuscriptId: manuscript.id },
    });
    const exportVersion = existingCount + 1;

    // 10. Assemble Bundle & Package
    const assembled = assembleSubmissionBundle({
      manuscriptId: manuscript.id,
      snapshot: {
        id: snapshot.id,
        title: snapshot.project.name,
        runId: snapshot.sourceRunId,
        slrProjectId: snapshot.project.slrProjectId,
        corpusHash: snapshot.corpusHash,
        integrityHash: snapshot.integrityHash,
        studies: snapshot.studies.map((st) => ({
          id: st.id,
          externalId: st.externalId,
          title: st.title,
          authors: st.authors,
          year: st.year,
          doi: st.doi,
          venue: st.venue,
        })),
      },
      journalProfile: {
        id: profile.id,
        version: profile.version,
        name: profile.name,
        sections: profile.sections.map((sec) => ({
          key: sec.key,
          order: sec.order,
          required: sec.required,
        })),
      },
      sections,
      verificationReport: latestVerification,
      approvals,
      blueprintRevision,
      lineage,
      exportVersion,
      exportedBy: params.actor,
    });

    // 11. Save in Transaction
    return prisma.$transaction(async (tx) => {
      await takeSnapshotLock(tx, params.snapshotId);

      // Everything above was read before the lock. If a section, report or decision moved since, do not export a
      // package that no longer matches the approved manuscript.
      const recheck = await getH3Status({ projectId: params.projectId, snapshotId: params.snapshotId });
      if (recheck.h3Status !== 'APPROVED' || recheck.compositeTargetHash !== h3Status.compositeTargetHash) {
        throw new ConflictError(
          'The manuscript changed while the package was being assembled. Review H3 and export again.',
          'EXPORT_INPUT_CHANGED',
        );
      }

      const created = await tx.exportPackage.create({
        data: {
          manuscriptId: manuscript.id,
          version: exportVersion,
          h3ApprovalId: h3Status.latestApproval!.id,
          verificationReportId: latestVerification.id,
          packageHash: assembled.packageHash,
          manifest: json(assembled.manifest),
          bundle: json(assembled.bundle),
          exportedBy: params.actor,
        },
      });

      await tx.provenanceEvent.create({
        data: {
          projectId: params.projectId,
          snapshotId: params.snapshotId,
          actor: params.actor,
          activity: 'manuscript.export.generate',
          method: 'submission-package-export',
          inputRefs: json({
            manuscriptId: manuscript.id,
            h3ApprovalId: h3Status.latestApproval!.id,
            verificationReportId: latestVerification.id,
            compositeHash: h3Status.compositeTargetHash,
          }),
          outputRefs: json({
            exportPackageId: created.id,
            version: exportVersion,
            packageHash: assembled.packageHash,
          }),
          notes: `Submission package v${exportVersion} generated successfully`,
        },
      });

      return {
        id: created.id,
        manuscriptId: created.manuscriptId,
        version: created.version,
        packageHash: created.packageHash,
        h3ApprovalId: created.h3ApprovalId,
        verificationReportId: created.verificationReportId,
        manifest: assembled.manifest,
        bundle: assembled.bundle,
        exportedBy: created.exportedBy,
        exportedAt: created.exportedAt.toISOString(),
      };
    }, WRITE_TRANSACTION_OPTIONS);
  });
}

/**
 * Returns the latest exported package for a manuscript.
 */
export async function getLatestExportPackage(params: {
  projectId: string;
  snapshotId: string;
}): Promise<ExportPackageView> {
  const manuscript = await findManuscript(params.projectId, params.snapshotId);
  const pkg = await prisma.exportPackage.findFirst({
    where: { manuscriptId: manuscript.id },
    orderBy: { version: 'desc' },
  });

  if (!pkg) {
    throw new NotFoundError(
      'No submission package has been exported for this manuscript yet',
      'EXPORT_PACKAGE_NOT_FOUND'
    );
  }

  return {
    id: pkg.id,
    manuscriptId: pkg.manuscriptId,
    version: pkg.version,
    packageHash: pkg.packageHash,
    h3ApprovalId: pkg.h3ApprovalId,
    verificationReportId: pkg.verificationReportId,
    manifest: pkg.manifest as ExportPackageView['manifest'],
    bundle: pkg.bundle as Record<string, unknown>,
    exportedBy: pkg.exportedBy,
    exportedAt: pkg.exportedAt.toISOString(),
  };
}

/**
 * Returns a specific version of the exported package.
 */
export async function getExportPackageByVersion(params: {
  projectId: string;
  snapshotId: string;
  version: number;
}): Promise<ExportPackageView> {
  const manuscript = await findManuscript(params.projectId, params.snapshotId);
  const pkg = await prisma.exportPackage.findUnique({
    where: {
      manuscriptId_version: {
        manuscriptId: manuscript.id,
        version: params.version,
      },
    },
  });

  if (!pkg) {
    throw new NotFoundError(
      `Submission package version ${params.version} was not found`,
      'EXPORT_PACKAGE_NOT_FOUND'
    );
  }

  return {
    id: pkg.id,
    manuscriptId: pkg.manuscriptId,
    version: pkg.version,
    packageHash: pkg.packageHash,
    h3ApprovalId: pkg.h3ApprovalId,
    verificationReportId: pkg.verificationReportId,
    manifest: pkg.manifest as ExportPackageView['manifest'],
    bundle: pkg.bundle as Record<string, unknown>,
    exportedBy: pkg.exportedBy,
    exportedAt: pkg.exportedAt.toISOString(),
  };
}

/**
 * Generates the PKZIP buffer for the requested export package.
 */
export async function downloadExportZip(params: {
  projectId: string;
  snapshotId: string;
  version?: number;
}): Promise<{ filename: string; zipBuffer: Buffer; packageHash: string }> {
  const exportView = params.version
    ? await getExportPackageByVersion({ ...params, version: params.version })
    : await getLatestExportPackage(params);

  const manuscript = await findManuscript(params.projectId, params.snapshotId);
  const snapshot = await prisma.reviewSnapshot.findUniqueOrThrow({
    where: { id: params.snapshotId },
    include: { project: true, studies: true },
  });

  const rawSections = await prisma.manuscriptSection.findMany({
    where: { manuscriptId: manuscript.id },
    include: {
      revisions: {
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
  });

  const sections = rawSections
    .filter((s) => s.revisions.length > 0)
    .map((s) => ({ sectionKey: s.sectionKey, latestRevision: s.revisions[0]! }));

  const verificationReport = await prisma.verificationReport.findUniqueOrThrow({
    where: { id: exportView.verificationReportId },
  });

  const approvals = await prisma.approval.findMany({
    where: { manuscriptId: manuscript.id },
    orderBy: { seq: 'asc' },
  });

  const blueprintRevision = await prisma.blueprintRevision.findFirst({
    where: { manuscriptId: manuscript.id },
    orderBy: { version: 'desc' },
  });

  const profile = getJournalProfile(blueprintRevision?.profileId || 'generic-imrad');
  const lineage = await buildManuscriptLineage({
    manuscriptId: manuscript.id,
    snapshotId: params.snapshotId,
  });

  const assembled = assembleSubmissionBundle({
    manuscriptId: manuscript.id,
    snapshot: {
      id: snapshot.id,
      title: snapshot.project.name,
      runId: snapshot.sourceRunId,
      slrProjectId: snapshot.project.slrProjectId,
      corpusHash: snapshot.corpusHash,
      integrityHash: snapshot.integrityHash,
      studies: snapshot.studies.map((st) => ({
        id: st.id,
        externalId: st.externalId,
        title: st.title,
        authors: st.authors,
        year: st.year,
        doi: st.doi,
        venue: st.venue,
      })),
    },
    journalProfile: {
      id: profile.id,
      version: profile.version,
      name: profile.name,
      sections: profile.sections.map((sec) => ({
        key: sec.key,
        order: sec.order,
        required: sec.required,
      })),
    },
    sections,
    verificationReport,
    approvals,
    blueprintRevision,
    lineage,
    exportVersion: exportView.version,
    exportedBy: exportView.exportedBy,
  });

  const sanitizedTitle = (snapshot.project.name || 'manuscript')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .slice(0, 40);

  return {
    filename: `${sanitizedTitle}_v${exportView.version}_submission_package.zip`,
    zipBuffer: assembled.zipBuffer,
    packageHash: exportView.packageHash,
  };
}

/**
 * Lineage query engine for reverse tracing paragraph/sentence down to source anchors.
 */
export async function queryLineage(params: {
  projectId: string;
  snapshotId: string;
  sectionKey?: string;
  evidenceId?: string;
  findingId?: string;
  sentence?: string;
}): Promise<LineageItem[]> {
  const manuscript = await findManuscript(params.projectId, params.snapshotId);
  const items = await buildManuscriptLineage({
    manuscriptId: manuscript.id,
    snapshotId: params.snapshotId,
  });

  return filterLineage(items, {
    sectionKey: params.sectionKey,
    evidenceId: params.evidenceId,
    findingId: params.findingId,
    sentence: params.sentence,
  });
}
