import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../config/prisma.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { SUMMARY_LLM_GENERATOR } from '../../shared/constants/generators.js';
import { latestDecision, statusOf } from '../approvals/approvals.service.js';
import { getApprovedBlueprint } from '../blueprint/blueprint.service.js';
import type { BlueprintContent } from '../blueprint/blueprint.types.js';
import { SECTION_TARGET_KIND } from '../drafting/drafting.service.js';
import { getJournalProfile } from '../journal-profiles/journal-profiles.service.js';
import { getLlmProvider } from '../llm/llm.service.js';
import { ensureManuscript, exclusiveForSnapshot, takeSnapshotLock, WRITE_TRANSACTION_OPTIONS } from '../manuscripts/manuscript.store.js';
import { loadRequiredSections } from '../manuscripts/required-sections.js';
import {
  buildSummaryPrompts,
  SUMMARY_PROMPT_IDS,
  SUMMARY_PROMPT_VERSION,
  summaryOutputSchema,
  validateSummaryOutput,
  type SummaryInput,
  type SummarySource,
  type SynthesisSectionKey,
} from './summary-sections.js';

const json = (value: unknown) => value as Prisma.InputJsonValue;

const hashOf = (markdown: string): string =>
  `sha256:${createHash('sha256').update(JSON.stringify({ markdown, generator: SUMMARY_LLM_GENERATOR })).digest('hex')}`;

/** What a synthesis section records about the sections it was written from, so a later change to one can be detected. */
export interface SummarySourceRef {
  sectionKey: string;
  version: number;
  contentHash: string;
}

/**
 * Writes the Abstract or the Conclusion from the approved (H2) sections of the manuscript.
 * Fail-closed: every section the engine can draft must already be approved, the blueprint must include the section,
 * and the model's text must pass the checks in summary-sections.ts before anything is stored.
 */
