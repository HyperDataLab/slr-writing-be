import type { Prisma, BlueprintRevision, Approval } from '../../generated/prisma/client.js';
import { prisma } from '../../config/prisma.js';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { hashOfJson } from '../../shared/utils/stable-json.js';
import { assertSlrOwner, latestDecision, statusOf, type ApprovalDecision, type ApprovalStatus } from '../approvals/approvals.service.js';
import { getJournalProfile } from '../journal-profiles/journal-profiles.service.js';
import { ensureManuscript, exclusiveForSnapshot, takeSnapshotLock, WRITE_TRANSACTION_OPTIONS } from '../manuscripts/manuscript.store.js';
import { generateBlueprint } from './blueprint-generator.js';
import { hasBlockingIssue, validateBlueprint } from './blueprint-validator.js';
import { blueprintContentSchema, type BlueprintContent, type BlueprintContext, type BlueprintIssue } from './blueprint.types.js';

export const BLUEPRINT_TARGET_KIND = 'blueprint_revision';
export const DEFAULT_PROFILE_ID = 'generic-imrad';

const json = (value: unknown) => value as Prisma.InputJsonValue;

export interface BlueprintView {
  revision: BlueprintRevision;
  issues: BlueprintIssue[];
  /** True when the blueprint has no blocking issue, so it can be approved. */
  approvable: boolean;
  approval: { status: ApprovalStatus; decision: Approval | null };
  versions: Array<Pick<BlueprintRevision, 'id' | 'version' | 'origin' | 'contentHash' | 'createdBy' | 'createdAt'>>;
}

const versionSummary = { id: true, version: true, origin: true, contentHash: true, createdBy: true, createdAt: true } as const;

/** The snapshot's themes and research questions, as plain data for the generator and the validator. */
async function loadContext(projectId: string, snapshotId: string, profileId: string): Promise<{ context: BlueprintContext; snapshotId: string }> {
  const snapshot = await prisma.reviewSnapshot.findFirst({
    where: { id: snapshotId, projectId },
    select: {
      id: true,
      researchQuestions: { select: { externalId: true, code: true, text: true }, orderBy: { externalId: 'asc' } },
      claims: { select: { externalId: true, title: true, researchQuestion: { select: { externalId: true } } }, orderBy: { externalId: 'asc' } },
    },
  });
  if (!snapshot) throw new NotFoundError('Snapshot not found', 'SNAPSHOT_NOT_FOUND');
  return {
    snapshotId: snapshot.id,
    context: {
      profile: getJournalProfile(profileId),
      researchQuestions: snapshot.researchQuestions,
      claims: snapshot.claims.map((claim) => ({
        externalId: claim.externalId, title: claim.title, researchQuestionExternalId: claim.researchQuestion?.externalId ?? null,
      })),
    },
  };
}

/** Validates against the profile the blueprint names. A profile that no longer exists is itself a blocking issue. */
async function issuesFor(projectId: string, snapshotId: string, content: BlueprintContent): Promise<BlueprintIssue[]> {
  try {
    const { context } = await loadContext(projectId, snapshotId, content.profile.id);
    return validateBlueprint(content, context);
  } catch (error) {
    if (error instanceof AppError && error.code === 'JOURNAL_PROFILE_NOT_FOUND') {
      return [{ code: 'PROFILE_UNKNOWN', severity: 'blocking', message: `The profile ${content.profile.id} does not exist`, ref: content.profile.id }];
    }
    throw error;
  }
}

const latestRevision = (client: Prisma.TransactionClient | typeof prisma, manuscriptId: string) =>
  client.blueprintRevision.findFirst({ where: { manuscriptId }, orderBy: { version: 'desc' } });

/** Creates the first blueprint from the profile and the snapshot. If one exists, it is returned untouched: edits are never overwritten. */
export async function createBlueprint(params: { projectId: string; snapshotId: string; actor: string; profileId?: string }) {
  const { context, snapshotId } = await loadContext(params.projectId, params.snapshotId, params.profileId ?? DEFAULT_PROFILE_ID);

  // Fast path: once a blueprint exists, a repeated call changes nothing and needs neither the lock nor a transaction.
  const existingManuscript = await prisma.manuscript.findUnique({ where: { snapshotId } });
  const existingRevision = existingManuscript ? await latestRevision(prisma, existingManuscript.id) : null;
  if (existingRevision) return { revision: existingRevision, created: false };

  const content = generateBlueprint(context);
  // What the generator makes must be something the editor can save again. If a snapshot has data the schema cannot hold
  // (for example more than 1000 themes), say so now instead of leaving a blueprint nobody can edit.
  const checked = blueprintContentSchema.safeParse(content);
  if (!checked.success) {
    throw new AppError('A blueprint cannot be made from this snapshot: it has more themes than a blueprint can hold, or a theme the schema rejects', 422, 'BLUEPRINT_NOT_GENERATABLE');
  }
  const contentHash = hashOfJson(content);

  return exclusiveForSnapshot(snapshotId, () => prisma.$transaction(async (tx) => {
    await takeSnapshotLock(tx, snapshotId);
    const manuscript = await ensureManuscript(tx, { projectId: params.projectId, snapshotId, actor: params.actor });
    const existing = await latestRevision(tx, manuscript.id);
    if (existing) return { revision: existing, created: false };

    const revision = await tx.blueprintRevision.create({
      data: {
        manuscriptId: manuscript.id, version: 1, profileId: content.profile.id, profileVersion: content.profile.version,
        content: json(content), contentHash, origin: 'generated', createdBy: params.actor,
      },
    });
    await tx.provenanceEvent.create({
      data: {
        projectId: params.projectId, snapshotId, actor: params.actor, activity: 'manuscript.blueprint.generate', method: 'blueprint-rules@1',
        inputRefs: json({ snapshotId, profile: content.profile }),
        outputRefs: json({ revisionId: revision.id, version: 1, contentHash }),
      },
    });
    return { revision, created: true };
  }, WRITE_TRANSACTION_OPTIONS));
}

