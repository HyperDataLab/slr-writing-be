import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_JOURNAL_PROFILE } from '../../src/modules/journal-profiles/default-profile.js';
import * as schemaModule from '../../src/modules/journal-profiles/journal-profile.schema.js';
import { journalProfileSchema, type JournalProfile } from '../../src/modules/journal-profiles/journal-profile.schema.js';
import * as serviceModule from '../../src/modules/journal-profiles/journal-profiles.service.js';
import { getJournalProfile, listJournalProfiles } from '../../src/modules/journal-profiles/journal-profiles.service.js';
import { METHODS_GENERATOR, METHODS_SECTION } from '../../src/modules/methods/methods.service.js';

// QA (adversarial) tests of M3, pure (no database).
const clone = (): any => structuredClone(DEFAULT_JOURNAL_PROFILE);
const verified = (): any => ({
  ...clone(),
  id: 'example-journal',
  journal: { name: 'Example Journal', url: 'https://example.org/journal' },
  verification: { status: 'verified', verifiedAt: '2026-11-02T00:00:00.000Z', verifiedBy: 'owner-uid', policySourceUrls: ['https://example.org/guidelines'] },
  wordBudgetSource: 'journal_policy',
  citationStyle: 'APA',
  notice: null,
});
const ok = (p: unknown) => journalProfileSchema.safeParse(p).success;
const withVerifiedAt = (v: unknown) => { const p = verified(); p.verification.verifiedAt = v; return p; };
const withPolicyUrl = (u: unknown) => { const p = verified(); p.verification.policySourceUrls = [u]; return p; };
const withJournalUrl = (u: unknown) => { const p = verified(); p.journal.url = u; return p; };

describe('baseline', () => {
  it('the default and the verified fixture parse', () => {
    expect(ok(clone())).toBe(true);
    expect(ok(verified())).toBe(true);
  });
});