export async function generateSynthesisSection(params: {
  projectId: string;
  snapshotId: string;
  actor: string;
  sectionKey: SynthesisSectionKey;
}) {
  const snapshot = await prisma.reviewSnapshot.findFirst({
    where: { id: params.snapshotId, projectId: params.projectId },
    select: {
      id: true,
      researchQuestions: { select: { code: true, text: true }, orderBy: { externalId: 'asc' } },
      studies: { select: { id: true } },
      supplements: { where: { kind: 'prisma_writing_export' }, select: { payload: true } },
    },
  });
  if (!snapshot) throw new NotFoundError('Snapshot not found', 'SNAPSHOT_NOT_FOUND');

  const manuscript = await prisma.manuscript.findUnique({ where: { snapshotId: snapshot.id } });
  if (!manuscript) throw new NotFoundError('Manuscript not found for this snapshot', 'MANUSCRIPT_NOT_FOUND');

  const approvedBlueprint = await getApprovedBlueprint(manuscript.id);
  if (!approvedBlueprint) {
    throw new AppError('The manuscript blueprint must be approved by the SLR project owner (H1) before drafting', 422, 'BLUEPRINT_NOT_APPROVED');
  }
  const blueprint = approvedBlueprint.content as unknown as BlueprintContent;
  if (!blueprint.sections.find((section) => section.key === params.sectionKey)?.include) {
    throw new AppError(`The approved blueprint does not include the ${params.sectionKey} section`, 422, 'SECTION_NOT_INCLUDED');
  }

  // 1. Sources: every section the engine can draft, each at its latest revision and approved by the OWNER.
  const { required } = await loadRequiredSections(manuscript.id, blueprint);
  const sourceKeys = required.filter((key) => key !== params.sectionKey);
  const sections = await prisma.manuscriptSection.findMany({
    where: { manuscriptId: manuscript.id, sectionKey: { in: sourceKeys } },
    include: { revisions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  const problems: Array<{ sectionKey: string; reason: string }> = [];
  const sources: SummarySource[] = [];
  for (const key of sourceKeys) {
    const revision = sections.find((section) => section.sectionKey === key)?.revisions[0];
    if (!revision) {
      problems.push({ sectionKey: key, reason: 'not drafted' });
      continue;
    }
    const decision = await latestDecision(prisma, { manuscriptId: manuscript.id, stage: 'H2', targetKind: SECTION_TARGET_KIND, targetId: revision.id });
    if (statusOf(decision) !== 'APPROVED') {
      problems.push({ sectionKey: key, reason: `latest version v${revision.version} is not approved` });
      continue;
    }
    sources.push({ sectionKey: key, version: revision.version, contentHash: revision.contentHash, markdown: revision.markdown });
  }
  if (problems.length > 0) {
    throw new AppError(
      `The ${params.sectionKey} is written from the approved sections. Draft and approve (H2) first: ${problems.map((p) => `${p.sectionKey} (${p.reason})`).join('; ')}`,
      422,
      'SOURCE_SECTIONS_NOT_APPROVED',
      true,
      { sections: problems },
    );
  }

  // 2. Ask the model, then check what it wrote.
  const profile = getJournalProfile(approvedBlueprint.profileId);
  const budget = profile.sections.find((section) => section.key === params.sectionKey)?.wordBudget ?? { min: 150, max: 300 };
  const flow = (snapshot.supplements[0]?.payload as { flow?: Record<string, unknown> } | undefined)?.flow ?? null;
  const input: SummaryInput = {
    sectionKey: params.sectionKey,
    researchQuestions: snapshot.researchQuestions,
    prismaFlow: flow,
    sources,
    wordBudget: budget,
  };
  const { system, prompt } = buildSummaryPrompts(input);
  const result = await getLlmProvider().generateStructured({
    promptTemplateId: SUMMARY_PROMPT_IDS[params.sectionKey],
    promptTemplateVersion: SUMMARY_PROMPT_VERSION,
    system,
    prompt,
    schema: summaryOutputSchema,
  });
  const checked = validateSummaryOutput(result.output, input, snapshot.studies.length);
  if (!checked.ok) {
    throw new AppError(checked.message, 422, checked.code, true, checked.details);
  }

  const markdown = checked.paragraphs.join('\n\n');
  const contentHash = hashOf(markdown);
  const sourceSections: SummarySourceRef[] = sources.map(({ sectionKey, version, contentHash: hash }) => ({ sectionKey, version, contentHash: hash }));
  // `paragraphs` keeps the shape the gates read; a summary cites nothing of its own, so no evidence or finding ids.
  const facts = {
    sectionKey: params.sectionKey,
    kind: 'synthesis',
    blueprintVersion: approvedBlueprint.version,
    sourceSections,
    paragraphs: checked.paragraphs.map((text, index) => ({
      paragraphId: `${params.sectionKey}-${index + 1}`,
      text,
      usedEvidenceIds: [],
      usedFindingIds: [],
      limitationsNoted: [],
    })),
    modelInfo: result.modelInfo,
  };

  // 3. Store, unless a source section moved while the model was writing.
  return exclusiveForSnapshot(snapshot.id, () =>
    prisma.$transaction(async (tx) => {
      await takeSnapshotLock(tx, snapshot.id);
      await ensureManuscript(tx, { projectId: params.projectId, snapshotId: snapshot.id, actor: params.actor });

      const current = await tx.manuscriptSection.findMany({
        where: { manuscriptId: manuscript.id, sectionKey: { in: sourceKeys } },
        include: { revisions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      const moved = sourceSections.some((ref) => current.find((s) => s.sectionKey === ref.sectionKey)?.revisions[0]?.contentHash !== ref.contentHash);
      if (moved) {
        throw new ConflictError('A section this text is written from changed while it was being written. Try again.', 'SOURCE_SECTION_CHANGED');
      }

      const section = await tx.manuscriptSection.upsert({
        where: { manuscriptId_sectionKey: { manuscriptId: manuscript.id, sectionKey: params.sectionKey } },
        create: { manuscriptId: manuscript.id, sectionKey: params.sectionKey },
        update: {},
      });
      const latest = await tx.sectionRevision.findFirst({ where: { sectionId: section.id }, orderBy: { version: 'desc' } });
      // Same text from the same sources: nothing new to store (an earlier approval stays valid).
      // (compared as strings: the database may store the keys of the recorded objects in another order)
      const refKey = (refs: unknown) => (Array.isArray(refs) ? (refs as SummarySourceRef[]).map((r) => `${r.sectionKey}:${r.version}:${r.contentHash}`).join('|') : '');
      if (latest && latest.contentHash === contentHash && refKey((latest.facts as { sourceSections?: unknown }).sourceSections) === refKey(sourceSections)) {
        return { revision: latest, created: false };
      }

      const revision = await tx.sectionRevision.create({
        data: {
          sectionId: section.id,
          version: (latest?.version ?? 0) + 1,
          markdown,
          facts: json(facts),
          warnings: json([]),
          generator: SUMMARY_LLM_GENERATOR,
          contentHash,
          createdBy: params.actor,
        },
      });
      await tx.provenanceEvent.create({
        data: {
          projectId: params.projectId,
          snapshotId: snapshot.id,
          actor: params.actor,
          activity: `manuscript.section.${params.sectionKey}.draft`,
          method: SUMMARY_LLM_GENERATOR,
          inputRefs: json({ snapshotId: snapshot.id, blueprintVersion: approvedBlueprint.version, sourceSections }),
          outputRefs: json({ revisionId: revision.id, version: revision.version, contentHash }),
        },
      });
      return { revision, created: true };
    }, WRITE_TRANSACTION_OPTIONS),
  );
}
