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
    expect(omitted).toEqual(['discussion']);
  });

  it('does not require sections whose plans all lack evidence (the engine cannot draft them)', () => {
    const { required, omitted } = computeRequiredSections({
      blueprintSections,
      plans: [{ sectionKey: 'discussion', status: 'NEEDS_EVIDENCE' }],
    });
    expect(required).not.toContain('discussion');
    expect(omitted).toContain('discussion');
  });

  it('treats an included Abstract and Conclusion as synthesis sections: required for H3, not for verification', () => {
    const { required, synthesis, omitted } = computeRequiredSections({
      blueprintSections: [...blueprintSections.slice(0, 5), { key: 'conclusion', include: true }],
      plans: [{ sectionKey: 'introduction', status: 'READY_TO_DRAFT' }],
    });
    expect(synthesis).toEqual(['abstract', 'conclusion']);
    expect(required).not.toContain('abstract');
    expect(omitted).not.toContain('abstract');
    expect(omitted).not.toContain('conclusion');
  });

  it('leaves out a synthesis section the blueprint excludes', () => {
    const { synthesis } = computeRequiredSections({ blueprintSections, plans: [] });
    expect(synthesis).toEqual(['abstract']);
  });

  it('reports required sections that have no ready plan as undraftable', () => {
    const { undraftable } = computeRequiredSections({
      blueprintSections,
      plans: [{ sectionKey: 'introduction', status: 'READY_TO_DRAFT' }],
    });
    expect(undraftable).toEqual(['results']);
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
