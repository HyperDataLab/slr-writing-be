import { describe, expect, it } from 'vitest';
import { DATA_MARKER, SAFETY_RULES } from '../../src/modules/llm/prompt.js';
import {
  buildDraftingPrompts,
  buildMinimalEvidencePack,
  PROMPT_TEMPLATE_ID,
  PROMPT_TEMPLATE_VERSION,
  type SnapshotRegistryLookup,
  validateDraftOutput,
} from '../../src/modules/drafting/drafting-pack.js';
import {
  manualDraftEditSchema,
  paragraphDraftOutputSchema,
  type ParagraphDraftOutput,
  type ParagraphEvidencePack,
} from '../../src/modules/drafting/drafting.types.js';
import type { ParagraphPlanItem } from '../../src/modules/paragraph-plans/paragraph-plan.types.js';

describe('Drafting Minimal Evidence Pack & Output Validator (Pure Tests)', () => {
  const samplePlan: ParagraphPlanItem = {
    id: 'P-claim:101-01',
    sectionKey: 'results',
    subsectionId: 'sub-results-ai-code',
    rhetoricalMove: 'report_evidence',
    rqIds: ['rq-1'],
    claimIds: ['claim-101'],
    findingIds: ['f-1', 'f-2'],
    evidenceIds: ['ev-1', 'ev-2'],
    claimStrength: 'qualified',
    conditionsRequired: true,
    citationPolicy: 'registry_only',
    sentenceSlots: ['topic', 'evidence', 'synthesis', 'qualification'],
    limitations: ['Limited to open-source repositories', 'Self-reported evaluation metrics'],
    status: 'READY_TO_DRAFT',
  };

  const createLookup = (): SnapshotRegistryLookup => ({
    claims: new Map([
      ['claim-101', { externalId: 'claim-101', title: 'AI code generation improves perceived developer productivity' }],
      ['claim-999', { externalId: 'claim-999', title: 'Unreferenced claim from another section' }],
    ]),
    findings: new Map([
      [
        'f-1',
        {
          externalId: 'f-1',
          fieldName: 'completion_rate',
          valueText: '55.8% higher task completion rate',
          studyId: 'study-copilot-2022',
          studyTitle: 'Evaluating Large Language Models for Code Generation',
        },
      ],
      [
        'f-2',
        {
          externalId: 'f-2',
          fieldName: 'time_reduction',
          valueText: '22% reduction in overall implementation time',
          studyId: 'study-dev-2023',
          studyTitle: 'Empirical Assessment of LLM-Assisted Programming',
        },
      ],
      [
        'f-3',
        {
          externalId: 'f-3',
          fieldName: 'irrelevant_metric',
          valueText: 'Should never be included',
          studyId: 'study-unrelated',
          studyTitle: 'Unrelated Study',
        },
      ],
    ]),
    evidence: new Map([
      [
        'ev-1',
        {
          externalId: 'ev-1',
          quote: 'Participants completed the task 55.8% faster when using GitHub Copilot.',
          studyId: 'study-copilot-2022',
        },
      ],
      [
        'ev-2',
        {
          externalId: 'ev-2',
          quote: 'We observed a statistically significant 22% reduction in time spent writing boilerplate.',
          studyId: 'study-dev-2023',
        },
      ],
      [
        'ev-3',
        {
          externalId: 'ev-3',
          quote: 'Unrelated verbatim evidence quote.',
          studyId: 'study-unrelated',
        },
      ],
    ]),
  });

  describe('Prompt template constants', () => {
    it('defines the expected template ID and integer version', () => {
      expect(PROMPT_TEMPLATE_ID).toBe('results-paragraph-draft');
      expect(PROMPT_TEMPLATE_VERSION).toBe(1);
    });
  });

  describe('buildMinimalEvidencePack', () => {
    it('extracts only findings, evidence, and claims specified in the plan', () => {
      const lookup = createLookup();
      const pack = buildMinimalEvidencePack(samplePlan, lookup);

      // Verify claims
      expect(pack.claims).toHaveLength(1);
      expect(pack.claims[0]).toEqual({
        id: 'claim-101',
        title: 'AI code generation improves perceived developer productivity',
      });
      expect(pack.claims.some((c) => c.id === 'claim-999')).toBe(false);

      // Verify findings
      expect(pack.findings).toHaveLength(2);
      expect(pack.findings.map((f) => f.id)).toEqual(['f-1', 'f-2']);
      expect(pack.findings.some((f) => f.id === 'f-3')).toBe(false);

      // Verify evidence
      expect(pack.evidence).toHaveLength(2);
      expect(pack.evidence.map((e) => e.id)).toEqual(['ev-1', 'ev-2']);
      expect(pack.evidence.some((e) => e.id === 'ev-3')).toBe(false);
    });

    it('correctly maps study titles, field names, and quotes', () => {
      const lookup = createLookup();
      const pack = buildMinimalEvidencePack(samplePlan, lookup);

      const f1 = pack.findings.find((f) => f.id === 'f-1')!;
      expect(f1).toBeDefined();
      expect(f1.fieldName).toBe('completion_rate');
      expect(f1.valueText).toBe('55.8% higher task completion rate');
      expect(f1.studyId).toBe('study-copilot-2022');
      expect(f1.studyTitle).toBe('Evaluating Large Language Models for Code Generation');

      const ev1 = pack.evidence.find((e) => e.id === 'ev-1')!;
      expect(ev1).toBeDefined();
      expect(ev1.quote).toBe('Participants completed the task 55.8% faster when using GitHub Copilot.');
      expect(ev1.studyId).toBe('study-copilot-2022');
    });

    it('copies all structural paragraph plan metadata into the pack', () => {
      const lookup = createLookup();
      const pack = buildMinimalEvidencePack(samplePlan, lookup);

      expect(pack.paragraphId).toBe(samplePlan.id);
      expect(pack.sectionKey).toBe(samplePlan.sectionKey);
      expect(pack.subsectionId).toBe(samplePlan.subsectionId);
      expect(pack.rhetoricalMove).toBe(samplePlan.rhetoricalMove);
      expect(pack.claimStrength).toBe(samplePlan.claimStrength);
      expect(pack.conditionsRequired).toBe(samplePlan.conditionsRequired);
      expect(pack.sentenceSlots).toEqual(samplePlan.sentenceSlots);
      expect(pack.limitations).toEqual(samplePlan.limitations);
    });

    it('handles empty evidence, findings, and claims gracefully', () => {
      const emptyPlan: ParagraphPlanItem = {
        ...samplePlan,
        claimIds: [],
        findingIds: [],
        evidenceIds: [],
      };
      const lookup = createLookup();
      const pack = buildMinimalEvidencePack(emptyPlan, lookup);

      expect(pack.claims).toEqual([]);
      expect(pack.findings).toEqual([]);
      expect(pack.evidence).toEqual([]);
    });

    it('silently ignores plan IDs that are missing from the registry lookup', () => {
      const planWithMissing: ParagraphPlanItem = {
        ...samplePlan,
        claimIds: ['claim-nonexistent'],
        findingIds: ['f-nonexistent', 'f-1'],
        evidenceIds: ['ev-nonexistent', 'ev-2'],
      };
      const lookup = createLookup();
      const pack = buildMinimalEvidencePack(planWithMissing, lookup);

      expect(pack.claims).toEqual([]);
      expect(pack.findings).toHaveLength(1);
      expect(pack.findings[0].id).toBe('f-1');
      expect(pack.evidence).toHaveLength(1);
      expect(pack.evidence[0].id).toBe('ev-2');
    });
  });

  describe('buildDraftingPrompts', () => {
    it('includes SAFETY_RULES and rhetorical move in the system prompt', () => {
      const lookup = createLookup();
      const pack = buildMinimalEvidencePack(samplePlan, lookup);
      const { system } = buildDraftingPrompts(pack);

      expect(system).toContain(SAFETY_RULES);
      expect(system).toContain(`Adhere to the requested rhetorical move (${pack.rhetoricalMove})`);
      expect(system).toContain(`sentence structure (${pack.sentenceSlots.join(' -> ')})`);
      expect(system).toContain('usedEvidenceIds and usedFindingIds');
    });

    it.each([
      ['qualified' as const, 'Preserve hedges, conditions, and uncertainty; do not make definitive assertions.'],
      ['strong' as const, 'Present the consensus with appropriate scientific confidence supported by the evidence.'],
      ['neutral' as const, 'Report findings with objective neutrality.'],
    ])('tailors instructions for claimStrength = "%s"', (strength, expectedDirective) => {
      const lookup = createLookup();
      const pack = buildMinimalEvidencePack({ ...samplePlan, claimStrength: strength }, lookup);
      const { system } = buildDraftingPrompts(pack);

      expect(system).toContain(`Claim strength rule: "${strength}".`);
      expect(system).toContain(expectedDirective);
    });

    it('constructs prompt containing DATA_MARKER and valid matching JSON data', () => {
      const lookup = createLookup();
      const pack = buildMinimalEvidencePack(samplePlan, lookup);
      const { prompt } = buildDraftingPrompts(pack);

      expect(prompt).toContain(DATA_MARKER);
      expect(prompt).toContain(`Draft academic paragraph ${pack.paragraphId} for section "${pack.sectionKey}"`);

      // Extract and verify the isolated JSON data block
      const parts = prompt.split(`${DATA_MARKER}\n`);
      expect(parts.length).toBe(2);

      const parsedData = JSON.parse(parts[1]);
      expect(parsedData.paragraphId).toBe(pack.paragraphId);
      expect(parsedData.sectionKey).toBe(pack.sectionKey);
      expect(parsedData.subsectionId).toBe(pack.subsectionId);
      expect(parsedData.rhetoricalMove).toBe(pack.rhetoricalMove);
      expect(parsedData.claimStrength).toBe(pack.claimStrength);
      expect(parsedData.claims).toEqual(pack.claims);
      expect(parsedData.findings).toEqual(pack.findings);
      expect(parsedData.evidence).toEqual(pack.evidence);
      expect(parsedData.limitations).toEqual(pack.limitations);
    });
  });

  describe('validateDraftOutput', () => {
    const lookup = createLookup();
    const pack = buildMinimalEvidencePack(samplePlan, lookup);

    const validOutput: ParagraphDraftOutput = {
      paragraphId: pack.paragraphId,
      text: 'Recent empirical investigations indicate that generative code completion yields measurable efficiency gains across diverse developer cohorts.',
      usedEvidenceIds: ['ev-1', 'ev-2'],
      usedFindingIds: ['f-1', 'f-2'],
      limitationsNoted: ['Evaluated only in IDE-based environments'],
    };

    it('accepts valid output where IDs are a subset of the evidence pack', () => {
      const res = validateDraftOutput(validOutput, pack);

      expect(res.valid).toBe(true);
      expect(res.errorReason).toBeUndefined();
      expect(res.sanitized).toEqual({
        paragraphId: pack.paragraphId,
        text: validOutput.text,
        usedEvidenceIds: ['ev-1', 'ev-2'],
        usedFindingIds: ['f-1', 'f-2'],
        limitationsNoted: ['Evaluated only in IDE-based environments'],
      });
    });

    it('accepts valid output with a strict subset of evidence and finding IDs', () => {
      const partialOutput: ParagraphDraftOutput = {
        ...validOutput,
        usedEvidenceIds: ['ev-1'],
        usedFindingIds: ['f-2'],
      };
      const res = validateDraftOutput(partialOutput, pack);

      expect(res.valid).toBe(true);
      expect(res.sanitized.usedEvidenceIds).toEqual(['ev-1']);
      expect(res.sanitized.usedFindingIds).toEqual(['f-2']);
    });

    it('accepts valid output with empty usedEvidenceIds and usedFindingIds', () => {
      const emptyCitationOutput: ParagraphDraftOutput = {
        ...validOutput,
        usedEvidenceIds: [],
        usedFindingIds: [],
      };
      const res = validateDraftOutput(emptyCitationOutput, pack);

      expect(res.valid).toBe(true);
      expect(res.sanitized.usedEvidenceIds).toEqual([]);
      expect(res.sanitized.usedFindingIds).toEqual([]);
    });

    it('defaults limitationsNoted to empty array if omitted in output', () => {
      const outputWithoutLimitations: ParagraphDraftOutput = {
        paragraphId: pack.paragraphId,
        text: 'Paragraph text discussing evidence without explicit methodological caveats.',
        usedEvidenceIds: ['ev-1'],
        usedFindingIds: ['f-1'],
      };
      const res = validateDraftOutput(outputWithoutLimitations, pack);

      expect(res.valid).toBe(true);
      expect(res.sanitized.limitationsNoted).toEqual([]);
    });

    it('detects foreign evidence ID, returns valid: false, errorReason, and filters sanitized', () => {
      const outputWithForeignEvidence: ParagraphDraftOutput = {
        ...validOutput,
        usedEvidenceIds: ['ev-1', 'ev-hallucinated-999'],
      };
      const res = validateDraftOutput(outputWithForeignEvidence, pack);

      expect(res.valid).toBe(false);
      expect(res.errorReason).toContain('ev-hallucinated-999');
      expect(res.sanitized.usedEvidenceIds).toEqual(['ev-1']);
      expect(res.sanitized.usedEvidenceIds).not.toContain('ev-hallucinated-999');
    });

    it('detects foreign finding ID, returns valid: false, errorReason, and filters sanitized', () => {
      const outputWithForeignFinding: ParagraphDraftOutput = {
        ...validOutput,
        usedFindingIds: ['f-1', 'f-phantom-data'],
      };
      const res = validateDraftOutput(outputWithForeignFinding, pack);

      expect(res.valid).toBe(false);
      expect(res.errorReason).toContain('f-phantom-data');
      expect(res.sanitized.usedFindingIds).toEqual(['f-1']);
      expect(res.sanitized.usedFindingIds).not.toContain('f-phantom-data');
    });

    it('reports all foreign IDs when both evidence and findings contain hallucinations', () => {
      const multipleHallucinations: ParagraphDraftOutput = {
        ...validOutput,
        usedEvidenceIds: ['ev-1', 'ev-fake-1', 'ev-fake-2'],
        usedFindingIds: ['f-fake-1'],
      };
      const res = validateDraftOutput(multipleHallucinations, pack);

      expect(res.valid).toBe(false);
      expect(res.errorReason).toContain('ev-fake-1');
      expect(res.errorReason).toContain('ev-fake-2');
      expect(res.errorReason).toContain('f-fake-1');
      expect(res.sanitized.usedEvidenceIds).toEqual(['ev-1']);
      expect(res.sanitized.usedFindingIds).toEqual([]);
    });

    it('deduplicates duplicate IDs in usedEvidenceIds and usedFindingIds when valid', () => {
      const duplicateOutput: ParagraphDraftOutput = {
        ...validOutput,
        usedEvidenceIds: ['ev-1', 'ev-2', 'ev-1', 'ev-2', 'ev-1'],
        usedFindingIds: ['f-1', 'f-1', 'f-2', 'f-1'],
      };
      const res = validateDraftOutput(duplicateOutput, pack);

      expect(res.valid).toBe(true);
      expect(res.sanitized.usedEvidenceIds).toEqual(['ev-1', 'ev-2']);
      expect(res.sanitized.usedFindingIds).toEqual(['f-1', 'f-2']);
    });
  });

  describe('Zod Schemas', () => {
    describe('paragraphDraftOutputSchema', () => {
      const validDraft: ParagraphDraftOutput = {
        paragraphId: 'P-claim:101-01',
        text: 'This is a valid drafted paragraph with rigorous academic framing and grounding.',
        usedEvidenceIds: ['ev-1', 'ev-2'],
        usedFindingIds: ['f-1'],
        limitationsNoted: ['Small sample size'],
      };

      it('accepts valid drafted output with all fields', () => {
        const parsed = paragraphDraftOutputSchema.safeParse(validDraft);
        expect(parsed.success).toBe(true);
      });

      it('accepts valid drafted output when optional limitationsNoted is omitted', () => {
        const { limitationsNoted: _, ...withoutLimitations } = validDraft;
        const parsed = paragraphDraftOutputSchema.safeParse(withoutLimitations);
        expect(parsed.success).toBe(true);
      });

      it('refuses extra unrecognized keys due to strict mode', () => {
        const withExtra = {
          ...validDraft,
          unexpectedField: 'hallucinated extra attribute from LLM',
        };
        const parsed = paragraphDraftOutputSchema.safeParse(withExtra);
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          expect(parsed.error.issues[0].code).toBe('unrecognized_keys');
        }
      });

      it('refuses text < 10 characters', () => {
        const tooShort = {
          ...validDraft,
          text: 'Too short', // 9 characters
        };
        const parsed = paragraphDraftOutputSchema.safeParse(tooShort);
        expect(parsed.success).toBe(false);

        const border10 = {
          ...validDraft,
          text: '0123456789', // exactly 10 characters
        };
        expect(paragraphDraftOutputSchema.safeParse(border10).success).toBe(true);
      });

      it('refuses empty or whitespace-only text (showsNothing)', () => {
        expect(paragraphDraftOutputSchema.safeParse({ ...validDraft, text: '' }).success).toBe(false);
        expect(paragraphDraftOutputSchema.safeParse({ ...validDraft, text: '           ' }).success).toBe(false);
        // Zero-width spaces
        const zeroWidthOnly = '\u200B\u200B\u200B\u200B\u200B\u200B\u200B\u200B\u200B\u200B';
        expect(paragraphDraftOutputSchema.safeParse({ ...validDraft, text: zeroWidthOnly }).success).toBe(false);
      });

      it('refuses unstorable characters (NUL byte)', () => {
        const withNulInText = {
          ...validDraft,
          text: 'Academic prose containing a forbidden \u0000 NUL character.',
        };
        const parsedText = paragraphDraftOutputSchema.safeParse(withNulInText);
        expect(parsedText.success).toBe(false);
        if (!parsedText.success) {
          expect(parsedText.error.issues.some((i) => i.message.includes('cannot be stored'))).toBe(true);
        }

        const withNulInId = {
          ...validDraft,
          paragraphId: 'P-claim:\u0000-01',
        };
        expect(paragraphDraftOutputSchema.safeParse(withNulInId).success).toBe(false);

        const withNulInEvidence = {
          ...validDraft,
          usedEvidenceIds: ['ev-\u0000'],
        };
        expect(paragraphDraftOutputSchema.safeParse(withNulInEvidence).success).toBe(false);
      });

      it('refuses arrays exceeding capacity limits', () => {
        const excessiveEvidence = {
          ...validDraft,
          usedEvidenceIds: Array.from({ length: 101 }, (_, i) => `ev-${i}`),
        };
        expect(paragraphDraftOutputSchema.safeParse(excessiveEvidence).success).toBe(false);

        const excessiveFindings = {
          ...validDraft,
          usedFindingIds: Array.from({ length: 101 }, (_, i) => `f-${i}`),
        };
        expect(paragraphDraftOutputSchema.safeParse(excessiveFindings).success).toBe(false);

        const excessiveLimitations = {
          ...validDraft,
          limitationsNoted: Array.from({ length: 21 }, (_, i) => `limitation ${i}`),
        };
        expect(paragraphDraftOutputSchema.safeParse(excessiveLimitations).success).toBe(false);
      });
    });

    describe('manualDraftEditSchema', () => {
      it('accepts valid { baseVersion: 1, markdown: "..." }', () => {
        const validEdit = {
          baseVersion: 1,
          markdown: '### Results\n\nManual revision of the drafted section markdown.',
        };
        const parsed = manualDraftEditSchema.safeParse(validEdit);
        expect(parsed.success).toBe(true);
      });

      it('refuses non-integer baseVersion', () => {
        const nonInt = {
          baseVersion: 1.5,
          markdown: 'Valid markdown content.',
        };
        const parsed = manualDraftEditSchema.safeParse(nonInt);
        expect(parsed.success).toBe(false);
      });

      it('refuses baseVersion <= 0', () => {
        expect(manualDraftEditSchema.safeParse({ baseVersion: 0, markdown: 'Valid markdown' }).success).toBe(false);
        expect(manualDraftEditSchema.safeParse({ baseVersion: -1, markdown: 'Valid markdown' }).success).toBe(false);
      });

      it('refuses baseVersion exceeding 1,000,000', () => {
        expect(manualDraftEditSchema.safeParse({ baseVersion: 1_000_001, markdown: 'Valid markdown' }).success).toBe(false);
      });

      it('refuses extra unrecognized keys due to strict mode', () => {
        const withExtra = {
          baseVersion: 1,
          markdown: 'Valid markdown',
          extraProperty: 'not permitted',
        };
        const parsed = manualDraftEditSchema.safeParse(withExtra);
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          expect(parsed.error.issues[0].code).toBe('unrecognized_keys');
        }
      });

      it('refuses empty or whitespace-only markdown', () => {
        expect(manualDraftEditSchema.safeParse({ baseVersion: 1, markdown: '' }).success).toBe(false);
        expect(manualDraftEditSchema.safeParse({ baseVersion: 1, markdown: '   \n  \t ' }).success).toBe(false);
      });

      it('refuses unstorable characters (NUL byte) in markdown', () => {
        const withNul = {
          baseVersion: 1,
          markdown: 'Markdown containing \u0000 byte.',
        };
        const parsed = manualDraftEditSchema.safeParse(withNul);
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          expect(parsed.error.issues.some((i) => i.message.includes('cannot be stored'))).toBe(true);
        }
      });
    });
  });
});