/**
 * Stores an edited blueprint as the next version. The caller says which version it started from; if someone saved in
 * between, the save is refused (409) instead of silently overwriting their work. A draft with problems can be saved:
 * the problems are reported and only block the approval.
 */
export async function saveBlueprint(params: { projectId: string; snapshotId: string; actor: string; baseVersion: number; content: BlueprintContent }) {
  const { snapshotId } = await loadContext(params.projectId, params.snapshotId, params.content.profile.id).catch((error: unknown) => {
    if (error instanceof AppError && error.code === 'JOURNAL_PROFILE_NOT_FOUND') {
      throw new BadRequestError(`The profile ${params.content.profile.id} does not exist`, 'INVALID_BLUEPRINT');
    }
    throw error;
  });
  const contentHash = hashOfJson(params.content);

  return exclusiveForSnapshot(snapshotId, () => prisma.$transaction(async (tx) => {
    await takeSnapshotLock(tx, snapshotId);
    const manuscript = await tx.manuscript.findUnique({ where: { snapshotId } });
    const latest = manuscript ? await latestRevision(tx, manuscript.id) : null;
    if (!manuscript || !latest) throw new NotFoundError('There is no blueprint for this snapshot yet', 'BLUEPRINT_NOT_FOUND');
    if (latest.version !== params.baseVersion) {
      throw new ConflictError(`The blueprint is at version ${latest.version}, not ${params.baseVersion}. Load the latest version and apply the change to it.`, 'STALE_BLUEPRINT');
    }
    if (latest.contentHash === contentHash) return { revision: latest, created: false };

    const revision = await tx.blueprintRevision.create({
      data: {
        manuscriptId: manuscript.id, version: latest.version + 1, profileId: params.content.profile.id, profileVersion: params.content.profile.version,
        content: json(params.content), contentHash, origin: 'edited', createdBy: params.actor,
      },
    });
    await tx.provenanceEvent.create({
      data: {
        projectId: params.projectId, snapshotId, actor: params.actor, activity: 'manuscript.blueprint.edit', method: 'user-edit',
        inputRefs: json({ previousRevisionId: latest.id, previousVersion: latest.version }),
        outputRefs: json({ revisionId: revision.id, version: revision.version, contentHash }),
      },
    });
    return { revision, created: true };
  }, WRITE_TRANSACTION_OPTIONS));
}

async function viewOf(projectId: string, snapshotId: string, manuscriptId: string, revision: BlueprintRevision): Promise<BlueprintView> {
  const content = revision.content as BlueprintContent;
  const [issues, decision, versions] = await Promise.all([
    issuesFor(projectId, snapshotId, content),
    latestDecision(prisma, { manuscriptId, stage: 'H1', targetKind: BLUEPRINT_TARGET_KIND, targetId: revision.id }),
    prisma.blueprintRevision.findMany({ where: { manuscriptId }, orderBy: { version: 'asc' }, select: versionSummary }),
  ]);
  return { revision, issues, approvable: !hasBlockingIssue(issues), approval: { status: statusOf(decision), decision }, versions };
}

async function findManuscript(projectId: string, snapshotId: string) {
  const snapshot = await prisma.reviewSnapshot.findFirst({ where: { id: snapshotId, projectId }, select: { id: true } });
  if (!snapshot) throw new NotFoundError('Snapshot not found', 'SNAPSHOT_NOT_FOUND');
  return prisma.manuscript.findUnique({ where: { snapshotId } });
}

/** The latest version of the blueprint with its issues and the state of its approval. */
export async function getBlueprint(projectId: string, snapshotId: string): Promise<BlueprintView> {
  const manuscript = await findManuscript(projectId, snapshotId);
  const revision = manuscript ? await latestRevision(prisma, manuscript.id) : null;
  if (!manuscript || !revision) throw new NotFoundError('There is no blueprint for this snapshot yet', 'BLUEPRINT_NOT_FOUND');
  return viewOf(projectId, snapshotId, manuscript.id, revision);
}

