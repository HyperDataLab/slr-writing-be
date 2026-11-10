import { describe, expect, it } from 'vitest';
import { IEEE_JOURNAL_PROFILE } from '../../src/modules/journal-profiles/ieee-profile.js';
import { journalProfileSchema, SECTION_SOURCES } from '../../src/modules/journal-profiles/journal-profile.schema.js';
import { getJournalProfile, listJournalProfiles } from '../../src/modules/journal-profiles/journal-profiles.service.js';

describe('IEEE Conference Journal Profile', () => {
  it('passes its own schema verification', () => {
    expect(journalProfileSchema.safeParse(IEEE_JOURNAL_PROFILE).success).toBe(true);
  });

  it('matches IEEE conference profile metadata', () => {
    expect(IEEE_JOURNAL_PROFILE.id).toBe('ieee-conference');
    expect(IEEE_JOURNAL_PROFILE.name).toBe('IEEE Conference Two-Column Format');
    expect(IEEE_JOURNAL_PROFILE.citationStyle).toBe('IEEE Numeric [1]');
    expect(IEEE_JOURNAL_PROFILE.articleType).toBe('systematic_review');
    expect(IEEE_JOURNAL_PROFILE.journal.name).toBe('IEEE Conference Proceedings');
  });

  it('numbers its sections 1 to 6 in proper manuscript order', () => {
    expect(IEEE_JOURNAL_PROFILE.sections.map((s) => s.key)).toEqual([
      'abstract',
      'introduction',
      'methods',
      'results',
      'discussion',
      'conclusion',
    ]);
    expect(IEEE_JOURNAL_PROFILE.sections.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('has valid word budgets and recognized sources for all sections', () => {
    for (const section of IEEE_JOURNAL_PROFILE.sections) {
      expect(section.wordBudget.min).toBeLessThanOrEqual(section.wordBudget.max);
      expect(section.sources.every((src) => (SECTION_SOURCES as readonly string[]).includes(src))).toBe(true);
      expect(section.purpose.length).toBeGreaterThan(10);
    }
  });

  it('is retrievable via getJournalProfile("ieee-conference")', () => {
    const profile = getJournalProfile('ieee-conference');
    expect(profile.id).toBe('ieee-conference');
    expect(profile.name).toContain('IEEE');
    // Ensure deep clone isolation
    profile.name = 'Tampered';
    expect(getJournalProfile('ieee-conference').name).toBe('IEEE Conference Two-Column Format');
  });

  it('does not disturb default listJournalProfiles backward compatibility', () => {
    const list = listJournalProfiles();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('generic-imrad');
  });
});
