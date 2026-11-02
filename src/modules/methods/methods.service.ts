import { createHash } from 'node:crypto';
import { Prisma, type SectionRevision } from '../../generated/prisma/client.js';
import { prisma } from '../../config/prisma.js';
import { METHODS_GENERATOR } from '../../shared/constants/generators.js';
import { ensureManuscript, exclusiveForSnapshot, takeSnapshotLock, WRITE_TRANSACTION_OPTIONS } from '../manuscripts/manuscript.store.js';
import { AppError, NotFoundError } from '../../shared/errors/app-error.js';
import { extractMethodsFacts } from './methods-facts.js';
import { findUngroundedNumbers } from './methods-grounding.js';
import { renderMethods } from './methods-renderer.js';
import type { Fact } from './methods.types.js';

export const METHODS_SECTION = 'methods';

// Defined with the other generators, so a journal profile can only name one that exists. Re-exported for callers of this module.
export { METHODS_GENERATOR };

export interface MethodsWarning {
  code: string;
  severity: 'warning';
  message: string;
  ref?: string;
}

export interface GenerateResult {
  revision: SectionRevision;
  /** False when the snapshot gives the same text as the latest version, so no new version was stored. */
  created: boolean;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

/** JSON with sorted keys, so equal content always hashes the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The hash is of the text and the generator only. A change that leaves the text byte-identical (for example only the
// id of a search source) is not a new version; the facts stored with a version are those of the run that wrote its text.
const hashOf = (markdown: string): string =>
  `sha256:${createHash('sha256').update(stable({ markdown, generator: METHODS_GENERATOR })).digest('hex')}`;

async function loadSnapshot(projectId: string, snapshotId: string) {
  const snapshot = await prisma.reviewSnapshot.findFirst({
    where: { id: snapshotId, projectId },
    select: {
      id: true, integrityHash: true, issues: true,
      artifacts: { where: { artifactType: { in: ['A10', 'A2'] } }, select: { artifactType: true, payload: true } },
      supplements: { where: { kind: 'prisma_writing_export' }, select: { payload: true } },
      _count: { select: { studies: true } },
    },
  });
  if (!snapshot) throw new NotFoundError('Snapshot not found', 'SNAPSHOT_NOT_FOUND');
  return snapshot;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Warnings shown with a revision: facts the snapshot lacks, and the PRISMA issues the import recorded. */
function warningsFor(facts: Fact[], snapshotIssues: unknown): MethodsWarning[] {
  const fromFacts = facts.filter((fact) => fact.status === 'missing').map((fact): MethodsWarning => ({
    code: 'FACT_MISSING', severity: 'warning', message: `${fact.label} is not in the snapshot, so the text says it was not reported`, ref: fact.key,
  }));
  const fromSnapshot = (Array.isArray(snapshotIssues) ? snapshotIssues : [])
    .map(asRecord)
    .filter((issue): issue is Record<string, unknown> => issue !== undefined && typeof issue.code === 'string' && issue.code.startsWith('PRISMA_'))
    .map((issue): MethodsWarning => ({
      code: String(issue.code), severity: 'warning', message: String(issue.message ?? ''), ...(typeof issue.ref === 'string' ? { ref: issue.ref } : {}),
    }));
  return [...fromSnapshot, ...fromFacts];
}

/**
 * Writes the Methods section from a snapshot, deterministically: the same snapshot always gives the same text.
 * A new version is stored only when the text changed; otherwise the latest version is returned.
 * Fail closed: if the text holds a number that no fact contains, nothing is stored.
 */
export async function generateMethods(params: { projectId: string; snapshotId: string; actor: string }): Promise<GenerateResult> {
  const snapshot = await loadSnapshot(params.projectId, params.snapshotId);
  const payload = (type: string) => asRecord(snapshot.artifacts.find((artifact) => artifact.artifactType === type)?.payload);
  const a10 = payload('A10');
  if (!a10) throw new AppError('The snapshot has no A10 artifact, so there is nothing to write Methods from', 422, 'METHODS_INPUT_MISSING');

  const facts = extractMethodsFacts({
    a10, a2: payload('A2'), prismaExport: asRecord(snapshot.supplements[0]?.payload), studyCount: snapshot._count.studies,
  });
  const draft = renderMethods(facts);
  const ungrounded = findUngroundedNumbers(draft.markdown, facts);
  if (ungrounded.length > 0) {
    throw new AppError('The generated text contains a number that is not in the snapshot', 500, 'METHODS_UNGROUNDED_NUMBER', false);
  }

  const warnings = warningsFor(facts, snapshot.issues);
  const contentHash = hashOf(draft.markdown);

  // Fast path: the common repeated request finds the text unchanged, and needs neither the lock nor a transaction.
  const knownSection = await prisma.manuscriptSection.findFirst({
    where: { manuscript: { snapshotId: snapshot.id }, sectionKey: METHODS_SECTION }, select: { id: true },
  });
  if (knownSection) {
    const known = await prisma.sectionRevision.findFirst({ where: { sectionId: knownSection.id }, orderBy: { version: 'desc' } });
    if (known && known.contentHash === contentHash) return { revision: known, created: false };
  }

  // Writers of one snapshot (Methods, the blueprint, their approvals) take turns: first in memory, holding no connection,
  // then on a database lock for other server instances. The second writer finds the first one's version and adds none.
  return exclusiveForSnapshot(snapshot.id, () => prisma.$transaction(async (tx) => {
    await takeSnapshotLock(tx, snapshot.id);
    const manuscript = await ensureManuscript(tx, { projectId: params.projectId, snapshotId: snapshot.id, actor: params.actor });
    const section = await tx.manuscriptSection.upsert({
      where: { manuscriptId_sectionKey: { manuscriptId: manuscript.id, sectionKey: METHODS_SECTION } },
      create: { manuscriptId: manuscript.id, sectionKey: METHODS_SECTION },
      update: {},
    });
    const latest = await tx.sectionRevision.findFirst({ where: { sectionId: section.id }, orderBy: { version: 'desc' } });
    if (latest && latest.contentHash === contentHash) return { revision: latest, created: false };

    const revision = await tx.sectionRevision.create({
      data: {
        sectionId: section.id, version: (latest?.version ?? 0) + 1, markdown: draft.markdown, facts: json(facts),
        warnings: json(warnings), generator: METHODS_GENERATOR, contentHash, createdBy: params.actor,
      },
    });
    await tx.provenanceEvent.create({
      data: {
        projectId: params.projectId, snapshotId: snapshot.id, actor: params.actor, activity: 'manuscript.methods.generate',
        method: METHODS_GENERATOR,
        inputRefs: json({ snapshotId: snapshot.id, snapshotIntegrityHash: snapshot.integrityHash }),
        outputRefs: json({ revisionId: revision.id, version: revision.version, contentHash }),
        notes: `${warnings.length} warning(s)`,
      },
    });
    return { revision, created: true };
  }, WRITE_TRANSACTION_OPTIONS));
}

const revisionSummary = { id: true, version: true, generator: true, contentHash: true, createdBy: true, createdAt: true } as const;

async function findSection(projectId: string, snapshotId: string) {
  await loadSnapshot(projectId, snapshotId);
  return prisma.manuscriptSection.findFirst({ where: { manuscript: { snapshotId }, sectionKey: METHODS_SECTION } });
}

/** The latest version of Methods for a snapshot, with the list of all versions (without their text). */
export async function getLatestMethods(projectId: string, snapshotId: string) {
  const section = await findSection(projectId, snapshotId);
  const latest = section ? await prisma.sectionRevision.findFirst({ where: { sectionId: section.id }, orderBy: { version: 'desc' } }) : null;
  if (!section || !latest) throw new NotFoundError('Methods has not been generated for this snapshot', 'METHODS_NOT_GENERATED');
  const versions = await prisma.sectionRevision.findMany({ where: { sectionId: section.id }, orderBy: { version: 'asc' }, select: revisionSummary });
  return { revision: latest, versions };
}

export async function getMethodsRevision(projectId: string, snapshotId: string, version: number) {
  const section = await findSection(projectId, snapshotId);
  const revision = section ? await prisma.sectionRevision.findUnique({ where: { sectionId_version: { sectionId: section.id, version } } }) : null;
  if (!revision) throw new NotFoundError('Methods version not found', 'METHODS_REVISION_NOT_FOUND');
  return revision;
}
