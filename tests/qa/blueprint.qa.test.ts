import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateBlueprint } from '../../src/modules/blueprint/blueprint-generator.js';
import { hasBlockingIssue, validateBlueprint } from '../../src/modules/blueprint/blueprint-validator.js';
import { blueprintContentSchema, type BlueprintContent, type BlueprintContext } from '../../src/modules/blueprint/blueprint.types.js';
import { DEFAULT_JOURNAL_PROFILE } from '../../src/modules/journal-profiles/default-profile.js';
import { hashOfJson } from '../../src/shared/utils/stable-json.js';

// QA (pure): generator, validator, schema and hashing of the M5 blueprint on hostile inputs. SYNTHETIC data except the real fixture.
const real = JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));
const realContext = (): BlueprintContext => ({
  profile: structuredClone(DEFAULT_JOURNAL_PROFILE),
  researchQuestions: real.corpus.research_questions.map((rq: any) => ({ externalId: rq.rq_id, code: rq.code, text: rq.question })),
  claims: real.corpus.claims.map((claim: any) => ({ externalId: claim.claim_id, title: claim.title, researchQuestionExternalId: claim.research_question_id })),
});
const ctx = (claims: BlueprintContext['claims'], researchQuestions: BlueprintContext['researchQuestions']): BlueprintContext => ({
  profile: structuredClone(DEFAULT_JOURNAL_PROFILE), claims, researchQuestions,
});
const codes = (content: BlueprintContent, context: BlueprintContext) => validateBlueprint(content, context).map((issue) => issue.code);
const section = (content: BlueprintContent, key: string) => content.sections.find((s) => s.key === key)!;

