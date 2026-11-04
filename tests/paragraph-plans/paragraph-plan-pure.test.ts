import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateBlueprint } from '../../src/modules/blueprint/blueprint-generator.js';
import { type BlueprintContent, type BlueprintContext } from '../../src/modules/blueprint/blueprint.types.js';
import { DEFAULT_JOURNAL_PROFILE } from '../../src/modules/journal-profiles/default-profile.js';
import { generateParagraphPlans, paragraphIdOf } from '../../src/modules/paragraph-plans/paragraph-plan-generator.js';
import {
  hasBlockingIssue,
  MAX_ISSUES_PER_CODE,
  validateParagraphPlans,
} from '../../src/modules/paragraph-plans/paragraph-plan-validator.js';
import {
  MAX_PARAGRAPHS,
  MAX_PLAN_REFERENCES,
  paragraphPlanContentSchema,
  paragraphPlanItemSchema,
  type ParagraphPlanContent,
  type ParagraphPlanContext,
  type ParagraphPlanItem,
} from '../../src/modules/paragraph-plans/paragraph-plan.types.js';

// Pure tests: ParagraphPlan generator and validator operate deterministically on plain data.
const real = JSON.parse(
  readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'),
);

function createBlueprintContext(): BlueprintContext {
  return {
    profile: structuredClone(DEFAULT_JOURNAL_PROFILE),
    researchQuestions: real.corpus.research_questions.map((rq: any) => ({
      externalId: rq.rq_id,
      code: rq.code,
      text: rq.question,
    })),
    claims: real.corpus.claims.map((claim: any) => ({
      externalId: claim.claim_id,
      title: claim.title,
      researchQuestionExternalId: claim.research_question_id,
    })),
  };
}

function createParagraphPlanContext(): ParagraphPlanContext {
  const blueprintContent = generateBlueprint(createBlueprintContext());
  return {
    blueprint: {
      version: 1,
      content: blueprintContent,
    },
    researchQuestions: real.corpus.research_questions.map((rq: any) => ({
      externalId: rq.rq_id,
    })),
    claims: real.corpus.claims.map((claim: any) => ({
      externalId: claim.claim_id,
      title: claim.title,
      researchQuestionExternalId: claim.research_question_id,
      findingExternalIds: (claim.items || []).map((it: any) => it.finding_id).filter(Boolean),
    })),
    findings: real.corpus.findings.map((f: any) => ({
      externalId: f.finding_id,
      fieldName: f.field_name,
      valueText: f.value_text || '',
      isNotReported: Boolean(f.is_not_reported),
      evidenceExternalIds: f.evidence_ids || [],
      studyExternalId: f.study_id,
    })),
    evidence: (real.corpus.evidence || []).map((e: any) => ({
      externalId: e.evidence_id,
      quote: e.verbatim_quote || e.quote || '',
      studyExternalId: e.study_id,
    })),
  };
}

function createContextWithGroundedEvidence(): ParagraphPlanContext {
  const ctx = createParagraphPlanContext();
  ctx.evidence = [
    { externalId: 'ev-1', quote: 'Verbatim quote from copilot study', studyExternalId: 'demo_paper_copilot_2022' },
    { externalId: 'ev-2', quote: 'Verbatim quote from repair study', studyExternalId: 'demo_paper_repair_2024' },
    { externalId: 'ev-3', quote: 'Verbatim quote from codex study', studyExternalId: 'demo_paper_codex_2021' },
    { externalId: 'ev-4', quote: 'Verbatim quote from security study', studyExternalId: 'demo_paper_security_2023' },
  ];
  // Assign evidence to findings
  ctx.findings.forEach((f, idx) => {
    f.evidenceExternalIds = [ctx.evidence[idx % ctx.evidence.length].externalId];
  });
  return ctx;
}

