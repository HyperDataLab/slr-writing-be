import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateBlueprint } from '../../src/modules/blueprint/blueprint-generator.js';
import { hasBlockingIssue, validateBlueprint } from '../../src/modules/blueprint/blueprint-validator.js';
import { blueprintContentSchema, type BlueprintContent, type BlueprintContext } from '../../src/modules/blueprint/blueprint.types.js';
import { DEFAULT_JOURNAL_PROFILE } from '../../src/modules/journal-profiles/default-profile.js';

// Pure tests: the generator and the validator take plain data.
const real = JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));
const context = (): BlueprintContext => ({
  profile: structuredClone(DEFAULT_JOURNAL_PROFILE),
  researchQuestions: real.corpus.research_questions.map((rq: any) => ({ externalId: rq.rq_id, code: rq.code, text: rq.question })),
  claims: real.corpus.claims.map((claim: any) => ({ externalId: claim.claim_id, title: claim.title, researchQuestionExternalId: claim.research_question_id })),
});
const generated = (ctx = context()): BlueprintContent => generateBlueprint(ctx);
const codes = (content: BlueprintContent, ctx = context()) => validateBlueprint(content, ctx).map((issue) => issue.code);
const section = (content: BlueprintContent, key: string) => content.sections.find((candidate) => candidate.key === key)!;

