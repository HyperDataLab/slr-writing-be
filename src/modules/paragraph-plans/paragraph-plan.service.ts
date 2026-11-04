import type { Prisma, ParagraphPlanRevision } from '../../generated/prisma/client.js';
import { prisma } from '../../config/prisma.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { hashOfJson } from '../../shared/utils/stable-json.js';
import { getApprovedBlueprint } from '../blueprint/blueprint.service.js';
import type { BlueprintContent } from '../blueprint/blueprint.types.js';
import { ensureManuscript, exclusiveForSnapshot, takeSnapshotLock, WRITE_TRANSACTION_OPTIONS } from '../manuscripts/manuscript.store.js';
import { generateParagraphPlans } from './paragraph-plan-generator.js';
import { hasBlockingIssue, validateParagraphPlans } from './paragraph-plan-validator.js';
import {
  paragraphPlanContentSchema,
  type ParagraphPlanContent,
  type ParagraphPlanContext,
  type ParagraphPlanIssue,
} from './paragraph-plan.types.js';

const json = (value: unknown) => value as Prisma.InputJsonValue;

export interface ParagraphPlanView {
  revision: ParagraphPlanRevision;
  issues: ParagraphPlanIssue[];
  /** True when the paragraph plans have no blocking issues and at least one ready paragraph. */
  readyToDraft: boolean;
  stats: {
    totalParagraphs: number;
    readyParagraphs: number;
  };
  versions: Array<
    Pick<
      ParagraphPlanRevision,
      'id' | 'version' | 'origin' | 'contentHash' | 'totalParagraphs' | 'readyParagraphs' | 'createdBy' | 'createdAt'
    >
  >;
}

const versionSummary = {
  id: true,
  version: true,
  origin: true,
  contentHash: true,
  totalParagraphs: true,
  readyParagraphs: true,
  createdBy: true,
  createdAt: true,
} as const;

/**
 * Loads the snapshot's evidence registry, findings, claims, and the approved blueprint.
 * Rejects with 422 if the blueprint has not been approved yet (H1 required).
 */
async function loadContext(
  projectId: string,
  snapshotId: string,
): Promise<{
  snapshotId: string;
  manuscript: { id: string };
  approvedBlueprint: { id: string; version: number; content: BlueprintContent };
  context: ParagraphPlanContext;
}> {
  const snapshot = await prisma.reviewSnapshot.findFirst({
    where: { id: snapshotId, projectId },
    select: {
      id: true,
      researchQuestions: { select: { externalId: true, code: true, text: true }, orderBy: { externalId: 'asc' } },
      claims: {
        select: {
          externalId: true,
          title: true,
          researchQuestion: { select: { externalId: true } },
          items: {
            select: {
              finding: { select: { externalId: true } },
            },
          },
        },
        orderBy: { externalId: 'asc' },
      },
      findings: {
        select: {
          externalId: true,
          fieldName: true,
          valueText: true,
          isNotReported: true,
          study: { select: { externalId: true } },
          evidence: {
            select: {
              evidence: { select: { externalId: true } },
            },
          },
        },
        orderBy: { externalId: 'asc' },
      },
      evidence: {
        select: {
          externalId: true,
          quote: true,
          study: { select: { externalId: true } },
        },
        orderBy: { externalId: 'asc' },
      },
    },
  });

  if (!snapshot) throw new NotFoundError('Snapshot not found', 'SNAPSHOT_NOT_FOUND');

  const manuscript = await prisma.manuscript.findUnique({ where: { snapshotId } });
  if (!manuscript) {
    throw new NotFoundError('Manuscript not found for this snapshot. Generate a blueprint first.', 'MANUSCRIPT_NOT_FOUND');
  }

  const approvedBlueprint = await getApprovedBlueprint(manuscript.id);
  if (!approvedBlueprint) {
    throw new AppError(
      'The blueprint must be approved by the SLR project owner (H1) before planning paragraphs',
      422,
      'BLUEPRINT_NOT_APPROVED',
    );
  }

  return {
    snapshotId: snapshot.id,
    manuscript,
    approvedBlueprint: {
      id: approvedBlueprint.id,
      version: approvedBlueprint.version,
      content: approvedBlueprint.content as BlueprintContent,
    },
    context: {
      blueprint: {
        version: approvedBlueprint.version,
        content: approvedBlueprint.content as BlueprintContent,
      },
      researchQuestions: snapshot.researchQuestions,
      claims: snapshot.claims.map((claim) => ({
        externalId: claim.externalId,
        title: claim.title,
        researchQuestionExternalId: claim.researchQuestion?.externalId ?? null,
        findingExternalIds: claim.items
          .map((it) => it.finding?.externalId)
          .filter((fid): fid is string => typeof fid === 'string'),
      })),
      findings: snapshot.findings.map((f) => ({
        externalId: f.externalId,
        fieldName: f.fieldName,
        valueText: f.valueText,
        isNotReported: f.isNotReported,
        studyExternalId: f.study.externalId,
        evidenceExternalIds: f.evidence.map((ef) => ef.evidence.externalId),
      })),
      evidence: snapshot.evidence.map((e) => ({
        externalId: e.externalId,
        quote: e.quote,
        studyExternalId: e.study.externalId,
      })),
    },
  };
}

