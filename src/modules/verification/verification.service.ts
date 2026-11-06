import { computeRequiredSections, fingerprintSections } from '../manuscripts/required-sections.js';
import type { Prisma, VerificationReport } from '../../generated/prisma/client.js';
import { prisma } from '../../config/prisma.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { getApprovedBlueprint } from '../blueprint/blueprint.service.js';
import type { BlueprintContent } from '../blueprint/blueprint.types.js';
import { stableStringify } from '../../shared/utils/stable-json.js';
import {
  ensureManuscript,
  exclusiveForSnapshot,
  takeSnapshotLock,
  WRITE_TRANSACTION_OPTIONS,
} from '../manuscripts/manuscript.store.js';
import type { ParagraphPlanContent } from '../paragraph-plans/paragraph-plan.types.js';
import {
  buildCitationManifest,
  type SectionRevisionForManifest,
  type SnapshotRegistryForManifest,
} from './manifest.service.js';
import type { GateEvaluator, GateEvaluationContext } from './gates/gate.interface.js';
import { G1CitationIntegrityEvaluator } from './gates/g1-citation-integrity.js';
import { G2QuoteFidelityEvaluator } from './gates/g2-quote-fidelity.js';
import { G3PrismaReconciliationEvaluator } from './gates/g3-prisma-reconciliation.js';
import { G4UngroundedNumbersEvaluator } from './gates/g4-ungrounded-numbers.js';
import { G5EvidenceEntailmentEvaluator } from './gates/g5-evidence-entailment.js';
import { G6ClaimStrengthEvaluator } from './gates/g6-claim-strength.js';
import { G7RqCoverageEvaluator } from './gates/g7-rq-coverage.js';
import type {
  GateId,
  QualityGateResult,
  ReviewIssue,
  VerificationOverallStatus,
  VerificationReportSummaryRow,
  VerificationReportView,
  VerificationSummary,
} from './verification.types.js';

const json = (value: unknown) => value as Prisma.InputJsonValue;

const ALL_GATES: GateEvaluator[] = [
  new G1CitationIntegrityEvaluator(),
  new G2QuoteFidelityEvaluator(),
  new G3PrismaReconciliationEvaluator(),
  new G4UngroundedNumbersEvaluator(),
  new G5EvidenceEntailmentEvaluator(),
  new G6ClaimStrengthEvaluator(),
  new G7RqCoverageEvaluator(),
];

