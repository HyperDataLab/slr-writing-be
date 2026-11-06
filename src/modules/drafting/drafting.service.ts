import { createHash } from 'node:crypto';
import type { Prisma, SectionRevision } from '../../generated/prisma/client.js';
import { prisma } from '../../config/prisma.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { RESULTS_LLM_GENERATOR } from '../../shared/constants/generators.js';
import { assertSlrOwner, latestDecision, statusOf, type ApprovalDecision } from '../approvals/approvals.service.js';
import { getApprovedBlueprint } from '../blueprint/blueprint.service.js';
import type { BlueprintContent } from '../blueprint/blueprint.types.js';
import { getLlmProvider } from '../llm/llm.service.js';
import { isVerificationCurrent } from '../manuscripts/required-sections.js';
import { ensureManuscript, exclusiveForSnapshot, takeSnapshotLock, WRITE_TRANSACTION_OPTIONS } from '../manuscripts/manuscript.store.js';
import type { ParagraphPlanContent } from '../paragraph-plans/paragraph-plan.types.js';
import {
  buildDraftingPrompts,
  buildMinimalEvidencePack,
  PROMPT_TEMPLATE_ID,
  PROMPT_TEMPLATE_VERSION,
  type SnapshotRegistryLookup,
  validateDraftOutput,
} from './drafting-pack.js';
import {
  paragraphDraftOutputSchema,
  type DraftedParagraph,
  type DraftSectionFacts,
  type DraftSectionView,
} from './drafting.types.js';

export const SECTION_TARGET_KIND = 'section_revision';

const json = (value: unknown) => value as Prisma.InputJsonValue;

const hashOf = (markdown: string, generator: string): string =>
  `sha256:${createHash('sha256').update(JSON.stringify({ markdown, generator })).digest('hex')}`;

const revisionSummary = {
  id: true,
  version: true,
  generator: true,
  contentHash: true,
  createdBy: true,
  createdAt: true,
} as const;

/**
 * Loads snapshot registry and verifies the approved blueprint and paragraph plans exist.
 */
async function loadDraftingContext(projectId: string, snapshotId: string) {
  const snapshot = await prisma.reviewSnapshot.findFirst({
    where: { id: snapshotId, projectId },
    select: {
      id: true,
      integrityHash: true,
      researchQuestions: { select: { externalId: true, code: true, text: true } },
      claims: { select: { externalId: true, title: true } },
      findings: {
        select: {
          externalId: true,
          fieldName: true,
          valueText: true,
          study: { select: { externalId: true, title: true } },
        },
      },
      evidence: {
        select: {
          externalId: true,
          quote: true,
          study: { select: { externalId: true } },
        },
      },
    },
  });

  if (!snapshot) throw new NotFoundError('Snapshot not found', 'SNAPSHOT_NOT_FOUND');

  const manuscript = await prisma.manuscript.findUnique({ where: { snapshotId } });
  if (!manuscript) throw new NotFoundError('Manuscript not found for this snapshot', 'MANUSCRIPT_NOT_FOUND');

  const approvedBlueprint = await getApprovedBlueprint(manuscript.id);
  if (!approvedBlueprint) {
    throw new AppError(
      'The manuscript blueprint must be approved by the SLR project owner (H1) before drafting',
      422,
      'BLUEPRINT_NOT_APPROVED',
    );
  }

  const latestPlansRev = await prisma.paragraphPlanRevision.findFirst({
    where: { manuscriptId: manuscript.id },
    orderBy: { version: 'desc' },
  });

  if (!latestPlansRev) {
    throw new NotFoundError(
      'Paragraph plans have not been generated yet. Create paragraph plans before drafting.',
      'PARAGRAPH_PLANS_NOT_FOUND',
    );
  }

  const registryLookup: SnapshotRegistryLookup = {
    claims: new Map(snapshot.claims.map((c) => [c.externalId, c])),
    findings: new Map(
      snapshot.findings.map((f) => [
        f.externalId,
        {
          externalId: f.externalId,
          fieldName: f.fieldName,
          valueText: f.valueText,
          studyId: f.study.externalId,
          studyTitle: f.study.title,
        },
      ]),
    ),
    evidence: new Map(
      snapshot.evidence.map((e) => [
        e.externalId,
        {
          externalId: e.externalId,
          quote: e.quote,
          studyId: e.study.externalId,
        },
      ]),
    ),
  };

  return {
    snapshot,
    manuscript,
    approvedBlueprint,
    latestPlansRev,
    plansContent: latestPlansRev.content as unknown as ParagraphPlanContent,
    registryLookup,
  };
}