const latestRevision = (client: Prisma.TransactionClient | typeof prisma, manuscriptId: string) =>
  client.paragraphPlanRevision.findFirst({ where: { manuscriptId }, orderBy: { version: 'desc' } });

/**
 * Generates initial ParagraphPlans from the approved Blueprint and Snapshot findings/evidence.
 * Idempotent: if plans already exist, returns the latest version untouched.
 */
export async function createParagraphPlans(params: {
  projectId: string;
  snapshotId: string;
  actor: string;
}) {
  const { context, snapshotId, manuscript, approvedBlueprint } = await loadContext(params.projectId, params.snapshotId);

  // Fast path: if plans already exist, return latest revision without acquiring lock
  const existingRevision = await latestRevision(prisma, manuscript.id);
  if (existingRevision) return { revision: existingRevision, created: false };

  const content = generateParagraphPlans(context);
  const checked = paragraphPlanContentSchema.safeParse(content);
  if (!checked.success) {
    throw new AppError(
      'Paragraph plans cannot be generated: structure violates plan bounds or has unstorable characters',
      422,
      'PARAGRAPH_PLANS_NOT_GENERATABLE',
    );
  }
  const contentHash = hashOfJson(content);
  const totalParagraphs = content.plans.length;
  const readyParagraphs = content.plans.filter((p) => p.status === 'READY_TO_DRAFT').length;

  return exclusiveForSnapshot(snapshotId, () =>
    prisma.$transaction(async (tx) => {
      await takeSnapshotLock(tx, snapshotId);
      const existing = await latestRevision(tx, manuscript.id);
      if (existing) return { revision: existing, created: false };

      const revision = await tx.paragraphPlanRevision.create({
        data: {
          manuscriptId: manuscript.id,
          version: 1,
          blueprintRevisionId: approvedBlueprint.id,
          content: json(content),
          contentHash,
          origin: 'generated',
          totalParagraphs,
          readyParagraphs,
          createdBy: params.actor,
        },
      });

      await tx.provenanceEvent.create({
        data: {
          projectId: params.projectId,
          snapshotId,
          actor: params.actor,
          activity: 'manuscript.paragraph_plan.generate',
          method: 'paragraph-plan-rules@1',
          inputRefs: json({
            snapshotId,
            blueprintRevisionId: approvedBlueprint.id,
            blueprintVersion: approvedBlueprint.version,
          }),
          outputRefs: json({
            revisionId: revision.id,
            version: 1,
            contentHash,
            totalParagraphs,
            readyParagraphs,
          }),
        },
      });

      return { revision, created: true };
    }, WRITE_TRANSACTION_OPTIONS),
  );
}

/**
 * Saves an edited set of ParagraphPlans as the next version.
 * Checks baseVersion to prevent overwriting concurrent work (409 Conflict).
 */