export async function runVerification(params: {
  projectId: string;
  snapshotId: string;
  actor: string;
}): Promise<{ report: VerificationReport; created: boolean; view: VerificationReportView }> {
  const { projectId, snapshotId, actor } = params;

  // 1. Load snapshot & manuscript
  const snapshot = await prisma.reviewSnapshot.findFirst({
    where: { id: snapshotId, projectId },
    include: {
      studies: true,
      findings: true,
      evidence: true,
      researchQuestions: true,
      supplements: true,
    },
  });

  if (!snapshot) {
    throw new NotFoundError('Snapshot not found', 'SNAPSHOT_NOT_FOUND');
  }

  const manuscript = await prisma.manuscript.findUnique({
    where: { snapshotId },
  });

  if (!manuscript) {
    throw new NotFoundError('Manuscript not found for this snapshot', 'MANUSCRIPT_NOT_FOUND');
  }

  // 2. Verify approved blueprint exists
  const approvedBlueprint = await getApprovedBlueprint(manuscript.id);
  if (!approvedBlueprint) {
    throw new AppError(
      'Cannot run verification: the manuscript blueprint is not approved',
      422,
      'BLUEPRINT_NOT_APPROVED',
    );
  }

  // 3. Load sections and their latest revisions
  const sections = await prisma.manuscriptSection.findMany({
    where: { manuscriptId: manuscript.id },
    include: {
      revisions: {
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
  });

  const verifiedContentHash = fingerprintSections(
    sections.filter((s) => s.revisions[0]).map((s) => ({ sectionKey: s.sectionKey, contentHash: s.revisions[0].contentHash })),
  );
  const sectionRevisions: SectionRevisionForManifest[] = [];
  for (const s of sections) {
    const latestRev = s.revisions[0];
    if (latestRev) {
      sectionRevisions.push({
        sectionKey: s.sectionKey,
        version: latestRev.version,
        markdown: latestRev.markdown,
        facts: latestRev.facts,
      });
    }
  }

  if (sectionRevisions.length === 0) {
    throw new AppError(
      'Cannot run verification: no manuscript sections have been drafted yet',
      422,
      'NO_DRAFTED_SECTIONS',
    );
  }

  // 4. Assemble registry
  const registry: SnapshotRegistryForManifest = {
    studies: snapshot.studies.map((s) => ({
      externalId: s.externalId,
      title: s.title,
      year: s.year,
    })),
    findings: snapshot.findings.map((f) => ({
      externalId: f.externalId,
      studyId: f.studyId,
      fieldName: f.fieldName,
      valueText: f.valueText,
    })),
    evidence: snapshot.evidence.map((e) => ({
      externalId: e.externalId,
      studyId: e.studyId,
      quote: e.quote,
      quoteHashVerified: e.quoteHashVerified,
    })),
  };

  // 5. Build Citation Manifest
  const manifest = buildCitationManifest({
    manuscriptId: manuscript.id,
    snapshotId,
    sections: sectionRevisions,
    registry,
  });

  // 6. Load blueprint and paragraph plans context
  const bpContent = approvedBlueprint.content as unknown as BlueprintContent;
  const latestPlansRev = await prisma.paragraphPlanRevision.findFirst({
    where: { manuscriptId: manuscript.id },
    orderBy: { version: 'desc' },
  });
  const plansContent = (latestPlansRev?.content ?? null) as unknown as ParagraphPlanContent | null;

  // Extract PRISMA export supplement if present
  const prismaWritingExport = snapshot.supplements.find(
    (s) => s.kind === 'prisma_writing_export',
  )?.payload as any;

  const evaluationContext: GateEvaluationContext = {
    manifest,
    sections: sectionRevisions,
    registry,
    blueprint: {
      researchQuestions: snapshot.researchQuestions.map((rq) => ({
        rqId: rq.externalId,
        code: rq.code,
        question: rq.text,
      })),
      sections: (bpContent.sections ?? []).map((s) => ({
        key: s.key,
        include: s.include,
        subsections: (s.subsections ?? []).map((sub) => ({ id: sub.id, title: sub.title })),
      })),
    },
    coverage: (bpContent.coverage ?? []).map((c) => ({ rqId: c.rqId, notApplicableReason: c.notApplicableReason })),
    requiredSections: computeRequiredSections({
      blueprintSections: bpContent.sections ?? [],
      plans: plansContent?.plans ?? [],
    }).required,
    supplements: {
      prismaWritingExport,
    },
    paragraphPlans: plansContent?.plans.map((p) => ({
      id: p.id,
      sectionKey: p.sectionKey,
      rqIds: p.rqIds,
      claimStrength: p.claimStrength,
      conditionsRequired: p.conditionsRequired,
    })),
  };

  // 7. Evaluate Gates G1 to G7
  const gatesRecord: Partial<Record<GateId, QualityGateResult>> = {};
  const allIssues: ReviewIssue[] = [];

  for (const gate of ALL_GATES) {
    const evaluation = await gate.evaluate(evaluationContext);
    gatesRecord[gate.gateId] = evaluation.result;
    allIssues.push(...evaluation.issues);
  }

  // 8. Compute Summary & Overall Status
  const gateResults = Object.values(gatesRecord) as QualityGateResult[];
  const failedCount = gateResults.filter((g) => g.status === 'FAIL').length;
  const warningCount = gateResults.filter((g) => g.status === 'WARNING').length;
  const needsReviewCount = gateResults.filter((g) => g.status === 'NEEDS_REVIEW').length;
  const passedCount = gateResults.filter((g) => g.status === 'PASS').length;
  const notAppCount = gateResults.filter((g) => g.status === 'NOT_APPLICABLE').length;
  const notRunCount = gateResults.filter((g) => g.status === 'NOT_RUN').length;
  const blockingIssuesCount = allIssues.filter((i) => i.severity === 'BLOCKING').length;
  const warningIssuesCount = allIssues.filter((i) => i.severity === 'WARNING').length;

  let overallStatus: VerificationOverallStatus = 'PASSED';
  if (failedCount > 0 || blockingIssuesCount > 0) {
    overallStatus = 'FAILED';
  } else if (warningCount > 0 || needsReviewCount > 0) {
    overallStatus = 'PASSED_WITH_WARNINGS';
  }

  const summary: VerificationSummary = {
    totalGates: ALL_GATES.length,
    passed: passedCount,
    warnings: warningCount,
    failed: failedCount,
    needsReview: needsReviewCount,
    notApplicable: notAppCount,
    notRun: notRunCount,
    blockingIssues: blockingIssuesCount,
    warningIssues: warningIssuesCount,
    verifiedContentHash,
  };

  // 9. Concurrency lock and transactional write
  return exclusiveForSnapshot(snapshotId, () =>
    prisma.$transaction(async (tx) => {
      await takeSnapshotLock(tx, snapshotId);
      await ensureManuscript(tx, { projectId, snapshotId, actor });

      // The sections were read before the (slow) gates ran; refuse to record a report for content that has moved on.
      const currentSections = await tx.manuscriptSection.findMany({
        where: { manuscriptId: manuscript.id },
        include: { revisions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      const currentHash = fingerprintSections(
        currentSections.filter((s) => s.revisions[0]).map((s) => ({ sectionKey: s.sectionKey, contentHash: s.revisions[0].contentHash })),
      );
      if (currentHash !== verifiedContentHash) {
        throw new ConflictError(
          'A section changed while verification was running. Run verification again.',
          'VERIFICATION_INPUT_CHANGED',
        );
      }

      const latest = await tx.verificationReport.findFirst({
        where: { manuscriptId: manuscript.id },
        orderBy: { version: 'desc' },
      });

      // Idempotency: compare status, summary, and manifest totals
      if (
        latest &&
        latest.status === overallStatus &&
        stableStringify(latest.summary) === stableStringify(summary) &&
        stableStringify(latest.manifest) === stableStringify(manifest)
      ) {
        const view = await buildReportView(latest);
        return { report: latest, created: false, view };
      }

      const version = (latest?.version ?? 0) + 1;
      const report = await tx.verificationReport.create({
        data: {
          manuscriptId: manuscript.id,
          version,
          status: overallStatus,
          manifest: json(manifest),
          gates: json(gatesRecord),
          issues: json(allIssues),
          summary: json(summary),
          runBy: actor,
        },
      });

      await tx.provenanceEvent.create({
        data: {
          projectId,
          snapshotId,
          actor,
          activity: 'manuscript.verification.run',
          method: 'verification-gates@1',
          inputRefs: json({
            snapshotId,
            manuscriptId: manuscript.id,
            blueprintVersion: approvedBlueprint.version,
            sectionsCount: sectionRevisions.length,
          }),
          outputRefs: json({
            reportId: report.id,
            version: report.version,
            status: overallStatus,
            blockingIssues: blockingIssuesCount,
          }),
        },
      });

      const view = await buildReportView(report);
      return { report, created: true, view };
    }, WRITE_TRANSACTION_OPTIONS),
  );
}

/**
 * Builds the comprehensive user-facing VerificationReportView.
 */
async function buildReportView(
  report: VerificationReport,
  db: Prisma.TransactionClient = prisma,
): Promise<VerificationReportView> {
  const allRevisions = await db.verificationReport.findMany({
    where: { manuscriptId: report.manuscriptId },
    select: { version: true, status: true, runAt: true, runBy: true },
    orderBy: { version: 'desc' },
  });

  const versions: VerificationReportSummaryRow[] = allRevisions.map((r) => ({
    version: r.version,
    status: r.status as VerificationOverallStatus,
    runAt: r.runAt.toISOString(),
    runBy: r.runBy,
  }));

  return {
    id: report.id,
    manuscriptId: report.manuscriptId,
    version: report.version,
    status: report.status as VerificationOverallStatus,
    summary: report.summary as unknown as VerificationSummary,
    manifest: report.manifest as any,
    gates: report.gates as any,
    issues: report.issues as any,
    runBy: report.runBy,
    runAt: report.runAt.toISOString(),
    versions,
  };
}

export async function getLatestVerificationReport(
  projectId: string,
  snapshotId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<VerificationReportView> {
  const manuscript = await db.manuscript.findFirst({
    where: { snapshotId, projectId },
  });

  if (!manuscript) {
    throw new NotFoundError('Manuscript not found for this snapshot', 'MANUSCRIPT_NOT_FOUND');
  }

  const latest = await db.verificationReport.findFirst({
    where: { manuscriptId: manuscript.id },
    orderBy: { version: 'desc' },
  });

  if (!latest) {
    throw new NotFoundError(
      'No verification reports found. Run verification first via POST /verification/run',
      'VERIFICATION_REPORT_NOT_FOUND',
    );
  }

  return buildReportView(latest, db);
}

export async function getVerificationReportByVersion(
  projectId: string,
  snapshotId: string,
  version: number,
): Promise<VerificationReportView> {
  const manuscript = await prisma.manuscript.findFirst({
    where: { snapshotId, projectId },
  });

  if (!manuscript) {
    throw new NotFoundError('Manuscript not found for this snapshot', 'MANUSCRIPT_NOT_FOUND');
  }

  const report = await prisma.verificationReport.findUnique({
    where: {
      manuscriptId_version: {
        manuscriptId: manuscript.id,
        version,
      },
    },
  });

  if (!report) {
    throw new NotFoundError(
      `Verification report version ${version} not found`,
      'VERIFICATION_REPORT_NOT_FOUND',
    );
  }

  return buildReportView(report);
}
