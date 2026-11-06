import { describe, expect, it } from 'vitest';
import { computeRequiredSections } from '../../src/modules/manuscripts/required-sections.js';

const blueprintSections = [
  { key: 'abstract', include: true },
  { key: 'introduction', include: true },
  { key: 'methods', include: true },
  { key: 'results', include: true },
  { key: 'discussion', include: true },
  { key: 'conclusion', include: false },
];

describe('computeRequiredSections', () => {
  it('always requires methods and results, even without plans', () => {
    const { required } = computeRequiredSections({ blueprintSections: [], plans: [] });
    expect(required).toEqual(['methods', 'results']);
  });

  it('requires included sections that have a READY_TO_DRAFT plan', () => {
    const { required, omitted } = computeRequiredSections({
      blueprintSections,
      plans: [
        { sectionKey: 'introduction', status: 'READY_TO_DRAFT' },
        { sectionKey: 'results', status: 'READY_TO_DRAFT' },
      ],
    });
    expect(required).toEqual(['methods', 'results', 'introduction']);
    expect(omitted).toEqual(['abstract', 'discussion']);
  });

  it('does not require sections whose plans all lack evidence (the engine cannot draft them)', () => {
    const { required, omitted } = computeRequiredSections({
      blueprintSections,
      plans: [{ sectionKey: 'discussion', status: 'NEEDS_EVIDENCE' }],
    });
    expect(required).not.toContain('discussion');
    expect(omitted).toContain('discussion');
  });

  it('ignores sections the blueprint excludes', () => {
    const { required, omitted } = computeRequiredSections({
      blueprintSections,
      plans: [{ sectionKey: 'conclusion', status: 'READY_TO_DRAFT' }],
    });
    expect(required).not.toContain('conclusion');
    expect(omitted).not.toContain('conclusion');
  });
});
