import { describe, expect, it } from 'vitest';
import {
  buildCitationManifest,
  type SectionRevisionForManifest,
  type SnapshotRegistryForManifest,
} from '../../src/modules/verification/manifest.service.js';
import { G1CitationIntegrityEvaluator } from '../../src/modules/verification/gates/g1-citation-integrity.js';
import { G2QuoteFidelityEvaluator } from '../../src/modules/verification/gates/g2-quote-fidelity.js';
import { G3PrismaReconciliationEvaluator } from '../../src/modules/verification/gates/g3-prisma-reconciliation.js';
import { G4UngroundedNumbersEvaluator } from '../../src/modules/verification/gates/g4-ungrounded-numbers.js';
import { G7RqCoverageEvaluator } from '../../src/modules/verification/gates/g7-rq-coverage.js';
import type { GateEvaluationContext } from '../../src/modules/verification/gates/gate.interface.js';
import {
  citationItemSchema,
  citationManifestSchema,
  gateIdSchema,
  gateSeveritySchema,
  gateStatusSchema,
  qualityGateResultSchema,
  reviewIssueSchema,
  unresolvedCitationSchema,
  verificationOverallStatusSchema,
  verificationReportSummaryRowSchema,
  verificationReportViewSchema,
  verificationSummarySchema,
  type CitationManifest,
} from '../../src/modules/verification/verification.types.js';

// ============================================================================
// Test Fixtures & Factories (Pure, in-memory, no I/O)
// ============================================================================

function createMockRegistry(overrides?: Partial<SnapshotRegistryForManifest>): SnapshotRegistryForManifest {
  return {
    studies: [
      { externalId: 'study-1', title: 'Empirical Study on Copilot', year: 2023 },
      { externalId: 'study-2', title: 'LLM Assisted Programming Review', year: 2024 },
      { externalId: 'study-3', title: 'Undated Preliminary Report', year: null },
    ],
    findings: [
      {
        externalId: 'F:study-1:acc',
        studyId: 'study-1',
        fieldName: 'accuracy',
        valueText: 'Reported 85% accuracy in synthesis benchmark',
      },
      {
        externalId: 'F:study-2:speed',
        studyId: 'study-2',
        fieldName: 'speedup',
        valueText: 'Programmers were 42.5% faster with assistant',
      },
    ],
    evidence: [
      {
        externalId: 'E-study-1-quote-1',
        studyId: 'study-1',
        quote: 'Copilot improved task completion speed by 55% in controlled trials.',
        quoteHashVerified: true,
      },
      {
        externalId: 'E-study-2-quote-1',
        studyId: 'study-2',
        quote: 'Participants completed programming assignments 30% faster.',
        quoteHashVerified: false,
      },
      {
        externalId: 'E-study-3-quote-1',
        studyId: 'study-3',
        quote: 'Preliminary qualitative feedback was mostly positive.',
        quoteHashVerified: true,
      },
    ],
    ...overrides,
  };
}

function createMockContext(overrides?: Partial<GateEvaluationContext>): GateEvaluationContext {
  const registry = overrides?.registry ?? createMockRegistry();
  const sections: SectionRevisionForManifest[] = overrides?.sections ?? [
    {
      sectionKey: 'results',
      version: 1,
      markdown: 'Copilot achieved high accuracy in RQ-1 evaluations.',
      facts: {
        paragraphs: [
          {
            paragraphId: 'para-1',
            text: 'Copilot achieved high accuracy in RQ-1 evaluations.',
            usedEvidenceIds: ['E-study-1-quote-1'],
            usedFindingIds: ['F:study-1:acc'],
          },
        ],
      },
    },
  ];

  const manifest =
    overrides?.manifest ??
    buildCitationManifest({
      manuscriptId: 'ms-test-1',
      snapshotId: 'snap-test-1',
      sections,
      registry,
    });

  return {
    manifest,
    sections,
    registry,
    blueprint: {
      researchQuestions: [
        { rqId: 'rq-1', code: 'RQ-1', question: 'How effective are code assistants?' },
      ],
      sections: [
        { key: 'results', include: true, subsections: [{ id: 'sub-1', title: 'Code Assistants' }] },
      ],
    },
    supplements: {
      prismaWritingExport: {
        flow: {
          studiesIncluded: registry.studies.length,
        },
        includedStudies: registry.studies.map((s) => ({ id: s.externalId })),
      },
    },
    paragraphPlans: [],
    ...overrides,
  };
}

// ============================================================================
// 1. buildCitationManifest
// ============================================================================