/**
 * Generates an initial or refreshed draft for a section using the LLM.
 * Iterates through each READY_TO_DRAFT paragraph plan, invokes the LLM with its minimal evidence pack,
 * checks that only provided references were used, and persists the assembled markdown into SectionRevision.
 */
export async function generateSectionDraft(params: {
  projectId: string;
  snapshotId: string;
  actor: string;
  sectionKey: string;
}) {
  const { snapshot, manuscript, approvedBlueprint, latestPlansRev, plansContent, registryLookup } =
    await loadDraftingContext(params.projectId, params.snapshotId);

  // Filter plans for the requested section
  const sectionPlans = plansContent.plans.filter((p) => p.sectionKey === params.sectionKey);
  if (sectionPlans.length === 0) {
    throw new AppError(
      `There are no planned paragraphs for section "${params.sectionKey}" in the current paragraph plan set`,
      422,
      'NO_PLANS_FOR_SECTION',
    );
  }

  const readyPlans = sectionPlans.filter((p) => p.status === 'READY_TO_DRAFT');
  if (readyPlans.length === 0) {
    throw new AppError(
      `No paragraphs in section "${params.sectionKey}" are marked READY_TO_DRAFT. Resolve missing evidence first.`,
      422,
      'NO_READY_PARAGRAPH_PLANS',
    );
  }

  const llm = getLlmProvider();
  const draftedParagraphs: DraftedParagraph[] = [];
  let lastModelInfo: any = null;

  // Find blueprint subsections to provide section headings in the markdown
  const blueprintContent = approvedBlueprint.content as BlueprintContent;
  const sectionDef = blueprintContent.sections.find((s) => s.key === params.sectionKey);
  const subsectionMap = new Map((sectionDef?.subsections ?? []).map((sub) => [sub.id, sub.title]));

  // Draft each ready paragraph individually with its minimal evidence pack
  for (const plan of readyPlans) {
    const pack = buildMinimalEvidencePack(plan, registryLookup);
    const { system, prompt } = buildDraftingPrompts(pack);

    const result = await llm.generateStructured({
      promptTemplateId: PROMPT_TEMPLATE_ID,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      system,
      prompt,
      schema: paragraphDraftOutputSchema,
    });

    lastModelInfo = result.modelInfo;

    const validation = validateDraftOutput(result.output, pack);
    if (!validation.valid) {
      throw new AppError(
        validation.errorReason ?? 'The model hallucinated references not in the evidence pack',
        422,
        'LLM_HALLUCINATED_REFERENCE',
        true,
        { paragraphId: plan.id, details: validation.errorReason },
      );
    }

    draftedParagraphs.push(validation.sanitized);
  }

  // Assemble into structured Markdown with subsection titles
  const markdownBlocks: string[] = [];
  let currentSubsectionId: string | null = null;

  for (const p of draftedParagraphs) {
    const plan = readyPlans.find((candidate) => candidate.id === p.paragraphId);
    if (plan && plan.subsectionId !== currentSubsectionId) {
      currentSubsectionId = plan.subsectionId;
      const title = subsectionMap.get(plan.subsectionId) ?? `Subsection ${plan.subsectionId}`;
      markdownBlocks.push(`### ${title}\n`);
    }
    markdownBlocks.push(p.text);
  }

  const markdown = markdownBlocks.join('\n\n');
  const contentHash = hashOf(markdown, RESULTS_LLM_GENERATOR);

  const facts: DraftSectionFacts = {
    sectionKey: params.sectionKey,
    paragraphPlanRevisionId: latestPlansRev.id,
    blueprintVersion: approvedBlueprint.version,
    paragraphs: draftedParagraphs,
    modelInfo: lastModelInfo,
  };

  // Lock and transactional write
  return exclusiveForSnapshot(snapshot.id, () =>
    prisma.$transaction(async (tx) => {
      await takeSnapshotLock(tx, snapshot.id);
      await ensureManuscript(tx, { projectId: params.projectId, snapshotId: snapshot.id, actor: params.actor });

      const section = await tx.manuscriptSection.upsert({
        where: { manuscriptId_sectionKey: { manuscriptId: manuscript.id, sectionKey: params.sectionKey } },
        create: { manuscriptId: manuscript.id, sectionKey: params.sectionKey },
        update: {},
      });

      const latest = await tx.sectionRevision.findFirst({
        where: { sectionId: section.id },
        orderBy: { version: 'desc' },
      });

      if (latest && latest.contentHash === contentHash) {
        return { revision: latest, created: false };
      }

      const revision = await tx.sectionRevision.create({
        data: {
          sectionId: section.id,
          version: (latest?.version ?? 0) + 1,
          markdown,
          facts: json(facts),
          warnings: json([]),
          generator: RESULTS_LLM_GENERATOR,
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
          method: RESULTS_LLM_GENERATOR,
          inputRefs: json({
            snapshotId: snapshot.id,
            paragraphPlanRevisionId: latestPlansRev.id,
            blueprintVersion: approvedBlueprint.version,
            readyParagraphCount: readyPlans.length,
          }),
          outputRefs: json({
            revisionId: revision.id,
            version: revision.version,
            contentHash,
          }),
        },
      });

      return { revision, created: true };
    }, WRITE_TRANSACTION_OPTIONS),
  );
}