describe('verifiedAt', () => {
  it.each([
    '2026-11-02T00:00:00Z', '2026-11-02T00:00:00.123Z', '2026-11-02T00:00:00.123456789Z',
    '2026-11-02T00:00Z', // no seconds: zod 3.25 datetime() treats seconds as optional (valid ISO 8601)
  ])('accepts UTC ISO %s', (v) => expect(ok(withVerifiedAt(v))).toBe(true));

  it.each([
    '2026-11-02T00:00:00+07:00', // offsets are refused by default (strict UTC); documented behaviour
    '2026-11-02', '2026-11-02 00:00:00Z', 'yesterday', '', ' ', '2026-11-02T00:00:00', // no Z
    '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-11-02T24:00:00Z', '2026-12-31T23:59:60Z',
    '2026-11-02T00:00:00z', '+02026-11-02T00:00:00Z',
  ])('refuses %j', (v) => expect(ok(withVerifiedAt(v))).toBe(false));

  it('refuses non-strings', () => {
    for (const v of [0, Date.now(), new Date(), true, {}, []]) expect(ok(withVerifiedAt(v)), String(v)).toBe(false);
  });

  it('BUG: refuses a verification date in the future (a profile cannot be verified tomorrow)', () => {
    expect(ok(withVerifiedAt('2999-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('verifiedBy and notice', () => {
  it.each(['', ' ', '\t\n', ' ', '　'])('verified profile refuses verifiedBy %j', (v) => {
    const p = verified(); p.verification.verifiedBy = v;
    expect(ok(p)).toBe(false);
  });
  it('BUG: refuses zero-width-only verifiedBy', () => {
    const p = verified(); p.verification.verifiedBy = '​';
    expect(ok(p)).toBe(false);
  });
  it.each(['', ' ', '\n\t', ' '])('unverified profile refuses notice %j', (v) => {
    const p = clone(); p.notice = v;
    expect(ok(p)).toBe(false);
  });
  it('unverified profile refuses notice missing or undefined', () => {
    const p = clone(); delete p.notice;
    expect(ok(p)).toBe(false);
  });
  it('trims title/name/notice in the output', () => {
    const p = clone(); p.notice = '  Not verified.  ';
    expect(journalProfileSchema.parse(p).notice).toBe('Not verified.');
  });
});

describe('URLs', () => {
  const malformed = ['https://', 'not a url', ''];
  const unsafe = [
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://example.org/x',
    'http://localhost/x', 'http://127.0.0.1/', 'mailto:a@b.c', 'vbscript:msgbox(1)',
  ];
  it.each(malformed)('policySourceUrls refuses %j', (u) => expect(ok(withPolicyUrl(u))).toBe(false));
  it.each(malformed)('journal.url refuses %j', (u) => expect(ok(withJournalUrl(u))).toBe(false));
  // z.string().url() is only `new URL(x)`: any scheme parses, so a "verified" profile can cite javascript: as its policy source
  it.each(unsafe)('BUG: policySourceUrls refuses %j', (u) => expect(ok(withPolicyUrl(u))).toBe(false));
  it.each(unsafe)('BUG: journal.url refuses %j', (u) => expect(ok(withJournalUrl(u))).toBe(false));
  it('a profile with only javascript: as policy source is refused instead of passing as verified', () => {
    const p = verified(); p.verification.policySourceUrls = ['javascript:alert(document.cookie)'];
    expect(journalProfileSchema.safeParse(p).success).toBe(false);
  });

  it('BUG: policySourceUrls refuses plain http (no TLS)', () => expect(ok(withPolicyUrl('http://example.org/guidelines'))).toBe(false));
  it('policySourceUrls accepts unicode host (IDN) https', () => expect(ok(withPolicyUrl('https://例え.テスト/guide'))).toBe(true));
  it('BUG: policySourceUrls refuses a 100 kB URL', () => expect(ok(withPolicyUrl(`https://example.org/${'a'.repeat(100_000)}`))).toBe(false));
  it('BUG: policySourceUrls refuses duplicates', () => {
    const p = verified(); p.verification.policySourceUrls = ['https://example.org/g', 'https://example.org/g'];
    expect(ok(p)).toBe(false);
  });
});

describe('status and unknown keys', () => {
  it.each(['Verified', 'VERIFIED', ' verified', 'verified ', 'true', '', null, true, 1])('refuses status %j', (s) => {
    const p = verified(); p.verification.status = s;
    expect(ok(p)).toBe(false);
  });

  it('strips smuggled top-level and nested keys', () => {
    const p = clone();
    p.verified = true; p.isVerified = true; p.verification.verified = true; p.verification.approved = true;
    p.sections[0].policy = 'journal';
    const out: any = journalProfileSchema.parse(p);
    expect(out.verified).toBeUndefined();
    expect(out.isVerified).toBeUndefined();
    expect(out.verification.verified).toBeUndefined();
    expect(out.verification.approved).toBeUndefined();
    expect(out.sections[0].policy).toBeUndefined();
  });

  it('JSON __proto__ / constructor.prototype smuggling does not make an unverified profile look verified', () => {
    const raw = JSON.parse(JSON.stringify(clone())
      .replace('"verification":{', '"verification":{"__proto__":{"status":"verified","verifiedBy":"x"},')
      .replace('{"id":', '{"__proto__":{"verified":true,"wordBudgetSource":"journal_policy"},"constructor":{"prototype":{"verified":true}},"id":'));
    const out: any = journalProfileSchema.parse(raw);
    expect(out.verification.status).toBe('unverified');
    expect(out.verification.verifiedBy).toBeNull();
    expect(out.verified).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(({} as any).verified).toBeUndefined();
  });

  it('a verification object whose status comes only from its prototype is refused', () => {
    const p = clone();
    p.verification = Object.assign(Object.create({ status: 'verified' }), { verifiedAt: null, verifiedBy: null, policySourceUrls: [] });
    // zod reads inherited properties; check what happens rather than assuming
    const r = journalProfileSchema.safeParse(p);
    if (r.success) expect(r.data.verification.status).not.toBe('verified');
  });
});

describe('verified profile with suggested budgets and other combinations', () => {
  it('a verified profile with wordBudgetSource suggested_default parses (allowed by design, see report)', () => {
    const p = verified(); p.wordBudgetSource = 'suggested_default';
    expect(ok(p)).toBe(true);
  });
  it('a verified profile without journal.url still parses', () => {
    const p = verified(); p.journal.url = null;
    expect(ok(p)).toBe(true);
  });
  it('an unverified profile naming a real journal and a citation style still parses (presented as that journal)', () => {
    const p = clone(); p.journal = { name: 'Nature', url: 'https://www.nature.com' }; p.citationStyle = 'Nature';
    expect(ok(p)).toBe(true);
  });
  it('an unverified profile cannot carry each verification field on its own', () => {
    for (const patch of [{ verifiedAt: '2026-11-02T00:00:00Z' }, { verifiedBy: 'x' }, { policySourceUrls: ['https://example.org'] }]) {
      const p = clone(); Object.assign(p.verification, patch);
      expect(ok(p), JSON.stringify(patch)).toBe(false);
    }
  });
  it('a verified profile missing each requirement is refused', () => {
    for (const mutate of [
      (p: any) => { p.verification.verifiedAt = null; }, (p: any) => { p.verification.verifiedBy = null; },
      (p: any) => { p.verification.policySourceUrls = []; }, (p: any) => { p.journal.name = null; },
      (p: any) => { delete p.verification.verifiedAt; },
    ]) { const p = verified(); mutate(p); expect(ok(p)).toBe(false); }
  });
});

describe('version, id, keys', () => {
  it.each([0, -1, 1.5, NaN, Infinity, '1', null])('refuses version %j', (v) => {
    const p = clone(); p.version = v; expect(ok(p)).toBe(false);
  });
  it('BUG: refuses a version beyond the safe-integer range', () => {
    const p = clone(); p.version = Number.MAX_SAFE_INTEGER + 2; expect(ok(p)).toBe(false);
  });
  it.each(['generic-imrad\n', '\ngeneric-imrad', 'Generic', '1abc', '-abc', '', 'a b', 'a_b', 'abc\u0000', 'ａbc', 'aK'])('refuses id %j', (id) => {
    const p = clone(); p.id = id; expect(ok(p)).toBe(false);
  });
  it.each(['a-', 'a--b'])('id %j with trailing/double hyphen is accepted (cosmetic)', (id) => {
    const p = clone(); p.id = id; expect(ok(p)).toBe(true);
  });
  it.each(['methods\n', 'Methods', '1x', '_x', 'x-y', '', 'x y', 'ｍethods'])('refuses section key %j', (key) => {
    const p = clone(); p.sections[0].key = key; expect(ok(p)).toBe(false);
  });
  it('BUG: refuses an id longer than the param guard allows (200), else it is unreachable over HTTP', () => {
    const p = clone(); p.id = `a${'b'.repeat(250)}`; expect(ok(p)).toBe(false);
  });
});

describe('sections', () => {
  const section = (i: number) => ({ ...clone().sections[0], key: `s${i}`, order: i + 1 });
  it('BUG: refuses an unbounded number of sections (10,000)', () => {
    const p = clone(); p.sections = Array.from({ length: 10_000 }, (_, i) => section(i));
    expect(ok(p)).toBe(false);
  });
  it.each([[[1.5, 2]], [[-1, 0]], [['1', '2']], [[0, 1]], [[1, 1]], [[1, 3]], [[2, 3]]])('refuses orders %j', (orders) => {
    const p = clone(); p.sections = (orders as unknown[]).map((order, i) => ({ ...section(i), order }));
    expect(ok(p)).toBe(false);
  });
  it('BUG: orders given out of array order: either refused or the output is sorted by order', () => {
    const p = clone(); p.sections = clone().sections.reverse();
    const r = journalProfileSchema.safeParse(p);
    if (r.success) expect(r.data.sections.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('duplicate keys refused', () => {
    const p = clone(); p.sections[1].key = 'abstract'; expect(ok(p)).toBe(false);
  });
  it('BUG: duplicate sources inside one section refused', () => {
    const p = clone(); p.sections[0].sources = ['A1', 'A1']; expect(ok(p)).toBe(false);
  });
  it.each(['A3', 'a1', 'A1 ', 'prisma', ''])('refuses unknown source %j', (s) => {
    const p = clone(); p.sections[0].sources = [s]; expect(ok(p)).toBe(false);
  });
  it('refuses min > max, zero and negative budgets, floats', () => {
    for (const b of [{ min: 2, max: 1 }, { min: 0, max: 1 }, { min: -1, max: 1 }, { min: 1.5, max: 3 }, { min: 1 }]) {
      const p = clone(); p.sections[0].wordBudget = b; expect(ok(p), JSON.stringify(b)).toBe(false);
    }
  });
  it('accepts min == max', () => {
    const p = clone(); p.sections[0].wordBudget = { min: 5, max: 5 }; expect(ok(p)).toBe(true);
  });
  it('BUG: refuses a whitespace-only generator string', () => {
    const p = clone(); p.sections[0].generator = '   '; expect(ok(p)).toBe(false);
  });
  it('BUG: refuses an unknown generator name (no generator called "gpt-free-writer@9" exists)', () => {
    const p = clone(); p.sections[0].generator = 'gpt-free-writer@9'; expect(ok(p)).toBe(false);
  });
  it('refuses empty sections', () => { const p = clone(); p.sections = []; expect(ok(p)).toBe(false); });
});

describe('the schema is the real gate', () => {
  it('the service exports only read functions (no way to register a profile without parsing)', () => {
    expect(Object.keys(serviceModule).sort()).toEqual(['getJournalProfile', 'listJournalProfiles']);
  });
  it('the schema module exports schemas and constants only', () => {
    expect(Object.keys(schemaModule).sort()).toEqual(['SECTION_SOURCES', 'journalProfileSchema', 'profileSectionSchema', 'verificationSchema', 'wordBudgetSchema']);
  });
  it('every profile the service returns re-parses to itself', () => {
    for (const p of listJournalProfiles()) expect(journalProfileSchema.parse(p)).toEqual(p);
  });
  it('default-profile.ts parses its draft (not a cast)', () => {
    const src = readFileSync(new URL('../../src/modules/journal-profiles/default-profile.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/journalProfileSchema\.parse\(draft\)/);
    expect(src).not.toMatch(/as JournalProfile/);
  });
  it('the service source does not add profiles that skip the schema', () => {
    const src = readFileSync(new URL('../../src/modules/journal-profiles/journal-profiles.service.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/PROFILES: readonly JournalProfile\[\] = \[DEFAULT_JOURNAL_PROFILE\]/);
  });
});

describe('mutability', () => {
  it('mutating a returned copy (nested arrays included) does not change later reads', () => {
    const a = getJournalProfile('generic-imrad');
    a.verification.status = 'verified' as any;
    a.verification.policySourceUrls.push('https://evil.example');
    a.sections[2].sources.push('A7');
    a.sections[2].sources.length = 0;
    a.sections.pop();
    (a as any).journal.name = 'Nature';
    const l = listJournalProfiles(); l[0].notice = null; l.push(a);
    const b = getJournalProfile('generic-imrad');
    expect(b).toEqual(JSON.parse(JSON.stringify(b)));
    expect(b.verification.status).toBe('unverified');
    expect(b.verification.policySourceUrls).toEqual([]);
    expect(b.sections).toHaveLength(6);
    expect(b.sections[2].sources).toEqual(['A10', 'prisma_writing_export', 'A2']);
    expect(b.journal.name).toBeNull();
    expect(listJournalProfiles()).toHaveLength(1);
    expect(listJournalProfiles()[0].notice).not.toBeNull();
  });

  it('two calls return distinct objects at every level', () => {
    const a = getJournalProfile('generic-imrad'); const b = getJournalProfile('generic-imrad');
    expect(a).not.toBe(b); expect(a.sections).not.toBe(b.sections); expect(a.sections[0].sources).not.toBe(b.sections[0].sources);
    expect(a.verification.policySourceUrls).not.toBe(b.verification.policySourceUrls);
  });

  it('BUG: the exported DEFAULT_JOURNAL_PROFILE cannot be mutated into a verified profile that the service then serves', () => {
    const original = structuredClone(DEFAULT_JOURNAL_PROFILE);
    let changed = false;
    try {
      try { (DEFAULT_JOURNAL_PROFILE.verification as any).status = 'verified'; } catch { /* frozen: fine */ }
      try { DEFAULT_JOURNAL_PROFILE.sections[0].sources.push('A1'); } catch { /* frozen: fine */ }
      const served = getJournalProfile('generic-imrad');
      changed = served.verification.status !== 'unverified' || served.sections[0].sources.length !== original.sections[0].sources.length;
    } finally {
      // restore so other tests in this file see the real profile
      try { Object.assign(DEFAULT_JOURNAL_PROFILE.verification, original.verification); DEFAULT_JOURNAL_PROFILE.sections[0].sources.splice(0, Infinity, ...original.sections[0].sources); } catch { /* frozen */ }
    }
    expect(changed).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', 'prototype', '0', 'length', '', ' generic-imrad', 'generic-imrad '])('getJournalProfile(%j) throws not found', (id) => {
    expect(() => getJournalProfile(id)).toThrowError(expect.objectContaining({ statusCode: 404, code: 'JOURNAL_PROFILE_NOT_FOUND' }));
  });

  it('getJournalProfile with non-string runtime values throws not found', () => {
    for (const v of [undefined, null, 1, {}, ['generic-imrad'], { toString: () => 'generic-imrad' }]) {
      expect(() => getJournalProfile(v as any), String(v)).toThrow();
    }
  });
});

describe('consistency with the rest of the system', () => {
  it('the methods section key and generator match methods.service.ts', () => {
    const m = DEFAULT_JOURNAL_PROFILE.sections.find((s) => s.key === METHODS_SECTION);
    expect(m?.generator).toBe(METHODS_GENERATOR);
    expect(DEFAULT_JOURNAL_PROFILE.sections.filter((s) => s.generator !== null).map((s) => s.key)).toEqual(['abstract', METHODS_SECTION, 'conclusion']);
  });
  it('DOC DRIFT: mvp-scope section 5: Discussion uses limitations from A1 and A10', () => {
    const d = DEFAULT_JOURNAL_PROFILE.sections.find((s) => s.key === 'discussion')!;
    expect(d.sources).toEqual(expect.arrayContaining(['A7', 'A1', 'A10']));
  });
  it('DOC DRIFT: mvp-scope section 5: Abstract/Introduction/Conclusion are written from the other sections and the RQs', () => {
    for (const key of ['abstract', 'introduction', 'conclusion']) {
      const s = DEFAULT_JOURNAL_PROFILE.sections.find((x) => x.key === key)!;
      expect(s.sources, key).toEqual(expect.arrayContaining(['other_sections']));
      expect(s.sources.some((src) => src === 'rq_findings' || src === 'A10'), key).toBe(true);
    }
  });
  it('mvp-scope section 5: Methods uses A10 and prisma export; Results uses A1', () => {
    const find = (k: string) => DEFAULT_JOURNAL_PROFILE.sections.find((s) => s.key === k)!.sources;
    expect(find('methods')).toEqual(expect.arrayContaining(['A10', 'prisma_writing_export']));
    expect(find('results')).toEqual(expect.arrayContaining(['A1']));
  });
  it('section keys fit ManuscriptSection.sectionKey usage (lower snake)', () => {
    for (const s of DEFAULT_JOURNAL_PROFILE.sections) expect(s.key).toMatch(/^[a-z][a-z0-9_]*$/);
  });
  it('guide M3 text mentions the same ids, version, sources and generator as the code', () => {
    const guide = readFileSync(new URL('../../docs/PROJECT_GUIDE.md', import.meta.url), 'utf8');
    const m3 = guide.slice(guide.indexOf('### M3'), guide.indexOf('### M4'));
    expect(m3).toContain('generic-imrad');
    expect(m3).toContain('version 1');
    expect(m3).toContain(METHODS_GENERATOR);
    for (const src of schemaModule.SECTION_SOURCES) expect(m3).toContain(`\`${src}\``);
  });
  it('DOC BUG: guide section 8 lists 401 for the single-profile route too', () => {
    const guide = readFileSync(new URL('../../docs/PROJECT_GUIDE.md', import.meta.url), 'utf8');
    const row = guide.split('\n').find((l) => l.includes('`/journal-profiles/:profileId`'))!;
    expect(row).toMatch(/401/);
  });
});

describe('performance', () => {
  it('lists 10,000 times quickly and getJournalProfile 10,000 times quickly', () => {
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i += 1) listJournalProfiles();
    for (let i = 0; i < 10_000; i += 1) getJournalProfile('generic-imrad');
    expect(performance.now() - t0).toBeLessThan(3000);
  });
  it('parsing a 1,000-section profile is fast (schema is O(n log n))', () => {
    const p = clone(); p.sections = Array.from({ length: 1000 }, (_, i) => ({ ...clone().sections[0], key: `s${i}`, order: i + 1 }));
    const t0 = performance.now(); journalProfileSchema.safeParse(p);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

export type _Unused = JournalProfile;