describe('generateParagraphPlans on real fixture with approved blueprint', () => {
  const ctx = createParagraphPlanContext();
  const content = generateParagraphPlans(ctx);

  it('generates non-empty paragraph plans matching blueprint version', () => {
    expect(content.plans.length).toBeGreaterThan(0);
    expect(content.blueprintVersion).toBe(ctx.blueprint.version);
  });

  it('generates plans for Results subsections matching claims', () => {
    const resultsSubsections = ctx.blueprint.content.sections
      .find((s) => s.key === 'results')!
      .subsections;

    expect(resultsSubsections.length).toBe(real.corpus.claims.length);

    for (const sub of resultsSubsections) {
      const plansForSub = content.plans.filter((p) => p.subsectionId === sub.id);
      expect(plansForSub.length).toBeGreaterThanOrEqual(1);

      // Verify each plan under this subsection has correct sectionKey and claim references
      for (const plan of plansForSub) {
        expect(plan.sectionKey).toBe('results');
        expect(plan.claimIds).toEqual(sub.claimIds);
        expect(plan.rqIds).toEqual(sub.rqIds);
        expect(plan.citationPolicy).toBe('registry_only');
      }

      // Check rhetorical moves: first is theme_overview, then report_evidence, then compare_and_synthesize (since findings > 1)
      const moves = plansForSub.map((p) => p.rhetoricalMove);
      expect(moves[0]).toBe('theme_overview');
      if (plansForSub.length > 1) {
        expect(moves[1]).toBe('report_evidence');
      }
      if (plansForSub.length > 2) {
        expect(moves[2]).toBe('compare_and_synthesize');
      }
    }
  });

  it('generates plans for non-claim subsections (intro and discussion)', () => {
    const introPlans = content.plans.filter((p) => p.subsectionId === 'intro:research-questions');
    expect(introPlans).toHaveLength(1);
    expect(introPlans[0].sectionKey).toBe('introduction');
    expect(introPlans[0].rhetoricalMove).toBe('theme_overview');
    expect(introPlans[0].sentenceSlots).toEqual(['topic', 'synthesis']);
    expect(introPlans[0].claimIds).toEqual([]);
    expect(introPlans[0].status).toBe('READY_TO_DRAFT');

    const conflictPlans = content.plans.filter((p) => p.subsectionId === 'discussion:agreement-and-conflict');
    expect(conflictPlans).toHaveLength(1);
    expect(conflictPlans[0].sectionKey).toBe('discussion');
    expect(conflictPlans[0].rhetoricalMove).toBe('compare_and_synthesize');
    expect(conflictPlans[0].sentenceSlots).toEqual(['topic', 'synthesis', 'qualification']);
    expect(conflictPlans[0].status).toBe('READY_TO_DRAFT');

    const limitPlans = content.plans.filter((p) => p.subsectionId === 'discussion:limitations');
    expect(limitPlans).toHaveLength(1);
    expect(limitPlans[0].sectionKey).toBe('discussion');
    expect(limitPlans[0].rhetoricalMove).toBe('discuss_limitation');
    expect(limitPlans[0].sentenceSlots).toEqual(['topic', 'limitation']);
    expect(limitPlans[0].status).toBe('READY_TO_DRAFT');
  });

  it('conforms to paragraphPlanContentSchema', () => {
    const parseResult = paragraphPlanContentSchema.safeParse(content);
    expect(parseResult.success).toBe(true);
  });

  it('returns 0 blocking issues when validated against context', () => {
    const issues = validateParagraphPlans(content, ctx);
    const blocking = issues.filter((i) => i.severity === 'blocking');
    expect(blocking).toHaveLength(0);
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('marks plans as READY_TO_DRAFT when evidence is grounded in registry', () => {
    const groundedCtx = createContextWithGroundedEvidence();
    const groundedContent = generateParagraphPlans(groundedCtx);

    const resultsPlans = groundedContent.plans.filter((p) => p.sectionKey === 'results');
    expect(resultsPlans.length).toBeGreaterThan(0);
    for (const plan of resultsPlans) {
      expect(plan.status).toBe('READY_TO_DRAFT');
      expect(plan.evidenceIds.length).toBeGreaterThan(0);
      expect(plan.limitations).toEqual([]);
    }

    const issues = validateParagraphPlans(groundedContent, groundedCtx);
    expect(hasBlockingIssue(issues)).toBe(false);
    expect(issues.filter((i) => i.code === 'CLAIM_EVIDENCE_MISSING')).toHaveLength(0);
  });

  it('is deterministic: repeated generation yields identical output', () => {
    const run1 = generateParagraphPlans(ctx);
    const run2 = generateParagraphPlans(ctx);
    expect(run1).toEqual(run2);
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it('skips excluded sections from blueprint', () => {
    const excludedCtx = createParagraphPlanContext();
    const discSection = excludedCtx.blueprint.content.sections.find((s) => s.key === 'discussion');
    if (discSection) discSection.include = false;

    const modifiedContent = generateParagraphPlans(excludedCtx);
    const hasDiscussion = modifiedContent.plans.some((p) => p.sectionKey === 'discussion');
    expect(hasDiscussion).toBe(false);
  });
});

describe('paragraphIdOf helper', () => {
  it('generates standard ID when subsectionId is short', () => {
    const id = paragraphIdOf('intro:research-questions', 1);
    expect(id).toBe('P-intro:research-questions-01');
    expect(paragraphIdOf('results-1', 12)).toBe('P-results-1-12');
  });

  it('generates sha256 hash-based ID when subsectionId is excessively long', () => {
    const longSubId = 'x'.repeat(300);
    const id = paragraphIdOf(longSubId, 3);
    expect(id.startsWith('P-sha256-')).toBe(true);
    expect(id.endsWith('-03')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(250);
  });

  it('is deterministic for both short and long subsection IDs', () => {
    const longSubId = 'y'.repeat(500);
    expect(paragraphIdOf('short', 1)).toBe(paragraphIdOf('short', 1));
    expect(paragraphIdOf(longSubId, 5)).toBe(paragraphIdOf(longSubId, 5));
  });
});

describe('validateParagraphPlans blocking issues and warnings', () => {
  const baseCtx = () => createContextWithGroundedEvidence();
  const baseContent = () => generateParagraphPlans(baseCtx());

  it('blocks with BLUEPRINT_VERSION_MISMATCH when blueprintVersion does not match', () => {
    const content = baseContent();
    content.blueprintVersion = 999;
    const issues = validateParagraphPlans(content, baseCtx());
    const mismatch = issues.find((i) => i.code === 'BLUEPRINT_VERSION_MISMATCH');
    expect(mismatch?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks with PLANS_EMPTY when plans array is empty', () => {
    const content = baseContent();
    content.plans = [];
    const issues = validateParagraphPlans(content, baseCtx());
    const emptyIssue = issues.find((i) => i.code === 'PLANS_EMPTY');
    expect(emptyIssue?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks with PARAGRAPH_ID_DUPLICATE when two plans share an ID', () => {
    const content = baseContent();
    content.plans[1].id = content.plans[0].id;
    const issues = validateParagraphPlans(content, baseCtx());
    const dupIssue = issues.find((i) => i.code === 'PARAGRAPH_ID_DUPLICATE');
    expect(dupIssue?.severity).toBe('blocking');
    expect(dupIssue?.ref).toBe(content.plans[0].id);
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks with SUBSECTION_UNKNOWN when referencing a subsection not in the blueprint', () => {
    const content = baseContent();
    content.plans[0].subsectionId = 'unknown-ghost-subsection';
    const issues = validateParagraphPlans(content, baseCtx());
    const unknownSub = issues.find((i) => i.code === 'SUBSECTION_UNKNOWN');
    expect(unknownSub?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks with SECTION_KEY_MISMATCH when sectionKey does not match the subsection parent section', () => {
    const content = baseContent();
    // plan[0] is in introduction, change its sectionKey to discussion
    content.plans[0].sectionKey = 'discussion';
    const issues = validateParagraphPlans(content, baseCtx());
    const mismatch = issues.find((i) => i.code === 'SECTION_KEY_MISMATCH');
    expect(mismatch?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks with UNKNOWN_RESEARCH_QUESTION when rqIds contains an unknown RQ ID', () => {
    const content = baseContent();
    content.plans[0].rqIds.push('rq-ghost-nonexistent');
    const issues = validateParagraphPlans(content, baseCtx());
    const issue = issues.find((i) => i.code === 'UNKNOWN_RESEARCH_QUESTION');
    expect(issue?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks with UNKNOWN_CLAIM when claimIds contains an unknown claim ID', () => {
    const content = baseContent();
    const resultPlan = content.plans.find((p) => p.sectionKey === 'results')!;
    resultPlan.claimIds.push('claim-ghost-nonexistent');
    const issues = validateParagraphPlans(content, baseCtx());
    const issue = issues.find((i) => i.code === 'UNKNOWN_CLAIM');
    expect(issue?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks with UNKNOWN_FINDING when findingIds contains an unknown finding ID', () => {
    const content = baseContent();
    const resultPlan = content.plans.find((p) => p.sectionKey === 'results')!;
    resultPlan.findingIds.push('finding-ghost-nonexistent');
    const issues = validateParagraphPlans(content, baseCtx());
    const issue = issues.find((i) => i.code === 'UNKNOWN_FINDING');
    expect(issue?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks with UNKNOWN_EVIDENCE when evidenceIds contains an unknown evidence ID', () => {
    const content = baseContent();
    const resultPlan = content.plans.find((p) => p.sectionKey === 'results')!;
    resultPlan.evidenceIds.push('evidence-ghost-nonexistent');
    const issues = validateParagraphPlans(content, baseCtx());
    const issue = issues.find((i) => i.code === 'UNKNOWN_EVIDENCE');
    expect(issue?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks with EVIDENCE_STATUS_INVALID when claimIds > 0, evidenceIds is empty, but status is READY_TO_DRAFT', () => {
    const content = baseContent();
    const resultPlan = content.plans.find((p) => p.sectionKey === 'results')!;
    resultPlan.evidenceIds = [];
    resultPlan.status = 'READY_TO_DRAFT';
    const issues = validateParagraphPlans(content, baseCtx());
    const issue = issues.find((i) => i.code === 'EVIDENCE_STATUS_INVALID');
    expect(issue?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('emits non-blocking CLAIM_EVIDENCE_MISSING warning when claimIds > 0, evidence is empty, and status is NEEDS_EVIDENCE', () => {
    const content = baseContent();
    const resultPlan = content.plans.find((p) => p.sectionKey === 'results')!;
    resultPlan.evidenceIds = [];
    resultPlan.status = 'NEEDS_EVIDENCE';
    const issues = validateParagraphPlans(content, baseCtx());
    const issue = issues.find((i) => i.code === 'CLAIM_EVIDENCE_MISSING');
    expect(issue?.severity).toBe('warning');
    // Shouldn't have EVIDENCE_STATUS_INVALID
    expect(issues.some((i) => i.code === 'EVIDENCE_STATUS_INVALID')).toBe(false);
  });

  it('warns with DUPLICATE_REFERENCE when duplicate IDs exist within a single plan', () => {
    const content = baseContent();
    const plan = content.plans.find((p) => p.sectionKey === 'results')!;
    if (plan.findingIds.length > 0) {
      plan.findingIds.push(plan.findingIds[0]);
    }
    const issues = validateParagraphPlans(content, baseCtx());
    const warn = issues.find((i) => i.code === 'DUPLICATE_REFERENCE');
    expect(warn?.severity).toBe('warning');
  });

  it('warns with RESULTS_SUBSECTION_UNPLANNED when a Results subsection in blueprint has no plans', () => {
    const content = baseContent();
    const resultsSub = content.plans.find((p) => p.sectionKey === 'results')!.subsectionId;
    content.plans = content.plans.filter((p) => p.subsectionId !== resultsSub);
    const issues = validateParagraphPlans(content, baseCtx());
    const warn = issues.find((i) => i.code === 'RESULTS_SUBSECTION_UNPLANNED');
    expect(warn?.severity).toBe('warning');
    expect(warn?.ref).toBe(resultsSub);
  });

  it('caps reported issues at MAX_ISSUES_PER_CODE and warns with ISSUES_TRUNCATED', () => {
    const content = baseContent();
    // Create more than MAX_ISSUES_PER_CODE plans with unknown subsections
    const extraPlans: ParagraphPlanItem[] = Array.from({ length: MAX_ISSUES_PER_CODE + 5 }, (_, i) => ({
      id: `P-extra-${i}`,
      sectionKey: 'results',
      subsectionId: `ghost-sub-${i}`,
      rhetoricalMove: 'theme_overview',
      rqIds: [],
      claimIds: [],
      findingIds: [],
      evidenceIds: [],
      claimStrength: 'neutral',
      conditionsRequired: false,
      citationPolicy: 'registry_only',
      sentenceSlots: ['topic'],
      limitations: [],
      status: 'READY_TO_DRAFT',
    }));
    content.plans.push(...extraPlans);

    const issues = validateParagraphPlans(content, baseCtx());
    const unknownSubIssues = issues.filter((i) => i.code === 'SUBSECTION_UNKNOWN');
    expect(unknownSubIssues.length).toBe(MAX_ISSUES_PER_CODE);
    const truncated = issues.find((i) => i.code === 'ISSUES_TRUNCATED');
    expect(truncated).toBeDefined();
    expect(truncated?.severity).toBe('warning');
    expect(truncated?.ref).toBe('SUBSECTION_UNKNOWN');
  });
});

describe('paragraphPlanItemSchema & paragraphPlanContentSchema', () => {
  const basePlan = (): ParagraphPlanItem => ({
    id: 'P-test-01',
    sectionKey: 'results',
    subsectionId: 'claim:test',
    rhetoricalMove: 'theme_overview',
    rqIds: ['rq1'],
    claimIds: ['claim1'],
    findingIds: ['f1'],
    evidenceIds: ['ev1'],
    claimStrength: 'neutral',
    conditionsRequired: true,
    citationPolicy: 'registry_only',
    sentenceSlots: ['topic', 'evidence'],
    limitations: [],
    status: 'READY_TO_DRAFT',
  });

  it('validates a compliant ParagraphPlanItem', () => {
    expect(paragraphPlanItemSchema.safeParse(basePlan()).success).toBe(true);
  });

  it('refuses unknown properties on ParagraphPlanItem (.strict())', () => {
    const invalid = { ...basePlan(), extraField: 'not-allowed' };
    expect(paragraphPlanItemSchema.safeParse(invalid).success).toBe(false);
  });

  it('refuses invalid rhetoricalMove enum values', () => {
    const invalid = { ...basePlan(), rhetoricalMove: 'invalid_move' };
    expect(paragraphPlanItemSchema.safeParse(invalid).success).toBe(false);
  });

  it('refuses invalid claimStrength enum values', () => {
    const invalid = { ...basePlan(), claimStrength: 'super_strong' };
    expect(paragraphPlanItemSchema.safeParse(invalid).success).toBe(false);
  });

  it('refuses invalid status enum values', () => {
    const invalid = { ...basePlan(), status: 'PUBLISHED' };
    expect(paragraphPlanItemSchema.safeParse(invalid).success).toBe(false);
  });

  it('refuses empty sentenceSlots array', () => {
    const invalid = { ...basePlan(), sentenceSlots: [] };
    expect(paragraphPlanItemSchema.safeParse(invalid).success).toBe(false);
  });

  it('refuses citationPolicy other than registry_only', () => {
    const invalid = { ...basePlan(), citationPolicy: 'open_web' };
    expect(paragraphPlanItemSchema.safeParse(invalid).success).toBe(false);
  });

  it('refuses unstorable characters such as NUL byte or lone surrogate', () => {
    const nulPlan = { ...basePlan(), id: 'P-nul-\u0000-01' };
    expect(paragraphPlanItemSchema.safeParse(nulPlan).success).toBe(false);

    const surrogatePlan = { ...basePlan(), sectionKey: 'results\uD800' };
    expect(paragraphPlanItemSchema.safeParse(surrogatePlan).success).toBe(false);

    const contentWithNul: ParagraphPlanContent = {
      blueprintVersion: 1,
      plans: [{ ...basePlan(), id: 'P-clean-01', limitations: ['Contains NUL \u0000'] }],
    };
    expect(paragraphPlanContentSchema.safeParse(contentWithNul).success).toBe(false);
  });

  it('refuses invisible or whitespace-only text for visible fields', () => {
    const whitespaceId = { ...basePlan(), id: '   ' };
    expect(paragraphPlanItemSchema.safeParse(whitespaceId).success).toBe(false);

    const zeroWidthSub = { ...basePlan(), subsectionId: '\u200B\u200C' };
    expect(paragraphPlanItemSchema.safeParse(zeroWidthSub).success).toBe(false);

    const blankLimitation = { ...basePlan(), limitations: ['   '] };
    expect(paragraphPlanItemSchema.safeParse(blankLimitation).success).toBe(false);
  });

  it('refuses paragraphPlanContent with invalid blueprintVersion', () => {
    expect(
      paragraphPlanContentSchema.safeParse({ blueprintVersion: 0, plans: [basePlan()] }).success,
    ).toBe(false);
    expect(
      paragraphPlanContentSchema.safeParse({ blueprintVersion: -1, plans: [basePlan()] }).success,
    ).toBe(false);
    expect(
      paragraphPlanContentSchema.safeParse({ blueprintVersion: 1.5, plans: [basePlan()] }).success,
    ).toBe(false);
  });

  it('refuses content with unknown properties (.strict())', () => {
    expect(
      paragraphPlanContentSchema.safeParse({
        blueprintVersion: 1,
        plans: [basePlan()],
        extraKey: true,
      }).success,
    ).toBe(false);
  });

  it('refuses plans array exceeding MAX_PARAGRAPHS', () => {
    // Check schema enforcement on oversized plans count
    const fakePlans = Array.from({ length: MAX_PARAGRAPHS + 1 }, (_, i) => ({
      ...basePlan(),
      id: `P-test-${i}`,
    }));
    const oversized = { blueprintVersion: 1, plans: fakePlans };
    const res = paragraphPlanContentSchema.safeParse(oversized);
    expect(res.success).toBe(false);
  });

  it('refuses content exceeding MAX_PLAN_REFERENCES across all plans', () => {
    // Create plans that together exceed MAX_PLAN_REFERENCES references
    // MAX_PLAN_REFERENCES is 50,000. Plan items can have max 1000 claims.
    const planWithRefs = (id: string, refCount: number): ParagraphPlanItem => ({
      ...basePlan(),
      id,
      rqIds: [],
      claimIds: Array.from({ length: refCount }, (_, i) => `c${i}`),
      findingIds: [],
      evidenceIds: [],
    });

    // 51 plans * 1000 claims = 51,000 references
    const plans = Array.from({ length: 51 }, (_, i) => planWithRefs(`P-ref-${i}`, 1000));
    const content = { blueprintVersion: 1, plans };
    const res = paragraphPlanContentSchema.safeParse(content);
    expect(res.success).toBe(false);
  });

  it('refuses content nested too deeply via findStorableProblem', () => {
    // Build a deeply nested object (> 64 levels)
    let deep: any = { blueprintVersion: 1, plans: [] };
    for (let i = 0; i < 70; i++) {
      deep = { nested: deep };
    }
    const res = paragraphPlanContentSchema.safeParse(deep);
    expect(res.success).toBe(false);
  });
});