export async function getBlueprintRevision(projectId: string, snapshotId: string, version: number): Promise<BlueprintView> {
  const manuscript = await findManuscript(projectId, snapshotId);
  const revision = manuscript
    ? await prisma.blueprintRevision.findUnique({ where: { manuscriptId_version: { manuscriptId: manuscript.id, version } } })
    : null;
  if (!manuscript || !revision) throw new NotFoundError('Blueprint version not found', 'BLUEPRINT_REVISION_NOT_FOUND');
  return viewOf(projectId, snapshotId, manuscript.id, revision);
}

/**
 * H1: the OWNER of the SLR project approves or rejects the latest version of the blueprint.
 * - the role is asked of slr-be first, before anything is written;
 * - only the latest version can be decided (409 otherwise), because an approval of an old version approves nothing now;
 * - an approval needs a blueprint with no blocking issue (422 BLUEPRINT_NOT_APPROVABLE);
 * - deciding the same way again, with the same note or none, records nothing new; a different note is a new decision.
 *
 * The issues are worked out before the transaction opens, because working them out reads the snapshot with its own
 * connection; doing that while holding a transaction's connection starves the pool when several decisions arrive at once.
 * The transaction then checks that the version it judged is still the latest, so a decision never lands on a version
 * that was replaced in between.
 */
export async function decideBlueprint(params: {
  projectId: string; snapshotId: string; slrProjectId: string; authorization: string | undefined;
  actor: string; version: number; decision: ApprovalDecision; note: string | null;
}) {
  const slrRole = await assertSlrOwner({ slrProjectId: params.slrProjectId, authorization: params.authorization });
  const manuscript = await findManuscript(params.projectId, params.snapshotId);
  if (!manuscript) throw new NotFoundError('There is no blueprint for this snapshot yet', 'BLUEPRINT_NOT_FOUND');

  return exclusiveForSnapshot(params.snapshotId, async () => {
    const judged = await latestRevision(prisma, manuscript.id);
    if (!judged) throw new NotFoundError('There is no blueprint for this snapshot yet', 'BLUEPRINT_NOT_FOUND');
    if (judged.version !== params.version) {
      throw new ConflictError(`The blueprint is at version ${judged.version}, not ${params.version}. Only the latest version can be decided.`, 'STALE_BLUEPRINT');
    }
    if (params.decision === 'APPROVED') {
      const issues = await issuesFor(params.projectId, params.snapshotId, judged.content as BlueprintContent);
      if (hasBlockingIssue(issues)) {
        throw new AppError('The blueprint has blocking issues and cannot be approved', 422, 'BLUEPRINT_NOT_APPROVABLE', true, { issues });
      }
    }

    return prisma.$transaction(async (tx) => {
      await takeSnapshotLock(tx, params.snapshotId);
      const latest = await latestRevision(tx, manuscript.id);
      if (!latest || latest.id !== judged.id) {
        throw new ConflictError('The blueprint changed while it was being checked. Load the latest version and decide again.', 'STALE_BLUEPRINT');
      }
      const target = { manuscriptId: manuscript.id, stage: 'H1' as const, targetKind: BLUEPRINT_TARGET_KIND, targetId: latest.id };

      const previous = await latestDecision(tx, target);
      if (previous && previous.decision === params.decision && (params.note === null || previous.note === params.note)) {
        return { approval: previous, created: false };
      }

      const approval = await tx.approval.create({
        data: {
          ...target, targetHash: latest.contentHash, decision: params.decision, note: params.note, decidedBy: params.actor, slrRole,
        },
      });
      await tx.provenanceEvent.create({
        data: {
          projectId: params.projectId, snapshotId: params.snapshotId, actor: params.actor, activity: `approval.H1.${params.decision.toLowerCase()}`,
          method: 'owner-decision',
          inputRefs: json({ revisionId: latest.id, version: latest.version, contentHash: latest.contentHash }),
          outputRefs: json({ approvalId: approval.id, slrRole }),
          notes: params.note,
        },
      });
      return { approval, created: true };
    }, WRITE_TRANSACTION_OPTIONS);
  });
}

/**
 * For the steps after H1: the latest blueprint, only if its latest decision is an approval. Anything else, including a
 * blueprint that was edited after it was approved, gives null, and the next step must not start.
 */
export async function getApprovedBlueprint(manuscriptId: string): Promise<BlueprintRevision | null> {
  const revision = await latestRevision(prisma, manuscriptId);
  if (!revision) return null;
  const decision = await latestDecision(prisma, { manuscriptId, stage: 'H1', targetKind: BLUEPRINT_TARGET_KIND, targetId: revision.id });
  return statusOf(decision) === 'APPROVED' ? revision : null;
}