export async function updateParagraphPlans(params: {
  projectId: string;
  snapshotId: string;
  actor: string;
  baseVersion: number;
  content: ParagraphPlanContent;
}) {
  const { context, snapshotId, manuscript, approvedBlueprint } = await loadContext(params.projectId, params.snapshotId);

  // Validate schema and storable bounds
  const checked = paragraphPlanContentSchema.safeParse(params.content);
  if (!checked.success) {
    throw new AppError(
      'Invalid paragraph plan content: exceeds limits or contains unstorable characters',
      400,
      'INVALID_PARAGRAPH_PLANS',
    );
  }

  const contentHash = hashOfJson(params.content);
  const totalParagraphs = params.content.plans.length;
  const readyParagraphs = params.content.plans.filter((p) => p.status === 'READY_TO_DRAFT').length;

  return exclusiveForSnapshot(snapshotId, () =>
    prisma.$transaction(async (tx) => {
      await takeSnapshotLock(tx, snapshotId);
      const latest = await latestRevision(tx, manuscript.id);
      if (!latest) {
        throw new NotFoundError('No paragraph plans exist yet. Create initial plans first.', 'PARAGRAPH_PLANS_NOT_FOUND');
      }

      if (latest.version !== params.baseVersion) {
        throw new ConflictError(
          `Paragraph plans are at version ${latest.version}, not ${params.baseVersion}. Reload and try again.`,
          'STALE_PLAN',
        );
      }

      // If the content is identical byte-for-byte, return without creating a redundant version
      if (latest.contentHash === contentHash) {
        return { revision: latest, created: false };
      }

      const revision = await tx.paragraphPlanRevision.create({
        data: {
          manuscriptId: manuscript.id,
          version: latest.version + 1,
          blueprintRevisionId: approvedBlueprint.id,
          content: json(params.content),
          contentHash,
          origin: 'edited',
          totalParagraphs,
          readyParagraphs,
          createdBy: params.actor,
        },
      });

      await tx.provenanceEvent.create({
        data: {
          projectId: params.projectId,
          snapshotId,
          actor: params.actor,
          activity: 'manuscript.paragraph_plan.edit',
          method: 'user-edit',
          inputRefs: json({
            baseRevisionId: latest.id,
            baseVersion: latest.version,
            blueprintRevisionId: approvedBlueprint.id,
          }),
          outputRefs: json({
            revisionId: revision.id,
            version: revision.version,
            contentHash,
            totalParagraphs,
            readyParagraphs,
          }),
        },
      });

      return { revision, created: true };
    }, WRITE_TRANSACTION_OPTIONS),
  );
}

/**
 * Returns the latest (or a specific) version of ParagraphPlans along with its validation report.
 */
export async function getParagraphPlansView(params: {
  projectId: string;
  snapshotId: string;
  version?: number;
}): Promise<ParagraphPlanView> {
  const { context, manuscript } = await loadContext(params.projectId, params.snapshotId);

  let revision: ParagraphPlanRevision | null = null;
  if (params.version !== undefined) {
    if (!Number.isInteger(params.version) || params.version < 1) {
      throw new AppError('Invalid version number', 400, 'INVALID_VERSION');
    }
    revision = await prisma.paragraphPlanRevision.findUnique({
      where: { manuscriptId_version: { manuscriptId: manuscript.id, version: params.version } },
    });
  } else {
    revision = await latestRevision(prisma, manuscript.id);
  }

  if (!revision) {
    throw new NotFoundError(
      params.version !== undefined
        ? `Paragraph plan version ${params.version} not found`
        : 'There are no paragraph plans for this snapshot yet',
      'PARAGRAPH_PLANS_NOT_FOUND',
    );
  }

  const issues = validateParagraphPlans(revision.content as unknown as ParagraphPlanContent, context);
  const versions = await prisma.paragraphPlanRevision.findMany({
    where: { manuscriptId: manuscript.id },
    select: versionSummary,
    orderBy: { version: 'desc' },
  });

  return {
    revision,
    issues,
    readyToDraft: !hasBlockingIssue(issues) && revision.readyParagraphs > 0,
    stats: {
      totalParagraphs: revision.totalParagraphs,
      readyParagraphs: revision.readyParagraphs,
    },
    versions,
  };
}