describe('buildCitationManifest', () => {
  it('correctly maps usedEvidenceIds to study metadata and evidence quote details', () => {
    const registry = createMockRegistry();
    const sections: SectionRevisionForManifest[] = [
      {
        sectionKey: 'results',
        version: 1,
        markdown: 'Results text referencing verified evidence.',
        facts: {
          paragraphs: [
            {
              paragraphId: 'para-1',
              text: 'Some verified finding from study 1.',
              usedEvidenceIds: ['E-study-1-quote-1'],
              usedFindingIds: [],
            },
          ],
        },
      },
    ];

    const manifest = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections,
      registry,
    });

    expect(manifest.manuscriptId).toBe('ms-1');
    expect(manifest.snapshotId).toBe('snap-1');
    expect(manifest.items).toHaveLength(1);
    expect(manifest.unresolvedCitations).toHaveLength(0);

    const item = manifest.items[0];
    expect(item).toEqual({
      citationId: 'cit-results-para-1-E-study-1-quote-1',
      sectionKey: 'results',
      paragraphId: 'para-1',
      evidenceId: 'E-study-1-quote-1',
      studyId: 'study-1',
      studyTitle: 'Empirical Study on Copilot',
      studyYear: 2023,
      quote: 'Copilot improved task completion speed by 55% in controlled trials.',
      quoteHashVerified: true,
      isResolved: true,
    });
  });

  it('correctly maps usedFindingIds to study metadata with quoteHashVerified true', () => {
    const registry = createMockRegistry();
    const sections: SectionRevisionForManifest[] = [
      {
        sectionKey: 'discussion',
        version: 1,
        markdown: 'Discussion paragraph referencing quantitative finding.',
        facts: {
          paragraphs: [
            {
              paragraphId: 'para-2',
              text: 'Speedup was notable across trials.',
              usedEvidenceIds: [],
              usedFindingIds: ['F:study-2:speed'],
            },
          ],
        },
      },
    ];

    const manifest = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections,
      registry,
    });

    expect(manifest.items).toHaveLength(1);
    expect(manifest.unresolvedCitations).toHaveLength(0);

    const item = manifest.items[0];
    expect(item).toEqual({
      citationId: 'cit-discussion-para-2-F:study-2:speed',
      sectionKey: 'discussion',
      paragraphId: 'para-2',
      findingId: 'F:study-2:speed',
      studyId: 'study-2',
      studyTitle: 'LLM Assisted Programming Review',
      studyYear: 2024,
      quoteHashVerified: true,
      isResolved: true,
    });
  });

  it('handles studies with null year or unknown study gracefully', () => {
    const registry = createMockRegistry({
      studies: [
        { externalId: 'study-3', title: 'Undated Report', year: null },
      ],
      evidence: [
        {
          externalId: 'E-study-3-quote-1',
          studyId: 'study-3',
          quote: 'Quote from undated study.',
          quoteHashVerified: true,
        },
        {
          externalId: 'E-orphan-quote',
          studyId: 'non-existent-study-id',
          quote: 'Quote from orphaned study.',
          quoteHashVerified: false,
        },
      ],
    });

    const sections: SectionRevisionForManifest[] = [
      {
        sectionKey: 'methods',
        version: 1,
        markdown: 'Method text.',
        facts: {
          paragraphs: [
            {
              paragraphId: 'para-null-year',
              usedEvidenceIds: ['E-study-3-quote-1', 'E-orphan-quote'],
            },
          ],
        },
      },
    ];

    const manifest = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections,
      registry,
    });

    expect(manifest.items).toHaveLength(2);
    expect(manifest.items[0].studyYear).toBeNull();
    expect(manifest.items[0].studyTitle).toBe('Undated Report');

    // Orphaned study defaults to 'Unknown Study' and null year
    expect(manifest.items[1].studyTitle).toBe('Unknown Study');
    expect(manifest.items[1].studyYear).toBeNull();
  });

  it('deduplicates duplicate evidence IDs within the same paragraph', () => {
    const registry = createMockRegistry();
    const sections: SectionRevisionForManifest[] = [
      {
        sectionKey: 'results',
        version: 1,
        markdown: 'Text',
        facts: {
          paragraphs: [
            {
              paragraphId: 'para-1',
              text: 'Text referencing same evidence twice',
              usedEvidenceIds: ['E-study-1-quote-1', 'E-study-1-quote-1'],
              usedFindingIds: [],
            },
          ],
        },
      },
    ];

    const manifest = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections,
      registry,
    });

    expect(manifest.items).toHaveLength(1);
    expect(manifest.resolvedCitations).toBe(1);
    expect(manifest.totalCitations).toBe(1);
  });

  it('deduplicates duplicate finding IDs within the same paragraph', () => {
    const registry = createMockRegistry();
    const sections: SectionRevisionForManifest[] = [
      {
        sectionKey: 'results',
        version: 1,
        markdown: 'Text',
        facts: {
          paragraphs: [
            {
              paragraphId: 'para-1',
              usedEvidenceIds: [],
              usedFindingIds: ['F:study-1:acc', 'F:study-1:acc'],
            },
          ],
        },
      },
    ];

    const manifest = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections,
      registry,
    });

    expect(manifest.items).toHaveLength(1);
    expect(manifest.resolvedCitations).toBe(1);
  });

  it('retains distinct citation items when the same evidence is cited in different paragraphs or sections', () => {
    const registry = createMockRegistry();
    const sections: SectionRevisionForManifest[] = [
      {
        sectionKey: 'results',
        version: 1,
        markdown: 'Section 1',
        facts: {
          paragraphs: [
            {
              paragraphId: 'para-1',
              usedEvidenceIds: ['E-study-1-quote-1'],
            },
            {
              paragraphId: 'para-2',
              usedEvidenceIds: ['E-study-1-quote-1'],
            },
          ],
        },
      },
      {
        sectionKey: 'discussion',
        version: 1,
        markdown: 'Section 2',
        facts: {
          paragraphs: [
            {
              paragraphId: 'para-1',
              usedEvidenceIds: ['E-study-1-quote-1'],
            },
          ],
        },
      },
    ];

    const manifest = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections,
      registry,
    });

    // 2 in results + 1 in discussion = 3 distinct citation items
    expect(manifest.items).toHaveLength(3);
    expect(manifest.items.map((i) => i.citationId)).toEqual([
      'cit-results-para-1-E-study-1-quote-1',
      'cit-results-para-2-E-study-1-quote-1',
      'cit-discussion-para-1-E-study-1-quote-1',
    ]);
  });

  it('adds missing usedEvidenceIds and usedFindingIds to unresolvedCitations', () => {
    const registry = createMockRegistry();
    const sections: SectionRevisionForManifest[] = [
      {
        sectionKey: 'results',
        version: 1,
        markdown: 'Text',
        facts: {
          paragraphs: [
            {
              paragraphId: 'para-1',
              usedEvidenceIds: ['E-NONEXISTENT-123'],
              usedFindingIds: ['F:unknown:field'],
            },
          ],
        },
      },
    ];

    const manifest = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections,
      registry,
    });

    expect(manifest.items).toHaveLength(0);
    expect(manifest.unresolvedCitations).toHaveLength(2);
    expect(manifest.unresolvedCitations).toEqual([
      {
        marker: 'E-NONEXISTENT-123',
        location: 'results/para-1',
        reason: 'Evidence ID "E-NONEXISTENT-123" is not present in snapshot corpus registry',
      },
      {
        marker: 'F:unknown:field',
        location: 'results/para-1',
        reason: 'Finding ID "F:unknown:field" is not present in snapshot corpus registry',
      },
    ]);
  });

  it('detects unrecognized bracketed markers in prose text and adds them to unresolvedCitations', () => {
    const registry = createMockRegistry({
      studies: [{ externalId: 'demo_known_study', title: 'Known Study', year: 2024 }],
      evidence: [
        {
          externalId: 'E-KNOWN-1',
          studyId: 'demo_known_study',
          quote: 'Known quote.',
          quoteHashVerified: true,
        },
      ],
      findings: [
        {
          externalId: 'F:known:finding',
          studyId: 'demo_known_study',
          fieldName: 'f',
          valueText: 'Known val',
        },
      ],
    });

    const sections: SectionRevisionForManifest[] = [
      {
        sectionKey: 'results',
        version: 1,
        markdown: 'Prose',
        facts: {
          paragraphs: [
            {
              paragraphId: 'para-1',
              text: 'Here we cite [E-UNKNOWN-999], [F:unknown:field], and [demo_fake]. We also have known [E-KNOWN-1], [F:known:finding], and [demo_known_study]. Normal brackets like [1] or [Smith2020] are ignored.',
              usedEvidenceIds: ['E-KNOWN-1'],
              usedFindingIds: ['F:known:finding'],
            },
          ],
        },
      },
    ];

    const manifest = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections,
      registry,
    });

    // Known markers are resolved into items
    expect(manifest.items).toHaveLength(2);

    // Unrecognized prose markers: E-UNKNOWN-999, F:unknown:field, demo_fake
    expect(manifest.unresolvedCitations).toHaveLength(3);
    const markers = manifest.unresolvedCitations.map((u) => u.marker);
    expect(markers).toEqual(['E-UNKNOWN-999', 'F:unknown:field', 'demo_fake']);

    for (const u of manifest.unresolvedCitations) {
      expect(u.location).toBe('results/para-1');
      expect(u.reason).toContain('Unrecognized citation marker');
    }
  });

  it('gracefully handles empty sections or sections without facts/paragraphs', () => {
    const registry = createMockRegistry();

    // 1. Completely empty sections list
    const manifestEmpty = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections: [],
      registry,
    });
    expect(manifestEmpty.items).toEqual([]);
    expect(manifestEmpty.unresolvedCitations).toEqual([]);
    expect(manifestEmpty.totalCitations).toBe(0);
    expect(manifestEmpty.resolvedCitations).toBe(0);

    // 2. Sections with null, undefined, string, or empty facts
    const malformedSections: SectionRevisionForManifest[] = [
      { sectionKey: 'intro', version: 1, markdown: '# Intro', facts: null },
      { sectionKey: 'background', version: 1, markdown: '# Bg', facts: undefined },
      { sectionKey: 'methods', version: 1, markdown: '# Methods', facts: 'string-instead-of-object' },
      { sectionKey: 'results', version: 1, markdown: '# Results', facts: {} },
      { sectionKey: 'discussion', version: 1, markdown: '# Disc', facts: { paragraphs: null } },
      { sectionKey: 'conclusion', version: 1, markdown: '# Conc', facts: { paragraphs: 'not-array' } },
      {
        sectionKey: 'appendix',
        version: 1,
        markdown: '# App',
        facts: {
          paragraphs: [
            // Paragraph with missing fields
            {},
            { paragraphId: null, text: null, usedEvidenceIds: null, usedFindingIds: null },
          ],
        },
      },
    ];

    const manifestMalformed = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections: malformedSections,
      registry,
    });

    expect(manifestMalformed.items).toEqual([]);
    expect(manifestMalformed.unresolvedCitations).toEqual([]);
    expect(manifestMalformed.totalCitations).toBe(0);
    expect(manifestMalformed.resolvedCitations).toBe(0);
  });

  it('falls back to "unknown-para" when paragraphId is missing or non-string', () => {
    const registry = createMockRegistry();
    const sections: SectionRevisionForManifest[] = [
      {
        sectionKey: 'results',
        version: 1,
        markdown: 'text',
        facts: {
          paragraphs: [
            {
              usedEvidenceIds: ['E-study-1-quote-1'],
            },
          ],
        },
      },
    ];

    const manifest = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections,
      registry,
    });

    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0].paragraphId).toBe('unknown-para');
    expect(manifest.items[0].citationId).toBe('cit-results-unknown-para-E-study-1-quote-1');
  });

  it('calculates totalCitations and resolvedCitations accurately', () => {
    const registry = createMockRegistry();
    const sections: SectionRevisionForManifest[] = [
      {
        sectionKey: 'results',
        version: 1,
        markdown: 'text',
        facts: {
          paragraphs: [
            {
              paragraphId: 'para-1',
              text: 'Reference [E-UNKNOWN-GHOST] in prose',
              usedEvidenceIds: ['E-study-1-quote-1', 'E-MISSING-EV'],
              usedFindingIds: ['F:study-1:acc'],
            },
          ],
        },
      },
    ];

    const manifest = buildCitationManifest({
      manuscriptId: 'ms-1',
      snapshotId: 'snap-1',
      sections,
      registry,
    });

    // 2 resolved items (E-study-1-quote-1, F:study-1:acc)
    expect(manifest.items).toHaveLength(2);
    expect(manifest.resolvedCitations).toBe(2);

    // 2 unresolved: E-MISSING-EV + [E-UNKNOWN-GHOST]
    expect(manifest.unresolvedCitations).toHaveLength(2);

    // totalCitations = items.length + unresolvedCitations.length = 4
    expect(manifest.totalCitations).toBe(4);
  });
});