/**
 * Saves a manually edited markdown draft as the next SectionRevision.
 * Enforces baseVersion check (409 Conflict) and creates a new revision in PENDING state.
 */
export async function saveSectionDraft(params: {
  projectId: string;
  snapshotId: string;
  actor: string;
  sectionKey: string;
  baseVersion: number;
  markdown: string;
}) {
  // Methods comes from the fixed template (and its facts are checked against the snapshot); it is not hand-edited.
  if (params.sectionKey === 'methods') {
    throw new AppError('The Methods section is generated from a template and cannot be edited by hand', 422, 'SECTION_NOT_EDITABLE');
  }

  const { snapshot, manuscript } = await loadDraftingContext(params.projectId, params.snapshotId);
  const generator = 'manual-edit';
  const contentHash = hashOf(params.markdown, generator);

  return exclusiveForSnapshot(snapshot.id, () =>
    prisma.$transaction(async (tx) => {
      await takeSnapshotLock(tx, snapshot.id);

      const section = await tx.manuscriptSection.findUnique({
        where: { manuscriptId_sectionKey: { manuscriptId: manuscript.id, sectionKey: params.sectionKey } },
      });

      if (!section) {
        throw new NotFoundError(
          `Section "${params.sectionKey}" has not been created yet`,
          'SECTION_NOT_FOUND',
        );
      }

      const latest = await tx.sectionRevision.findFirst({
        where: { sectionId: section.id },
        orderBy: { version: 'desc' },
      });

      if (!latest) {
        throw new NotFoundError(
          `No drafts found for section "${params.sectionKey}"`,
          'SECTION_REVISION_NOT_FOUND',
        );
      }

      if (latest.version !== params.baseVersion) {
        throw new ConflictError(
          `Section draft is at version ${latest.version}, not ${params.baseVersion}. Reload and try again.`,
          'STALE_REVISION',
        );
      }

      if (latest.contentHash === contentHash) {
        return { revision: latest, created: false };
      }

      const revision = await tx.sectionRevision.create({
        data: {
          sectionId: section.id,
          version: latest.version + 1,
          markdown: params.markdown,
          facts: latest.facts as Prisma.InputJsonValue,
          warnings: json([]),
          generator,
          contentHash,
          createdBy: params.actor,
        },
      });

      await tx.provenanceEvent.create({
        data: {
          projectId: params.projectId,
          snapshotId: snapshot.id,
          actor: params.actor,
          activity: `manuscript.section.${params.sectionKey}.edit`,
          method: 'user-edit',
          inputRefs: json({ baseRevisionId: latest.id, baseVersion: latest.version }),
          outputRefs: json({ revisionId: revision.id, version: revision.version, contentHash }),
        },
      });

      return { revision, created: true };
    }, WRITE_TRANSACTION_OPTIONS),
  );
}

/**
 * H2 Approval / Rejection checkpoint.
 * Only the OWNER of the SLR project on slr-be can decide.
 */