describe('generateBlueprint on a real run', () => {
  const content = generated();

  it('follows the profile: same sections, same order, suggested word budgets, all included', () => {
    expect(content.profile).toEqual({ id: 'generic-imrad', version: 1 });
    expect(content.sections.map((s) => s.key)).toEqual(DEFAULT_JOURNAL_PROFILE.sections.map((s) => s.key));
    expect(content.sections.every((s) => s.include)).toBe(true);
    for (const s of content.sections) {
      expect(s.wordBudget).toEqual(DEFAULT_JOURNAL_PROFILE.sections.find((p) => p.key === s.key)!.wordBudget);
    }
  });

  it('makes one Results subsection per theme, tied to the question it answers', () => {
    const results = section(content, 'results');
    expect(results.subsections).toHaveLength(real.corpus.claims.length);
    for (const [index, claim] of real.corpus.claims.entries()) {
      expect(results.subsections[index]).toMatchObject({ id: `claim:${claim.claim_id}`, title: claim.title, claimIds: [claim.claim_id], rqIds: [claim.research_question_id] });
    }
  });

  it('adds the fixed subsections of Introduction and Discussion, and none elsewhere', () => {
    expect(section(content, 'introduction').subsections.map((s) => s.id)).toEqual(['intro:research-questions']);
    expect(section(content, 'introduction').subsections[0].rqIds).toEqual(real.corpus.research_questions.map((rq: any) => rq.rq_id));
    expect(section(content, 'discussion').subsections.map((s) => s.id)).toEqual(['discussion:agreement-and-conflict', 'discussion:limitations']);
    for (const key of ['abstract', 'methods', 'conclusion']) expect(section(content, key).subsections).toEqual([]);
  });

  it('covers every research question with the Results subsections that answer it', () => {
    expect(content.coverage.map((entry) => entry.rqId)).toEqual(real.corpus.research_questions.map((rq: any) => rq.rq_id));
    for (const entry of content.coverage) {
      expect(entry.subsectionIds.length).toBeGreaterThan(0);
      expect(entry.notApplicableReason).toBeNull();
    }
  });

  it('is accepted by the schema, has unique subsection ids, and has no blocking issue and no warning', () => {
    expect(blueprintContentSchema.safeParse(content).success).toBe(true);
    const ids = content.sections.flatMap((s) => s.subsections.map((sub) => sub.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(validateBlueprint(content, context())).toEqual([]);
  });

  it('is deterministic', () => {
    expect(generated()).toEqual(generated());
    expect(JSON.stringify(generated())).toBe(JSON.stringify(generated()));
  });
});

describe('generateBlueprint on awkward snapshots', () => {
  it('leaves a question no theme answers uncovered, so the gap blocks approval until it is dealt with', () => {
    const ctx = context(); ctx.claims = ctx.claims.filter((claim) => claim.researchQuestionExternalId !== 'rq3');
    const content = generated(ctx);
    expect(content.coverage.find((entry) => entry.rqId === 'rq3')).toEqual({ rqId: 'rq3', subsectionIds: [], notApplicableReason: null });
    expect(codes(content, ctx)).toContain('COVERAGE_UNRESOLVED');
  });

  it('ties a theme with no question, or a question the snapshot does not have, to no question', () => {
    const ctx = context();
    ctx.claims = [{ externalId: 'c1', title: 'Free theme', researchQuestionExternalId: null }, { externalId: 'c2', title: 'Odd theme', researchQuestionExternalId: 'gone' }];
    const results = section(generated(ctx), 'results');
    expect(results.subsections.map((s) => s.rqIds)).toEqual([[], []]);
  });

  it('with no themes, Results is empty and that blocks approval', () => {
    const ctx = context(); ctx.claims = [];
    const content = generated(ctx);
    expect(section(content, 'results').subsections).toEqual([]);
    expect(codes(content, ctx)).toEqual(expect.arrayContaining(['RESULTS_EMPTY', 'COVERAGE_UNRESOLVED']));
  });

  it('with no research questions, there is no coverage to ask for', () => {
    const ctx = context(); ctx.researchQuestions = []; ctx.claims = [];
    expect(generated(ctx).coverage).toEqual([]);
  });

  it('keeps ids unique when theme ids look alike', () => {
    const ctx = context();
    ctx.claims = [{ externalId: 'a', title: 'A', researchQuestionExternalId: null }, { externalId: 'a ', title: 'A2', researchQuestionExternalId: null }];
    const ids = section(generated(ctx), 'results').subsections.map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('validateBlueprint', () => {
  const mutate = (change: (content: BlueprintContent) => void) => { const content = generated(); change(content); return content; };

  it.each<[string, (content: BlueprintContent) => void, string]>([
    ['a section of the profile is missing', (c) => { c.sections = c.sections.filter((s) => s.key !== 'methods'); }, 'SECTION_MISSING'],
    ['a section appears twice', (c) => { c.sections.push(structuredClone(c.sections[0])); }, 'SECTION_DUPLICATE'],
    ['a section is not in the profile', (c) => { c.sections.push({ key: 'appendix', include: true, wordBudget: { min: 1, max: 2 }, subsections: [] }); }, 'SECTION_UNKNOWN'],
    ['a required section is left out', (c) => { section(c, 'methods').include = false; }, 'REQUIRED_SECTION_EXCLUDED'],
    ['a word range is upside down', (c) => { section(c, 'results').wordBudget = { min: 900, max: 100 }; }, 'WORD_BUDGET_INVALID'],
    ['two subsections share an id', (c) => { section(c, 'discussion').subsections[1].id = section(c, 'discussion').subsections[0].id; }, 'SUBSECTION_ID_DUPLICATE'],
    ['a subsection points to a theme that is not in the snapshot', (c) => { section(c, 'results').subsections[0].claimIds = ['ghost']; }, 'UNKNOWN_CLAIM'],
    ['a subsection points to a question that is not in the snapshot', (c) => { section(c, 'results').subsections[0].rqIds = ['ghost']; }, 'UNKNOWN_RESEARCH_QUESTION'],
    ['Results has no subsections', (c) => { section(c, 'results').subsections = []; c.coverage.forEach((e) => { e.subsectionIds = []; e.notApplicableReason = 'n/a'; }); }, 'RESULTS_EMPTY'],
    ['a question has no coverage entry', (c) => { c.coverage = c.coverage.filter((e) => e.rqId !== 'rq1'); }, 'COVERAGE_MISSING'],
    ['a question has two coverage entries', (c) => { c.coverage.push(structuredClone(c.coverage[0])); }, 'COVERAGE_DUPLICATE'],
    ['coverage names a question the snapshot does not have', (c) => { c.coverage.push({ rqId: 'ghost', subsectionIds: [], notApplicableReason: 'x' }); }, 'UNKNOWN_RESEARCH_QUESTION'],
    ['coverage points to a subsection that does not exist', (c) => { c.coverage[0].subsectionIds = ['nope']; }, 'COVERAGE_UNKNOWN_SUBSECTION'],
    ['a question is neither covered nor explained', (c) => { c.coverage[0].subsectionIds = []; c.coverage[0].notApplicableReason = null; }, 'COVERAGE_UNRESOLVED'],
    ['the blueprint was made for another profile', (c) => { c.profile.id = 'other'; }, 'PROFILE_MISMATCH'],
    ['the blueprint follows an older version of the profile', (c) => { c.profile.version = 0 + 99; }, 'PROFILE_OUTDATED'],
  ])('blocks when %s', (_name, change, code) => {
    const issues = validateBlueprint(mutate(change), context());
    expect(issues.find((issue) => issue.code === code)?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('accepts a question with a reason instead of a subsection', () => {
    const content = mutate((c) => { c.coverage[0].subsectionIds = []; c.coverage[0].notApplicableReason = 'The review found no evidence on this question.'; });
    expect(codes(content)).not.toContain('COVERAGE_UNRESOLVED');
  });

  it('does not accept coverage that points into a section left out of the manuscript', () => {
    const content = mutate((c) => { section(c, 'discussion').include = false; c.coverage[0].subsectionIds = ['discussion:limitations']; c.coverage[0].notApplicableReason = null; });
    expect(codes(content)).toContain('COVERAGE_UNKNOWN_SUBSECTION');
  });

  it('only warns when a theme is not reported anywhere, or when a left-out section still has subsections', () => {
    const dropped = mutate((c) => { section(c, 'results').subsections.pop(); });
    const issues = validateBlueprint(dropped, context());
    expect(issues.find((i) => i.code === 'THEME_NOT_PLACED')?.severity).toBe('warning');
    const left = mutate((c) => { section(c, 'discussion').include = true; section(c, 'conclusion').include = false; section(c, 'conclusion').subsections = [{ id: 'x', title: 'X', purpose: null, claimIds: [], rqIds: [] }]; });
    const leftIssues = validateBlueprint(left, context());
    expect(leftIssues.find((i) => i.code === 'EXCLUDED_SECTION_HAS_SUBSECTIONS')?.severity).toBe('warning');
  });

  it('does not block on warnings alone: a subsection that no longer reports its theme is a warning', () => {
    const issues = validateBlueprint(mutate((c) => { section(c, 'results').subsections[0].claimIds = []; }), context());
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['THEME_NOT_PLACED', 'warning']]);
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('is deterministic and does not change its input', () => {
    const content = generated();
    const before = JSON.stringify(content);
    expect(validateBlueprint(content, context())).toEqual(validateBlueprint(content, context()));
    expect(JSON.stringify(content)).toBe(before);
  });
});

describe('blueprintContentSchema', () => {
  const ok = () => structuredClone(generated());
  const refuses = (change: (content: any) => void) => { const content: any = ok(); change(content); return !blueprintContentSchema.safeParse(content).success; };

  it('refuses unknown keys everywhere, so nothing is dropped silently', () => {
    expect(refuses((c) => { c.approved = true; })).toBe(true);
    expect(refuses((c) => { c.sections[0].extra = 1; })).toBe(true);
    expect(refuses((c) => { c.sections[2].subsections[0] = { ...c.sections[1].subsections[0], extra: 1 }; })).toBe(true);
    expect(refuses((c) => { c.coverage[0].extra = 1; })).toBe(true);
    expect(refuses((c) => { c.profile.extra = 1; })).toBe(true);
  });

  it.each<[string, (content: any) => void]>([
    ['no sections', (c) => { c.sections = []; }],
    ['too many sections', (c) => { c.sections = Array.from({ length: 21 }, () => c.sections[0]); }],
    ['a word range that is not a positive integer', (c) => { c.sections[0].wordBudget.min = 0; }],
    ['a fractional word range', (c) => { c.sections[0].wordBudget.max = 1.5; }],
    ['a blank subsection title', (c) => { c.sections[1].subsections[0].title = '   '; }],
    ['a zero-width-only title', (c) => { c.sections[1].subsections[0].title = String.fromCharCode(0x200b); }],
    ['a title of 301 characters', (c) => { c.sections[1].subsections[0].title = 'x'.repeat(301); }],
    ['an id of 251 characters', (c) => { c.sections[1].subsections[0].id = 'x'.repeat(251); }],
    ['a non-boolean include', (c) => { c.sections[0].include = 'yes'; }],
    ['a non-array subsection list', (c) => { c.sections[1].subsections = {}; }],
    ['a blank not-applicable reason', (c) => { c.coverage[0].notApplicableReason = '  '; }],
    ['a profile version of 0', (c) => { c.profile.version = 0; }],
    ['a null body', (c) => { Object.keys(c).forEach((k) => delete c[k]); }],
  ])('refuses %s', (_name, change) => {
    expect(refuses(change)).toBe(true);
  });

  it('saves a draft with problems: the shape is checked here, approvability elsewhere', () => {
    const draft: any = ok(); draft.sections.find((s: any) => s.key === 'methods').include = false;
    expect(blueprintContentSchema.safeParse(draft).success).toBe(true);
  });
});