describe('generator on hostile snapshots', () => {
  it('zero claims and zero research questions: Results empty is blocking, nothing crashes', () => {
    const c = ctx([], []);
    const content = generateBlueprint(c);
    expect(section(content, 'results').subsections).toEqual([]);
    expect(content.coverage).toEqual([]);
    expect(codes(content, c)).toContain('RESULTS_EMPTY');
    expect(blueprintContentSchema.safeParse(content).success).toBe(true);
  });

  it('zero research questions but themes: approvable, coverage empty', () => {
    const c = ctx([{ externalId: 'c1', title: 'Theme', researchQuestionExternalId: null }], []);
    const content = generateBlueprint(c);
    expect(hasBlockingIssue(validateBlueprint(content, c))).toBe(false);
  });

  it('zero claims with research questions: every question unresolved', () => {
    const c = ctx([], [{ externalId: 'rq1', code: 'RQ1', text: 'q' }, { externalId: 'rq2', code: 'RQ1', text: 'q2' }]);
    const issues = codes(generateBlueprint(c), c);
    expect(issues.filter((x) => x === 'COVERAGE_UNRESOLVED')).toHaveLength(2);
    expect(issues).toContain('RESULTS_EMPTY');
  });

  it('a claim pointing to a research question that does not exist gets no rqIds (no dangling reference)', () => {
    const c = ctx([{ externalId: 'c1', title: 'T', researchQuestionExternalId: 'ghost' }], [{ externalId: 'rq1', code: null, text: 'q' }]);
    const content = generateBlueprint(c);
    expect(section(content, 'results').subsections[0].rqIds).toEqual([]);
    expect(codes(content, c)).not.toContain('UNKNOWN_RESEARCH_QUESTION');
    expect(codes(content, c)).toContain('COVERAGE_UNRESOLVED');
  });

  it('duplicate claim externalIds (impossible in DB, possible in pure input) give SUBSECTION_ID_DUPLICATE, not a crash', () => {
    const c = ctx([{ externalId: 'c1', title: 'A', researchQuestionExternalId: null }, { externalId: 'c1', title: 'B', researchQuestionExternalId: null }], []);
    expect(codes(generateBlueprint(c), c)).toContain('SUBSECTION_ID_DUPLICATE');
  });

  it('ids that look like prototype keys are handled as plain strings', () => {
    const ids = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype'];
    const c = ctx(ids.map((id) => ({ externalId: id, title: id, researchQuestionExternalId: id })), ids.map((id) => ({ externalId: id, code: id, text: id })));
    const content = generateBlueprint(c);
    expect(section(content, 'results').subsections.map((s) => s.id)).toEqual(ids.map((id) => `claim:${id}`));
    expect(validateBlueprint(content, c)).toEqual([]);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('ids differing by case or whitespace stay distinct', () => {
    const c = ctx(['a', 'A', 'a ', ' a'].map((id) => ({ externalId: id, title: `t${id}`, researchQuestionExternalId: null })), []);
    const content = generateBlueprint(c);
    expect(new Set(section(content, 'results').subsections.map((s) => s.id)).size).toBe(4);
    expect(codes(content, c)).not.toContain('SUBSECTION_ID_DUPLICATE');
  });

  it('is deterministic', () => {
    expect(hashOfJson(generateBlueprint(realContext()))).toBe(hashOfJson(generateBlueprint(realContext())));
  });

  // The generator's output is not checked against the schema the PUT uses, so a snapshot can yield a version 1 that
  // the user cannot send back unchanged. These document whether the round trip GET -> PUT works for odd themes.
  it.each([
    ['an empty theme title', { externalId: 'c1', title: '', researchQuestionExternalId: null }],
    ['a theme title of 301 characters', { externalId: 'c1', title: 'x'.repeat(301), researchQuestionExternalId: null }],
    ['a theme id of 245 characters (claim: prefix pushes it over 250)', { externalId: 'i'.repeat(245), title: 'ok', researchQuestionExternalId: null }],
    ['a whitespace-only title', { externalId: 'c1', title: ' ​ ', researchQuestionExternalId: null }],
  ])('generated content passes its own schema with %s', (_name, claim) => {
    const content = generateBlueprint(ctx([claim], []));
    expect(blueprintContentSchema.safeParse(content).success).toBe(true);
  });

  it('generated content passes its own schema with 1001 themes', () => {
    const claims = Array.from({ length: 1001 }, (_, i) => ({ externalId: `c${i}`, title: `T${i}`, researchQuestionExternalId: null }));
    expect(blueprintContentSchema.safeParse(generateBlueprint(ctx(claims, []))).success).toBe(true);
  });

  it('generator with 5000 themes and 400 questions is fast', () => {
    const rqs = Array.from({ length: 400 }, (_, i) => ({ externalId: `rq${i}`, code: `RQ${i}`, text: 'q' }));
    const claims = Array.from({ length: 5000 }, (_, i) => ({ externalId: `c${i}`, title: `T${i}`, researchQuestionExternalId: `rq${i % 400}` }));
    const start = performance.now();
    const content = generateBlueprint(ctx(claims, rqs));
    const issues = validateBlueprint(content, ctx(claims, rqs));
    expect(performance.now() - start).toBeLessThan(3000);
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('titles keep their markdown and HTML as plain text (the renderer escapes them) but lose NUL and zero-width characters', () => {
    const title = '# <script>alert(1)</script> **x** a\u0000b ​';
    const content = generateBlueprint(ctx([{ externalId: 'c1', title, researchQuestionExternalId: null }], []));
    expect(section(content, 'results').subsections[0].title).toBe('# <script>alert(1)</script> **x** ab');
    expect(blueprintContentSchema.safeParse(content).success).toBe(true);
  });
});

describe('validator on hostile content', () => {
  const base = () => { const c = realContext(); return { c, content: generateBlueprint(c) }; };

  it('the real blueprint is approvable', () => {
    const { c, content } = base();
    expect(validateBlueprint(content, c)).toEqual([]);
  });

  it('coverage naming a subsection of an excluded section is blocking', () => {
    const { c, content } = base();
    section(content, 'discussion').include = false;
    content.coverage[0].subsectionIds = ['discussion:limitations'];
    expect(codes(content, c)).toContain('COVERAGE_UNKNOWN_SUBSECTION');
  });

  it('coverage pointing to a subsection id that does not exist is blocking', () => {
    const { c, content } = base();
    content.coverage[0].subsectionIds = ['nope'];
    expect(codes(content, c)).toContain('COVERAGE_UNKNOWN_SUBSECTION');
  });

  it('a section keyed __proto__ or constructor is SECTION_UNKNOWN, not a crash', () => {
    const { c, content } = base();
    content.sections.push({ key: '__proto__', include: true, wordBudget: { min: 1, max: 2 }, subsections: [] });
    content.sections.push({ key: 'constructor', include: true, wordBudget: { min: 1, max: 2 }, subsections: [] });
    expect(codes(content, c).filter((x) => x === 'SECTION_UNKNOWN')).toHaveLength(2);
  });

  it('sections in another order than the profile are accepted (order belongs to the profile)', () => {
    const { c, content } = base();
    content.sections.reverse();
    expect(hasBlockingIssue(validateBlueprint(content, c))).toBe(false);
  });

  it('two sections both keyed results: SECTION_DUPLICATE', () => {
    const { c, content } = base();
    content.sections.push(structuredClone(section(content, 'results')));
    const issues = codes(content, c);
    expect(issues).toContain('SECTION_DUPLICATE');
    expect(issues).toContain('SUBSECTION_ID_DUPLICATE');
  });

  it('subsection ids differing only by case or whitespace are not duplicates', () => {
    const { c, content } = base();
    const d = section(content, 'discussion');
    d.subsections.push({ ...d.subsections[0], id: 'DISCUSSION:LIMITATIONS' }, { ...d.subsections[0], id: 'discussion:limitations ' });
    d.subsections[0] = { ...d.subsections[0], id: 'Discussion:Limitations' };
    expect(codes(content, c)).not.toContain('SUBSECTION_ID_DUPLICATE');
  });

  it('subsection ids __proto__ / constructor and coverage pointing to them behave like normal ids', () => {
    const { c, content } = base();
    const r = section(content, 'results');
    r.subsections[0].id = '__proto__';
    r.subsections[1].id = 'constructor';
    content.coverage.forEach((entry) => { entry.subsectionIds = ['__proto__', 'constructor']; });
    expect(codes(content, c)).not.toContain('COVERAGE_UNKNOWN_SUBSECTION');
  });

  it('a claimId listed twice in one subsection and a rqId listed twice do not crash (observed: no issue raised)', () => {
    const { c, content } = base();
    const s = section(content, 'results').subsections[0];
    s.claimIds = [s.claimIds[0], s.claimIds[0]];
    s.rqIds = [...s.rqIds, ...s.rqIds];
    expect(() => validateBlueprint(content, c)).not.toThrow();
  });

  it('coverage by a subsection of a section that cannot answer questions (the Introduction) blocks the approval', () => {
    const { c, content } = base();
    content.coverage.forEach((entry) => { entry.subsectionIds = ['intro:research-questions']; });
    const issues = validateBlueprint(content, c);
    expect(issues.find((issue) => issue.code === 'COVERAGE_WRONG_SECTION')?.severity).toBe('blocking');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('coverage by a Results subsection that does not list the question is only a warning', () => {
    const { c, content } = base();
    section(content, 'results').subsections.forEach((s) => { s.rqIds = []; });
    const issues = validateBlueprint(content, c);
    expect(issues.some((issue) => issue.code === 'COVERAGE_RQ_MISMATCH' && issue.severity === 'warning')).toBe(true);
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('every question marked not applicable is approvable even though every theme answers one', () => {
    const { c, content } = base();
    content.coverage.forEach((entry) => { entry.subsectionIds = []; entry.notApplicableReason = 'n/a'; });
    expect(hasBlockingIssue(validateBlueprint(content, c))).toBe(false);
  });

  it('a coverage entry with both subsections and a not-applicable reason raises nothing', () => {
    const { c, content } = base();
    content.coverage[0].notApplicableReason = 'contradiction';
    expect(validateBlueprint(content, c)).toEqual([]);
  });

  it('wordBudget min > max is blocking', () => {
    const { c, content } = base();
    content.sections[0].wordBudget = { min: 10, max: 5 };
    expect(codes(content, c)).toContain('WORD_BUDGET_INVALID');
  });

  it('PROFILE_MISMATCH / PROFILE_OUTDATED', () => {
    const { c, content } = base();
    expect(codes({ ...content, profile: { id: 'x', version: 1 } }, c)).toContain('PROFILE_MISMATCH');
    expect(codes({ ...content, profile: { id: 'generic-imrad', version: 2 } }, c)).toContain('PROFILE_OUTDATED');
  });

  it('a coverage entry for a question that is not in the snapshot is blocking', () => {
    const { c, content } = base();
    content.coverage.push({ rqId: 'ghost', subsectionIds: [], notApplicableReason: 'x' });
    expect(codes(content, c)).toContain('UNKNOWN_RESEARCH_QUESTION');
  });
});

describe('validator speed and output size on DoS shapes', () => {
  const huge = (subs: number, ids: number, id = (i: number, j: number) => `u${i}-${j}`): BlueprintContent => {
    const content = generateBlueprint(realContext());
    const r = section(content, 'results');
    r.subsections = Array.from({ length: subs }, (_, i) => ({ id: `s${i}`, title: 't', purpose: null, claimIds: Array.from({ length: ids }, (_, j) => id(i, j)), rqIds: [] }));
    return content;
  };

  it('1000 subsections x 1000 known claimIds validates in under 3 s', () => {
    const c = realContext();
    const known = c.claims[0].externalId;
    const content = huge(1000, 1000, () => known);
    const start = performance.now();
    validateBlueprint(content, c);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it('500 coverage entries x 1000 ids validates in under 3 s', () => {
    const c = realContext();
    const content = generateBlueprint(c);
    content.coverage = Array.from({ length: 500 }, (_, i) => ({ rqId: i < c.researchQuestions.length ? c.researchQuestions[i].externalId : `x${i}`, subsectionIds: Array.from({ length: 1000 }, (_, j) => `z${j}`), notApplicableReason: null }));
    const start = performance.now();
    validateBlueprint(content, c);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it('the number of issues is bounded (1000 x 1000 unknown claimIds)', () => {
    const c = realContext();
    const content = huge(1000, 1000);
    const start = performance.now();
    const issues = validateBlueprint(content, c);
    const ms = performance.now() - start;
    const bytes = JSON.stringify(issues).length;
    console.log(`[qa] unknown-claim issues=${issues.length} json=${(bytes / 1e6).toFixed(1)}MB ms=${ms.toFixed(0)}`);
    // An unbounded list is sent by GET and in the 422 details; expect it to be capped at something sane.
    expect(issues.length).toBeLessThanOrEqual(10_000);
  });

  it('a blueprint of a million references is refused by the size limit, quickly', () => {
    const content = huge(1000, 1000);
    const start = performance.now();
    const parsed = blueprintContentSchema.safeParse(content);
    const ms = performance.now() - start;
    expect(parsed.success).toBe(false);
    expect(ms).toBeLessThan(5000);
  });
});

describe('schema', () => {
  const content = () => generateBlueprint(realContext());

  it('rejects deep nesting / unknown keys / __proto__ keys from JSON.parse', () => {
    const c = content();
    const withProto = JSON.parse(JSON.stringify(c).replace('{"profile"', '{"__proto__":{"polluted":1},"profile"'));
    expect(blueprintContentSchema.safeParse(withProto).success).toBe(false);
    const sub = JSON.parse(JSON.stringify(c));
    sub.sections[3].subsections[0].nested = { a: { b: { c: {} } } };
    expect(blueprintContentSchema.safeParse(sub).success).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('rejects 2**53, -1, 1.5 and 0 for word budgets and versions; accepts -0? (it is 0, not positive)', () => {
    for (const n of [2 ** 53, -1, 1.5, 0, -0, 1e21]) {
      const c = content(); c.sections[0].wordBudget.min = n;
      expect(blueprintContentSchema.safeParse(c).success, String(n)).toBe(false);
    }
  });

  it('accepts more than 20 sections? no: max 20', () => {
    const c = content();
    c.sections = Array.from({ length: 21 }, () => structuredClone(c.sections[0]));
    expect(blueprintContentSchema.safeParse(c).success).toBe(false);
  });

  it('text that PostgreSQL cannot store (NUL, lone surrogate) is refused by the schema', () => {
    for (const bad of ['a\u0000b', 'a\ud800b', 'x\udc00']) {
      const c = content(); c.sections[3].subsections[0].title = bad;
      expect(blueprintContentSchema.safeParse(c).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('content hash', () => {
  const content = () => generateBlueprint(realContext());
  it('does not depend on key order', () => {
    const c = content();
    const reordered = JSON.parse(JSON.stringify({ coverage: c.coverage, sections: c.sections.map((s) => ({ subsections: s.subsections, wordBudget: s.wordBudget, include: s.include, key: s.key })), profile: { version: c.profile.version, id: c.profile.id } }));
    expect(hashOfJson(reordered)).toBe(hashOfJson(c));
  });
  it('-0 and 0 hash the same', () => {
    expect(hashOfJson({ a: -0 })).toBe(hashOfJson({ a: 0 }));
  });
  it('NFC and NFD differ (no normalization is promised)', () => {
    expect(hashOfJson({ t: 'café' })).not.toBe(hashOfJson({ t: 'café' }));
  });
  it('array order matters', () => {
    expect(hashOfJson({ a: [1, 2] })).not.toBe(hashOfJson({ a: [2, 1] }));
  });
  it('a __proto__ own key is part of the hash', () => {
    const a = JSON.parse('{"__proto__":{"x":1},"b":1}');
    expect(hashOfJson(a)).not.toBe(hashOfJson({ b: 1 }));
  });
});