// ============================================================================
// 2. Deterministic Gate Evaluators
// ============================================================================

describe('Deterministic Gate Evaluators', () => {
  // --------------------------------------------------------------------------
  // G1: Citation Integrity & Registry Grounding
  // --------------------------------------------------------------------------
  describe('G1CitationIntegrityEvaluator', () => {
    const evaluator = new G1CitationIntegrityEvaluator();

    it('returns PASS when unresolvedCitations is empty', async () => {
      const context = createMockContext();
      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G1');
      expect(result.status).toBe('PASS');
      expect(result.severity).toBe('BLOCKING');
      expect(result.issuesCount).toBe(0);
      expect(result.message).toContain('All 2 citations successfully resolved');
      expect(result.details).toEqual({
        totalCitations: 2,
        resolvedCitations: 2,
        unresolvedCount: 0,
      });
      expect(issues).toHaveLength(0);
      expect(new Date(result.evaluatedAt).getTime()).not.toBeNaN();
    });

    it('returns FAIL and creates BLOCKING ReviewIssues when unresolved citations exist', async () => {
      const context = createMockContext();
      context.manifest.unresolvedCitations = [
        {
          marker: 'E-UNKNOWN-999',
          location: 'results/para-2',
          reason: 'Evidence ID "E-UNKNOWN-999" is not present in snapshot corpus registry',
        },
        {
          marker: 'demo_bad_marker',
          location: 'discussion', // Location without slash
          reason: 'Unrecognized citation marker "[demo_bad_marker]" found in drafted prose text',
        },
      ];
      context.manifest.totalCitations += 2;

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G1');
      expect(result.status).toBe('FAIL');
      expect(result.severity).toBe('BLOCKING');
      expect(result.issuesCount).toBe(2);
      expect(result.message).toContain('Found 2 unresolved or ungrounded citation references');
      expect(result.details).toEqual({
        totalCitations: 4,
        resolvedCitations: 2,
        unresolvedCount: 2,
      });

      expect(issues).toHaveLength(2);

      // Issue 1: parsed location 'results/para-2'
      expect(issues[0].gateId).toBe('G1');
      expect(issues[0].severity).toBe('BLOCKING');
      expect(issues[0].sectionKey).toBe('results');
      expect(issues[0].target).toBe('para-2');
      expect(issues[0].message).toBe(context.manifest.unresolvedCitations[0].reason);
      expect(issues[0].suggestedRemedy).toContain('[E-UNKNOWN-999]');

      // Issue 2: location without slash fallback 'discussion'
      expect(issues[1].gateId).toBe('G1');
      expect(issues[1].severity).toBe('BLOCKING');
      expect(issues[1].sectionKey).toBe('discussion');
      expect(issues[1].target).toBe('demo_bad_marker');
      expect(issues[1].suggestedRemedy).toContain('[demo_bad_marker]');
    });

    it('falls back to "manuscript" and marker when location is empty', async () => {
      const context = createMockContext();
      context.manifest.unresolvedCitations = [
        {
          marker: 'E-EMPTY-LOC',
          location: '',
          reason: 'Missing evidence',
        },
      ];

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.status).toBe('FAIL');
      expect(issues[0].sectionKey).toBe('manuscript');
      expect(issues[0].target).toBe('E-EMPTY-LOC');
    });
  });

  // --------------------------------------------------------------------------
  // G2: Source Quote Verbatim Fidelity
  // --------------------------------------------------------------------------
  describe('G2QuoteFidelityEvaluator', () => {
    const evaluator = new G2QuoteFidelityEvaluator();

    it('returns NOT_APPLICABLE when no verbatim quotes are present', async () => {
      // Manifest with items having no quotes (e.g. only findings or empty quote string)
      const emptyManifest: CitationManifest = {
        manuscriptId: 'ms-1',
        snapshotId: 'snap-1',
        items: [
          {
            citationId: 'cit-1',
            sectionKey: 'results',
            paragraphId: 'p1',
            findingId: 'F-1',
            studyId: 's-1',
            studyTitle: 'Study 1',
            studyYear: 2024,
            quote: '',
            quoteHashVerified: true,
            isResolved: true,
          },
          {
            citationId: 'cit-2',
            sectionKey: 'results',
            paragraphId: 'p2',
            findingId: 'F-2',
            studyId: 's-1',
            studyTitle: 'Study 1',
            studyYear: 2024,
            quoteHashVerified: true,
            isResolved: true,
          },
        ],
        unresolvedCitations: [],
        totalCitations: 2,
        resolvedCitations: 2,
      };

      const context = createMockContext({ manifest: emptyManifest });
      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G2');
      expect(result.status).toBe('NOT_APPLICABLE');
      expect(result.severity).toBe('WARNING');
      expect(result.issuesCount).toBe(0);
      expect(result.message).toContain('No direct verbatim evidence quotes cited');
      expect(result.details).toEqual({ quotedItemsCount: 0 });
      expect(issues).toHaveLength(0);
    });

    it('returns PASS when all quotes have quoteHashVerified === true', async () => {
      const manifest: CitationManifest = {
        manuscriptId: 'ms-1',
        snapshotId: 'snap-1',
        items: [
          {
            citationId: 'cit-1',
            sectionKey: 'results',
            paragraphId: 'p1',
            evidenceId: 'E-1',
            studyId: 's-1',
            studyTitle: 'Study 1',
            studyYear: 2024,
            quote: 'Direct quote 1 from source',
            quoteHashVerified: true,
            isResolved: true,
          },
          {
            citationId: 'cit-2',
            sectionKey: 'results',
            paragraphId: 'p2',
            evidenceId: 'E-2',
            studyId: 's-2',
            studyTitle: 'Study 2',
            studyYear: 2023,
            quote: 'Direct quote 2 from source',
            quoteHashVerified: true,
            isResolved: true,
          },
        ],
        unresolvedCitations: [],
        totalCitations: 2,
        resolvedCitations: 2,
      };

      const context = createMockContext({ manifest });
      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G2');
      expect(result.status).toBe('PASS');
      expect(result.severity).toBe('WARNING');
      expect(result.issuesCount).toBe(0);
      expect(result.message).toContain('All 2 direct quotes verified against source text hashes');
      expect(result.details).toEqual({
        quotedItemsCount: 2,
        verifiedCount: 2,
      });
      expect(issues).toHaveLength(0);
    });

    it('returns WARNING when any quote has quoteHashVerified === false', async () => {
      const manifest: CitationManifest = {
        manuscriptId: 'ms-1',
        snapshotId: 'snap-1',
        items: [
          {
            citationId: 'cit-1',
            sectionKey: 'results',
            paragraphId: 'p1',
            evidenceId: 'E-1',
            studyId: 's-1',
            studyTitle: 'Study 1',
            studyYear: 2024,
            quote: 'Verified quote',
            quoteHashVerified: true,
            isResolved: true,
          },
          {
            citationId: 'cit-2',
            sectionKey: 'discussion',
            paragraphId: 'p2',
            evidenceId: 'E-unverified',
            studyId: 's-2',
            studyTitle: 'Study 2',
            studyYear: 2023,
            quote: 'Unverified altered quote text',
            quoteHashVerified: false,
            isResolved: true,
          },
        ],
        unresolvedCitations: [],
        totalCitations: 2,
        resolvedCitations: 2,
      };

      const context = createMockContext({ manifest });
      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G2');
      expect(result.status).toBe('WARNING');
      expect(result.severity).toBe('WARNING');
      expect(result.issuesCount).toBe(1);
      expect(result.message).toContain('Found 1 quotes that could not be cryptographically verified');
      expect(result.details).toEqual({
        quotedItemsCount: 2,
        verifiedCount: 1,
      });

      expect(issues).toHaveLength(1);
      expect(issues[0].gateId).toBe('G2');
      expect(issues[0].severity).toBe('WARNING');
      expect(issues[0].sectionKey).toBe('discussion');
      expect(issues[0].target).toBe('cit-2');
      expect(issues[0].evidenceExcerpt).toBe('Unverified altered quote text');
      expect(issues[0].message).toContain('E-unverified');
      expect(issues[0].suggestedRemedy).toContain('Re-verify source document hash');
    });
  });

  // --------------------------------------------------------------------------
  // G3: PRISMA & Quantitative Flow Reconciliation
  // --------------------------------------------------------------------------
  describe('G3PrismaReconciliationEvaluator', () => {
    const evaluator = new G3PrismaReconciliationEvaluator();

    it('returns PASS when studiesIncluded === corpus.studies.length', async () => {
      const context = createMockContext();
      // registry has 3 studies by default in createMockRegistry
      context.registry.studies = [
        { externalId: 's1', title: 'Study 1', year: 2023 },
        { externalId: 's2', title: 'Study 2', year: 2024 },
      ];
      context.supplements = {
        prismaWritingExport: {
          flow: { studiesIncluded: 2 },
          includedStudies: [{ id: 's1' }, { id: 's2' }],
        },
      };

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G3');
      expect(result.status).toBe('PASS');
      expect(result.severity).toBe('BLOCKING');
      expect(result.issuesCount).toBe(0);
      expect(result.message).toContain('PRISMA flow count (2 studies) reconciles with corpus');
      expect(result.details).toEqual({
        prismaCount: 2,
        corpusCount: 2,
      });
      expect(issues).toHaveLength(0);
    });

    it('returns PASS using includedStudies.length when flow.studiesIncluded is null/undefined', async () => {
      const context = createMockContext();
      context.registry.studies = [
        { externalId: 's1', title: 'Study 1', year: 2023 },
        { externalId: 's2', title: 'Study 2', year: 2024 },
      ];
      context.supplements = {
        prismaWritingExport: {
          flow: { studiesIncluded: null },
          includedStudies: [{ id: 's1' }, { id: 's2' }],
        },
      };

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.status).toBe('PASS');
      expect(result.issuesCount).toBe(0);
      expect(issues).toHaveLength(0);
    });

    it('returns FAIL with BLOCKING ReviewIssue when count mismatches', async () => {
      const context = createMockContext();
      context.registry.studies = [
        { externalId: 's1', title: 'Study 1', year: 2023 },
        { externalId: 's2', title: 'Study 2', year: 2024 },
      ];
      // Flow says 5 studies included, but corpus registry has only 2
      context.supplements = {
        prismaWritingExport: {
          flow: { studiesIncluded: 5 },
          includedStudies: [{ id: 's1' }, { id: 's2' }],
        },
      };

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G3');
      expect(result.status).toBe('FAIL');
      expect(result.severity).toBe('BLOCKING');
      expect(result.issuesCount).toBe(1);
      expect(result.message).toContain('PRISMA flow count mismatch: flow says 5, corpus has 2');
      expect(result.details).toEqual({
        prismaCount: 5,
        corpusCount: 2,
      });

      expect(issues).toHaveLength(1);
      expect(issues[0].gateId).toBe('G3');
      expect(issues[0].severity).toBe('BLOCKING');
      expect(issues[0].sectionKey).toBe('methods');
      expect(issues[0].target).toBe('prisma-flow');
      expect(issues[0].message).toContain('PRISMA flow specifies 5 included studies, but corpus contains 2 studies');
      expect(issues[0].suggestedRemedy).toContain('Reconcile screening flow counts');
    });

    it('returns WARNING when PRISMA writing export supplement is missing', async () => {
      const context = createMockContext();
      context.supplements = undefined; // No supplements provided

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G3');
      expect(result.status).toBe('WARNING');
      expect(result.severity).toBe('WARNING');
      expect(result.issuesCount).toBe(1);
      expect(result.message).toContain('PRISMA flow counts cannot be reconciled because PRISMA export is missing');
      expect(result.details).toEqual({
        corpusStudyCount: context.registry.studies.length,
      });

      expect(issues).toHaveLength(1);
      expect(issues[0].gateId).toBe('G3');
      expect(issues[0].severity).toBe('WARNING');
      expect(issues[0].sectionKey).toBe('methods');
      expect(issues[0].target).toBe('prisma-flow');
      expect(issues[0].message).toContain('PRISMA writing export was not supplied in snapshot supplements');
    });
  });

  // --------------------------------------------------------------------------
  // G4: Ungrounded Numerical Claims Audit
  // --------------------------------------------------------------------------
  describe('G4UngroundedNumbersEvaluator', () => {
    const evaluator = new G4UngroundedNumbersEvaluator();

    it('returns PASS when all numbers in prose are grounded in facts, study years, findings, or benign list', async () => {
      const registry = createMockRegistry({
        studies: [
          { externalId: 's1', title: 'Study 1', year: 2023 },
          { externalId: 's2', title: 'Study 2', year: 2024 },
        ],
        findings: [
          {
            externalId: 'f1',
            studyId: 's1',
            fieldName: 'accuracy',
            valueText: 'Yielded 85% accuracy and 92.4 score',
          },
        ],
      });

      const sections: SectionRevisionForManifest[] = [
        {
          sectionKey: 'results',
          version: 1,
          // 2023 (study year), 2024 (study year), 85% (finding), 92.4 (finding), 2 (corpus study count), 1-10 (benign)
          markdown:
            'In 2023 and 2024, 2 primary studies were evaluated. Item 1 demonstrated 85% accuracy with 92.4 score. A total of 5 experiments were logged.',
          facts: {
            customStat: '500',
          },
        },
        {
          sectionKey: 'discussion',
          version: 1,
          markdown: 'Our section fact recorded 500 samples across 3 phases.',
          facts: {
            samples: 500,
          },
        },
      ];

      const context = createMockContext({
        registry,
        sections,
        supplements: {
          prismaWritingExport: {
            flow: { studiesIncluded: 2 },
          },
        },
      });

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G4');
      expect(result.status).toBe('PASS');
      expect(result.severity).toBe('BLOCKING');
      expect(result.issuesCount).toBe(0);
      expect(result.message).toContain('All numerical figures in drafted prose are grounded in snapshot facts');
      expect(result.details?.ungroundedCount).toBe(0);
      expect(issues).toHaveLength(0);
    });

    it('returns FAIL with BLOCKING ReviewIssue when ungrounded numbers (e.g. 99.9%, 7890) appear in prose', async () => {
      const registry = createMockRegistry({
        studies: [{ externalId: 's1', title: 'S1', year: 2023 }],
        findings: [],
      });

      const sections: SectionRevisionForManifest[] = [
        {
          sectionKey: 'results',
          version: 1,
          markdown:
            'The novel framework achieved 99.9% precision over 7890 benchmarks in 2023.',
          facts: {},
        },
      ];

      const context = createMockContext({
        registry,
        sections,
      });

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G4');
      expect(result.status).toBe('FAIL');
      expect(result.severity).toBe('BLOCKING');
      // 2023 is grounded by study year. 99.9% and 7890 are ungrounded!
      expect(result.issuesCount).toBe(2);
      expect(result.message).toContain('Detected 2 ungrounded numerical figures');
      expect(result.details?.ungroundedCount).toBe(2);

      expect(issues).toHaveLength(2);
      expect(issues.map((i) => i.target)).toEqual(['99.9', '7890']);
      for (const issue of issues) {
        expect(issue.gateId).toBe('G4');
        expect(issue.severity).toBe('BLOCKING');
        expect(issue.sectionKey).toBe('results');
        expect(issue.message).toContain('is ungrounded in corpus facts or evidence');
        expect(issue.suggestedRemedy).toContain('Ground this number in a verified finding');
      }
    });

    it('strips percentage symbol correctly when matching raw number', async () => {
      const registry = createMockRegistry({
        studies: [],
        findings: [
          {
            externalId: 'f1',
            studyId: 's1',
            fieldName: 'metric',
            valueText: 'The raw number is 75 without percent symbol.',
          },
        ],
      });

      // Prose writes 75% which strips to 75 and finds match
      const sections: SectionRevisionForManifest[] = [
        {
          sectionKey: 'results',
          version: 1,
          markdown: 'Improvement was 75% overall.',
          facts: {},
        },
      ];

      const context = createMockContext({ registry, sections });
      const { result, issues } = await evaluator.evaluate(context);

      expect(result.status).toBe('PASS');
      expect(issues).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // G7: Research Question (RQ) Coverage Audit
  // --------------------------------------------------------------------------
  describe('G7RqCoverageEvaluator', () => {
    const evaluator = new G7RqCoverageEvaluator();

    it('returns NOT_APPLICABLE when blueprint has no research questions', async () => {
      const context = createMockContext({
        blueprint: {
          researchQuestions: [],
          sections: [],
        },
      });

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G7');
      expect(result.status).toBe('NOT_APPLICABLE');
      expect(result.severity).toBe('BLOCKING');
      expect(result.issuesCount).toBe(0);
      expect(result.message).toContain('No research questions found in blueprint');
      expect(result.details).toEqual({ rqCount: 0 });
      expect(issues).toHaveLength(0);
    });

    it('returns PASS when research questions are covered by code or rqId in sections', async () => {
      const context = createMockContext({
        blueprint: {
          researchQuestions: [
            { rqId: 'rq-1', code: 'RQ-1', question: 'How accurate is LLM coding?' },
            { rqId: 'rq-2', code: null, question: 'What are the main developer challenges?' },
          ],
          sections: [],
        },
        sections: [
          {
            sectionKey: 'results',
            version: 1,
            markdown: '## Section covering RQ-1 and also rq-2 in deep detail.',
            facts: {},
          },
        ],
      });

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G7');
      expect(result.status).toBe('PASS');
      expect(result.severity).toBe('BLOCKING');
      expect(result.issuesCount).toBe(0);
      expect(result.message).toContain('All 2 research questions are addressed in manuscript sections');
      expect(result.details).toEqual({
        totalRQs: 2,
        uncoveredRQs: 0,
      });
      expect(issues).toHaveLength(0);
    });

    it('returns FAIL with BLOCKING ReviewIssue when research questions exist but sections array is empty', async () => {
      const context = createMockContext({
        blueprint: {
          researchQuestions: [
            { rqId: 'rq-1', code: 'RQ-1', question: 'Accuracy of assistants?' },
            { rqId: 'rq-2', code: 'RQ-2', question: 'Productivity impacts?' },
          ],
          sections: [],
        },
        sections: [], // No drafted sections at all!
      });

      const { result, issues } = await evaluator.evaluate(context);

      expect(result.gateId).toBe('G7');
      expect(result.status).toBe('FAIL');
      expect(result.severity).toBe('BLOCKING');
      expect(result.issuesCount).toBe(2);
      expect(result.message).toContain('Uncovered research questions detected (2 missing)');
      expect(result.details).toEqual({
        totalRQs: 2,
        uncoveredRQs: 2,
      });

      expect(issues).toHaveLength(2);
      expect(issues[0].gateId).toBe('G7');
      expect(issues[0].severity).toBe('BLOCKING');
      expect(issues[0].sectionKey).toBe('results');
      expect(issues[0].target).toBe('RQ-1');
      expect(issues[0].message).toContain('Research question "RQ-1" has no drafted content');
      expect(issues[0].suggestedRemedy).toContain('Accuracy of assistants?');

      expect(issues[1].target).toBe('RQ-2');
    });
  });
});

// ============================================================================
// 3. Schemas in verification.types.ts
// ============================================================================

describe('Verification Schemas (Zod)', () => {
  describe('gateStatusSchema', () => {
    it('accepts all valid GateStatus enum values', () => {
      const validStatuses = [
        'PASS',
        'WARNING',
        'FAIL',
        'NEEDS_REVIEW',
        'NOT_APPLICABLE',
        'NOT_RUN',
      ];
      for (const status of validStatuses) {
        expect(gateStatusSchema.parse(status)).toBe(status);
      }
    });

    it('rejects invalid or lowercase values', () => {
      expect(() => gateStatusSchema.parse('pass')).toThrow();
      expect(() => gateStatusSchema.parse('INVALID_STATUS')).toThrow();
      expect(() => gateStatusSchema.parse('')).toThrow();
      expect(() => gateStatusSchema.parse(123)).toThrow();
      expect(() => gateStatusSchema.parse(null)).toThrow();
    });
  });

  describe('gateSeveritySchema & gateIdSchema', () => {
    it('validates gateSeveritySchema', () => {
      expect(gateSeveritySchema.parse('BLOCKING')).toBe('BLOCKING');
      expect(gateSeveritySchema.parse('WARNING')).toBe('WARNING');
      expect(() => gateSeveritySchema.parse('INFO')).toThrow();
      expect(() => gateSeveritySchema.parse('CRITICAL')).toThrow();
    });

    it('validates gateIdSchema', () => {
      const validGateIds = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
      for (const gid of validGateIds) {
        expect(gateIdSchema.parse(gid)).toBe(gid);
      }
      expect(() => gateIdSchema.parse('G0')).toThrow();
      expect(() => gateIdSchema.parse('G8')).toThrow();
      expect(() => gateIdSchema.parse('g1')).toThrow();
    });
  });

  describe('reviewIssueSchema', () => {
    it('parses valid review issue with optional fields omitted', () => {
      const issue = {
        id: 'issue-1',
        gateId: 'G1',
        severity: 'BLOCKING',
        sectionKey: 'results',
        target: 'para-1',
        message: 'Unresolved reference found.',
      };

      const parsed = reviewIssueSchema.parse(issue);
      expect(parsed).toEqual(issue);
      expect(parsed.evidenceExcerpt).toBeUndefined();
      expect(parsed.suggestedRemedy).toBeUndefined();
    });

    it('parses valid review issue with all optional fields provided', () => {
      const issue = {
        id: 'issue-2',
        gateId: 'G2',
        severity: 'WARNING',
        sectionKey: 'methods',
        target: 'cit-1',
        message: 'Quote unverified.',
        evidenceExcerpt: 'Direct quote excerpt',
        suggestedRemedy: 'Re-verify hash.',
      };

      const parsed = reviewIssueSchema.parse(issue);
      expect(parsed).toEqual(issue);
    });

    it('rejects issue with missing required fields or invalid gateId', () => {
      expect(() =>
        reviewIssueSchema.parse({
          id: 'issue-3',
          gateId: 'G99',
          severity: 'BLOCKING',
          sectionKey: 'results',
          target: 'para-1',
          message: 'Error',
        }),
      ).toThrow();

      expect(() =>
        reviewIssueSchema.parse({
          id: 'issue-4',
          gateId: 'G1',
          severity: 'BLOCKING',
          // missing sectionKey, target, message
        }),
      ).toThrow();
    });
  });

  describe('qualityGateResultSchema', () => {
    it('parses valid quality gate result and defaults details to empty object', () => {
      const raw = {
        gateId: 'G1',
        name: 'Citation Integrity',
        status: 'PASS',
        severity: 'BLOCKING',
        message: 'All citations verified',
        issuesCount: 0,
        evaluatedAt: '2026-11-04T00:00:00.000Z',
      };

      const parsed = qualityGateResultSchema.parse(raw);
      expect(parsed.gateId).toBe('G1');
      expect(parsed.details).toEqual({});
      expect(parsed.issuesCount).toBe(0);
    });

    it('parses quality gate result with explicit details', () => {
      const raw = {
        gateId: 'G4',
        name: 'Ungrounded Numbers',
        status: 'FAIL',
        severity: 'BLOCKING',
        message: 'Ungrounded numbers detected',
        issuesCount: 3,
        details: { ungroundedCount: 3, figures: ['99%', '1000'] },
        evaluatedAt: '2026-11-04T00:00:00.000Z',
      };

      const parsed = qualityGateResultSchema.parse(raw);
      expect(parsed.details).toEqual({ ungroundedCount: 3, figures: ['99%', '1000'] });
    });

    it('rejects negative issuesCount or invalid status', () => {
      expect(() =>
        qualityGateResultSchema.parse({
          gateId: 'G1',
          name: 'Gate',
          status: 'INVALID_STATUS',
          severity: 'BLOCKING',
          message: 'msg',
          issuesCount: 0,
          evaluatedAt: '2026-11-04T00:00:00.000Z',
        }),
      ).toThrow();

      expect(() =>
        qualityGateResultSchema.parse({
          gateId: 'G1',
          name: 'Gate',
          status: 'PASS',
          severity: 'BLOCKING',
          message: 'msg',
          issuesCount: -1,
          evaluatedAt: '2026-11-04T00:00:00.000Z',
        }),
      ).toThrow();
    });
  });

  describe('citationItemSchema & unresolvedCitationSchema', () => {
    it('parses valid citationItem with evidence', () => {
      const item = {
        citationId: 'cit-1',
        sectionKey: 'results',
        paragraphId: 'p-1',
        evidenceId: 'E-1',
        studyId: 's-1',
        studyTitle: 'Title 1',
        studyYear: 2024,
        quote: 'Valid quote',
        quoteHashVerified: true,
        isResolved: true,
      };

      expect(citationItemSchema.parse(item)).toEqual(item);
    });

    it('parses valid citationItem with finding and null studyYear', () => {
      const item = {
        citationId: 'cit-2',
        sectionKey: 'results',
        paragraphId: 'p-1',
        findingId: 'F-1',
        studyId: 's-2',
        studyTitle: 'Title 2',
        studyYear: null,
        quoteHashVerified: true,
        isResolved: true,
      };

      expect(citationItemSchema.parse(item)).toEqual(item);
    });

    it('parses valid unresolvedCitation', () => {
      const unresolved = {
        marker: 'E-GHOST',
        location: 'results/p-1',
        reason: 'Not found in registry',
      };

      expect(unresolvedCitationSchema.parse(unresolved)).toEqual(unresolved);
    });
  });

  describe('citationManifestSchema', () => {
    it('parses complete valid CitationManifest', () => {
      const manifest: CitationManifest = {
        manuscriptId: 'ms-1',
        snapshotId: 'snap-1',
        items: [
          {
            citationId: 'cit-1',
            sectionKey: 'results',
            paragraphId: 'p-1',
            evidenceId: 'E-1',
            studyId: 's-1',
            studyTitle: 'Study 1',
            studyYear: 2023,
            quote: 'A quote',
            quoteHashVerified: true,
            isResolved: true,
          },
        ],
        unresolvedCitations: [
          {
            marker: 'E-MISSING',
            location: 'results/p-1',
            reason: 'Missing quote',
          },
        ],
        totalCitations: 2,
        resolvedCitations: 1,
      };

      const parsed = citationManifestSchema.parse(manifest);
      expect(parsed).toEqual(manifest);
    });

    it('rejects negative counts in CitationManifest', () => {
      expect(() =>
        citationManifestSchema.parse({
          manuscriptId: 'ms-1',
          snapshotId: 'snap-1',
          items: [],
          unresolvedCitations: [],
          totalCitations: -1,
          resolvedCitations: 0,
        }),
      ).toThrow();
    });
  });

  describe('verificationReportViewSchema', () => {
    it('parses a full VerificationReportView structure', () => {
      const reportView = {
        id: 'rep-1',
        manuscriptId: 'ms-1',
        version: 1,
        status: 'PASSED_WITH_WARNINGS',
        summary: {
          totalGates: 7,
          passed: 5,
          warnings: 1,
          failed: 0,
          needsReview: 1,
          notApplicable: 0,
          notRun: 0,
          blockingIssues: 0,
          warningIssues: 1,
        },
        manifest: {
          manuscriptId: 'ms-1',
          snapshotId: 'snap-1',
          items: [],
          unresolvedCitations: [],
          totalCitations: 0,
          resolvedCitations: 0,
        },
        gates: {
          G1: {
            gateId: 'G1',
            name: 'Citation Integrity',
            status: 'PASS',
            severity: 'BLOCKING',
            message: 'Pass',
            issuesCount: 0,
            details: {},
            evaluatedAt: '2026-11-04T00:00:00.000Z',
          },
        },
        issues: [
          {
            id: 'iss-1',
            gateId: 'G2',
            severity: 'WARNING',
            sectionKey: 'results',
            target: 'cit-1',
            message: 'Quote unverified',
          },
        ],
        runBy: 'user-alice',
        runAt: '2026-11-04T00:00:00.000Z',
        versions: [
          {
            version: 1,
            status: 'PASSED_WITH_WARNINGS',
            runAt: '2026-11-04T00:00:00.000Z',
            runBy: 'user-alice',
          },
        ],
      };

      const parsed = verificationReportViewSchema.parse(reportView);
      expect(parsed.id).toBe('rep-1');
      expect(parsed.version).toBe(1);
      expect(parsed.status).toBe('PASSED_WITH_WARNINGS');
      expect(parsed.summary.passed).toBe(5);
      expect(parsed.gates.G1?.name).toBe('Citation Integrity');
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.versions).toHaveLength(1);
    });

    it('rejects invalid overall status or non-positive version in report view', () => {
      const baseValid = {
        id: 'rep-1',
        manuscriptId: 'ms-1',
        version: 0, // Invalid: must be positive int
        status: 'PASSED',
        summary: {
          totalGates: 7,
          passed: 7,
          warnings: 0,
          failed: 0,
          needsReview: 0,
          notApplicable: 0,
          notRun: 0,
          blockingIssues: 0,
          warningIssues: 0,
        },
        manifest: {
          manuscriptId: 'ms-1',
          snapshotId: 'snap-1',
          items: [],
          unresolvedCitations: [],
          totalCitations: 0,
          resolvedCitations: 0,
        },
        gates: {},
        issues: [],
        runBy: 'user',
        runAt: '2026-11-04T00:00:00.000Z',
        versions: [],
      };

      // version = 0 rejected
      expect(() => verificationReportViewSchema.parse(baseValid)).toThrow();

      // invalid status rejected
      expect(() =>
        verificationReportViewSchema.parse({
          ...baseValid,
          version: 1,
          status: 'INVALID_OVERALL_STATUS',
        }),
      ).toThrow();
    });
  });
});
