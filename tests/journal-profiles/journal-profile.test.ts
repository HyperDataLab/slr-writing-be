import { describe, expect, it } from 'vitest';
import { DEFAULT_JOURNAL_PROFILE } from '../../src/modules/journal-profiles/default-profile.js';
import { journalProfileSchema, SECTION_SOURCES, type JournalProfile } from '../../src/modules/journal-profiles/journal-profile.schema.js';
import { getJournalProfile, listJournalProfiles } from '../../src/modules/journal-profiles/journal-profiles.service.js';
import { METHODS_GENERATOR, METHODS_SECTION } from '../../src/modules/methods/methods.service.js';

// Pure tests: the profile is a constant and the schema carries the rules.
const clone = (): JournalProfile => structuredClone(DEFAULT_JOURNAL_PROFILE);
const verified = (): JournalProfile => ({
  ...clone(),
  id: 'example-journal',
  journal: { name: 'Example Journal', url: 'https://example.org/journal' },
  verification: { status: 'verified', verifiedAt: '2026-11-02T00:00:00.000Z', verifiedBy: 'owner-uid', policySourceUrls: ['https://example.org/guidelines'] },
  wordBudgetSource: 'journal_policy',
  citationStyle: 'APA',
  notice: null,
});
const parse = (profile: unknown) => journalProfileSchema.safeParse(profile);
const messages = (profile: unknown) => {
  const result = parse(profile);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('the default profile', () => {
  it('is a generic IMRaD layout for a systematic review', () => {
    expect(DEFAULT_JOURNAL_PROFILE.sections.map((section) => section.key)).toEqual(['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusion']);
    expect(DEFAULT_JOURNAL_PROFILE).toMatchObject({ id: 'generic-imrad', articleType: 'systematic_review', language: 'en', journal: { name: null, url: null } });
  });

  it('is never presented as verified or as a journal policy', () => {
    expect(DEFAULT_JOURNAL_PROFILE.verification).toEqual({ status: 'unverified', verifiedAt: null, verifiedBy: null, policySourceUrls: [] });
    expect(DEFAULT_JOURNAL_PROFILE.wordBudgetSource).toBe('suggested_default');
    expect(DEFAULT_JOURNAL_PROFILE.notice).toMatch(/not verified/i);
    expect(DEFAULT_JOURNAL_PROFILE.citationStyle).toBeNull();
  });

  it('numbers its sections 1 to 6 in order', () => {
    expect(DEFAULT_JOURNAL_PROFILE.sections.map((section) => section.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('gives every section a sensible word range and a known set of sources', () => {
    for (const section of DEFAULT_JOURNAL_PROFILE.sections) {
      expect(section.wordBudget.min).toBeLessThanOrEqual(section.wordBudget.max);
      expect(section.sources.every((source) => (SECTION_SOURCES as readonly string[]).includes(source))).toBe(true);
      expect(section.purpose.length).toBeGreaterThan(10);
    }
  });

  it('follows docs/mvp-scope.md for where each section is written from', () => {
    const sources = (key: string) => DEFAULT_JOURNAL_PROFILE.sections.find((section) => section.key === key)!.sources;
    expect(sources('methods')).toEqual(expect.arrayContaining(['A10', 'prisma_writing_export']));
    expect(sources('results')).toContain('A1');
    expect(sources('discussion')).toContain('A7');
    expect(sources('abstract')).toEqual(['A10', 'other_sections']);
  });

  it('names the Methods generator that really exists, and no other section has one yet', () => {
    const withGenerator = DEFAULT_JOURNAL_PROFILE.sections.filter((section) => section.generator !== null);
    expect(withGenerator.map((section) => [section.key, section.generator])).toEqual([[METHODS_SECTION, METHODS_GENERATOR]]);
  });

  it('passes its own schema', () => {
    expect(parse(DEFAULT_JOURNAL_PROFILE).success).toBe(true);
  });
});

describe('journalProfileSchema rules', () => {
  it('accepts a verified profile that shows who checked it, when, and against what', () => {
    expect(parse(verified()).success).toBe(true);
  });

  it.each([
    ['a verification date', (p: JournalProfile) => { p.verification.verifiedAt = '2026-11-02T00:00:00.000Z'; }],
    ['a verifier', (p: JournalProfile) => { p.verification.verifiedBy = 'someone'; }],
    ['a policy source', (p: JournalProfile) => { p.verification.policySourceUrls = ['https://example.org/policy']; }],
  ])('refuses an unverified profile that carries %s', (_name, mutate) => {
    const profile = clone(); mutate(profile);
    expect(messages(profile).join(' ')).toMatch(/unverified profile cannot carry/);
  });

  it('refuses an unverified profile without a notice', () => {
    const profile = clone(); profile.notice = null;
    expect(messages(profile).join(' ')).toMatch(/must carry a notice/);
  });

  it('refuses an unverified profile that calls its word budgets journal policy', () => {
    const profile = clone(); profile.wordBudgetSource = 'journal_policy';
    expect(messages(profile).join(' ')).toMatch(/only offer suggested word budgets/);
  });

  it.each([
    ['no date', (p: JournalProfile) => { p.verification.verifiedAt = null; }],
    ['no verifier', (p: JournalProfile) => { p.verification.verifiedBy = null; }],
    ['no policy source', (p: JournalProfile) => { p.verification.policySourceUrls = []; }],
  ])('refuses a verified profile with %s', (_name, mutate) => {
    const profile = verified(); mutate(profile);
    expect(messages(profile).join(' ')).toMatch(/verified profile needs/);
  });

  it('refuses a verified profile that names no journal', () => {
    const profile = verified(); profile.journal = { name: null, url: null };
    expect(messages(profile).join(' ')).toMatch(/must name the journal/);
  });

  it('refuses duplicate section keys and orders with gaps or repeats', () => {
    const duplicateKey = clone(); duplicateKey.sections[1].key = 'abstract';
    expect(messages(duplicateKey).join(' ')).toMatch(/keys must be unique/);
    const gap = clone(); gap.sections[5].order = 9;
    expect(messages(gap).join(' ')).toMatch(/no gaps or repeats/);
    const repeat = clone(); repeat.sections[2].order = 2;
    expect(messages(repeat).join(' ')).toMatch(/no gaps or repeats/);
  });

  it('refuses a word range where min is above max, or not a positive integer', () => {
    for (const budget of [{ min: 500, max: 100 }, { min: 0, max: 100 }, { min: 1.5, max: 100 }, { min: -1, max: 5 }]) {
      const profile = clone(); profile.sections[0].wordBudget = budget;
      expect(parse(profile).success).toBe(false);
    }
  });

  it.each([
    ['an empty sections list', (p: JournalProfile) => { p.sections = []; }],
    ['a section without sources', (p: JournalProfile) => { p.sections[0].sources = []; }],
    ['an unknown source', (p: JournalProfile) => { (p.sections[0].sources as string[]) = ['A99']; }],
    ['a bad section key', (p: JournalProfile) => { p.sections[0].key = 'Bad Key'; }],
    ['a blank title', (p: JournalProfile) => { p.sections[0].title = '   '; }],
    ['a bad profile id', (p: JournalProfile) => { p.id = 'Has Spaces'; }],
    ['version 0', (p: JournalProfile) => { p.version = 0; }],
    ['an unknown language', (p: JournalProfile) => { (p as { language: string }).language = 'vi'; }],
    ['a policy url that is not a url', (p: JournalProfile) => { p.verification = { status: 'verified', verifiedAt: '2026-11-02T00:00:00.000Z', verifiedBy: 'x', policySourceUrls: ['not a url'] }; p.journal.name = 'J'; }],
  ])('refuses %s', (_name, mutate) => {
    const profile = clone(); mutate(profile);
    expect(parse(profile).success).toBe(false);
  });
});

describe('journal profile service', () => {
  it('lists the default profile', () => {
    expect(listJournalProfiles().map((profile) => profile.id)).toEqual(['generic-imrad']);
  });

  it('returns the profile by id', () => {
    expect(getJournalProfile('generic-imrad')).toEqual(DEFAULT_JOURNAL_PROFILE);
  });

  it.each([[''], ['unknown'], ['GENERIC-IMRAD'], ['generic-imrad '], ['__proto__'], ['constructor'], ['toString']])('does not find %j', (id) => {
    expect(() => getJournalProfile(id)).toThrow(expect.objectContaining({ statusCode: 404, code: 'JOURNAL_PROFILE_NOT_FOUND' }));
  });

  it('hands out copies, so changing one cannot change what the next caller gets', () => {
    const first = getJournalProfile('generic-imrad');
    first.sections[0].title = 'Hacked';
    first.verification.status = 'verified';
    first.notice = null;
    (first.sections as unknown[]).pop();
    const second = getJournalProfile('generic-imrad');
    expect(second).toEqual(DEFAULT_JOURNAL_PROFILE);
    expect(second.verification.status).toBe('unverified');
    const listed = listJournalProfiles();
    listed[0].sections.length = 0;
    expect(listJournalProfiles()[0].sections).toHaveLength(6);
    expect(DEFAULT_JOURNAL_PROFILE.sections).toHaveLength(6);
  });
});