export async function decideSectionRevision(params: {
  projectId: string;
  snapshotId: string;
  slrProjectId: string;
  authorization: string | undefined;
  actor: string;
  sectionKey: string;
  version: number;
  decision: ApprovalDecision;
  note: string | null;
}) {
  const slrRole = await assertSlrOwner({
    slrProjectId: params.slrProjectId,
    authorization: params.authorization,
  });

  const { snapshot, manuscript } = await loadDraftingContext(params.projectId, params.snapshotId);

  return exclusiveForSnapshot(snapshot.id, async () => {
    const section = await prisma.manuscriptSection.findUnique({
      where: { manuscriptId_sectionKey: { manuscriptId: manuscript.id, sectionKey: params.sectionKey } },
    });

    if (!section) throw new NotFoundError('Section not found', 'SECTION_NOT_FOUND');

    const judged = await prisma.sectionRevision.findFirst({
      where: { sectionId: section.id },
      orderBy: { version: 'desc' },
    });

    if (!judged) throw new NotFoundError('No revision exists to approve', 'SECTION_REVISION_NOT_FOUND');

    if (judged.version !== params.version) {
      throw new ConflictError(
        `The draft is at version ${judged.version}, not ${params.version}. Only the latest version can be decided.`,
        'STALE_REVISION',
      );
    }

    return prisma.$transaction(async (tx) => {
      await takeSnapshotLock(tx, snapshot.id);
      const latest = await tx.sectionRevision.findFirst({
        where: { sectionId: section.id },
        orderBy: { version: 'desc' },
      });

      if (!latest || latest.id !== judged.id) {
        throw new ConflictError('The draft changed while being reviewed. Reload and decide again.', 'STALE_REVISION');
      }

      // A hand edit keeps the old evidence facts, so approving it needs a verification run that saw this exact text
      // and did not fail. (Reject is always allowed.)
      if (params.decision === 'APPROVED' && latest.generator === 'manual-edit') {
        const report = await tx.verificationReport.findFirst({
          where: { manuscriptId: manuscript.id },
          orderBy: { version: 'desc' },
        });
        if (!report || report.status === 'FAILED' || !(await isVerificationCurrent(manuscript.id, report.summary, tx))) {
          throw new AppError(
            'This draft was edited by hand. Run verification again (it must not fail) before approving H2.',
            422,
            'REVERIFICATION_REQUIRED',
          );
        }
      }

      const target = {
        manuscriptId: manuscript.id,
        stage: 'H2' as const,
        targetKind: SECTION_TARGET_KIND,
        targetId: latest.id,
      };

      const previous = await latestDecision(tx, target);
      if (previous && previous.decision === params.decision && (params.note === null || previous.note === params.note)) {
        return { approval: previous, created: false };
      }

      const approval = await tx.approval.create({
        data: {
          ...target,
          targetHash: latest.contentHash,
          decision: params.decision,
          note: params.note,
          decidedBy: params.actor,
          slrRole,
        },
      });

      await tx.provenanceEvent.create({
        data: {
          projectId: params.projectId,
          snapshotId: snapshot.id,
          actor: params.actor,
          activity: `approval.H2.${params.decision.toLowerCase()}`,
          method: 'owner-decision',
          inputRefs: json({ revisionId: latest.id, version: latest.version, sectionKey: params.sectionKey }),
          outputRefs: json({ approvalId: approval.id, slrRole }),
          notes: params.note,
        },
      });

      return { approval, created: true };
    }, WRITE_TRANSACTION_OPTIONS);
  });
}

/**
 * Returns the latest (or a specific) version of a section draft along with its H2 approval status.
 */
export async function getSectionDraftView(params: {
  projectId: string;
  snapshotId: string;
  sectionKey: string;
  version?: number;
}): Promise<DraftSectionView> {
  const { snapshot, manuscript } = await loadDraftingContext(params.projectId, params.snapshotId);

  const section = await prisma.manuscriptSection.findUnique({
    where: { manuscriptId_sectionKey: { manuscriptId: manuscript.id, sectionKey: params.sectionKey } },
  });

  if (!section) {
    throw new NotFoundError(
      `Section "${params.sectionKey}" has not been created for this snapshot`,
      'SECTION_NOT_FOUND',
    );
  }

  let revision: SectionRevision | null = null;
  if (params.version !== undefined) {
    if (!Number.isInteger(params.version) || params.version < 1) {
      throw new AppError('Invalid version number', 400, 'INVALID_VERSION');
    }
    revision = await prisma.sectionRevision.findUnique({
      where: { sectionId_version: { sectionId: section.id, version: params.version } },
    });
  } else {
    revision = await prisma.sectionRevision.findFirst({
      where: { sectionId: section.id },
      orderBy: { version: 'desc' },
    });
  }

  if (!revision) {
    throw new NotFoundError(
      params.version !== undefined
        ? `Version ${params.version} of section "${params.sectionKey}" not found`
        : `No drafts generated for section "${params.sectionKey}" yet`,
      'SECTION_REVISION_NOT_FOUND',
    );
  }

  const decision = await latestDecision(prisma, {
    manuscriptId: manuscript.id,
    stage: 'H2',
    targetKind: SECTION_TARGET_KIND,
    targetId: revision.id,
  });

  const versions = await prisma.sectionRevision.findMany({
    where: { sectionId: section.id },
    select: revisionSummary,
    orderBy: { version: 'desc' },
  });

  return {
    sectionKey: params.sectionKey,
    revision,
    approval: {
      status: statusOf(decision),
      decision,
    },
    versions,
  };
}

