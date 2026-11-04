import { describe, expect, it } from 'vitest';
import { setLlmProvider } from '../../src/modules/llm/llm.service.js';
import { MockLlmProvider } from '../../src/modules/llm/mock.provider.js';
import { G5EvidenceEntailmentEvaluator } from '../../src/modules/verification/gates/g5-evidence-entailment.js';
import { G6ClaimStrengthEvaluator } from '../../src/modules/verification/gates/g6-claim-strength.js';
import type { GateEvaluationContext } from '../../src/modules/verification/gates/gate.interface.js';

describe('LLM-Assisted Quality Gates (G5 & G6)', () => {
  describe('G5: Evidence Entailment & Contradiction Review', () => {
    const evaluator = new G5EvidenceEntailmentEvaluator();

    function createContext(quotes: string[] = ['Copilot achieved high accuracy.']): GateEvaluationContext {
      return {
        manifest: {
          manuscriptId: 'm-1',
          snapshotId: 's-1',
          totalCitations: quotes.length,
          resolvedCitations: quotes.length,
          unresolvedCitations: [],
          items: quotes.map((q, idx) => ({
            citationId: `cit-p${idx}-E-0${idx + 1}`,
            sectionKey: 'results',
            paragraphId: `p-${idx + 1}`,
            evidenceId: `E-0${idx + 1}`,
            studyId: 'study-1',
            studyTitle: 'Study 1',
            studyYear: 2023,
            quote: q,
            quoteHashVerified: true,
            isResolved: true,
          })),
        },
        sections: [
          {
            sectionKey: 'results',
            version: 1,
            markdown: 'Evaluated LLM models demonstrated strong generation capabilities.',
            facts: {},
          },
        ],
        registry: { studies: [], findings: [], evidence: [] },
        blueprint: { researchQuestions: [], sections: [] },
      };
    }

    it('returns NOT_APPLICABLE when no items have evidence quotes', async () => {
      const ctx = createContext([]);
      const { result, issues } = await evaluator.evaluate(ctx);

      expect(result.status).toBe('NOT_APPLICABLE');
      expect(result.issuesCount).toBe(0);
      expect(issues).toHaveLength(0);
    });

    it('returns NEEDS_REVIEW with warning when LLM provider is not configured', async () => {
      setLlmProvider(null);
      const ctx = createContext();
      const { result, issues } = await evaluator.evaluate(ctx);

      expect(result.status).toBe('NEEDS_REVIEW');
      expect(result.severity).toBe('WARNING');
      expect(issues).toHaveLength(0);
    });

    it('returns PASS when LLM concludes ENTAILS relationship', async () => {
      setLlmProvider(
        new MockLlmProvider(() => ({
          relationship: 'ENTAILS',
          confidence: 0.98,
          explanation: 'The premise quote strongly supports the drafted claim.',
        })),
      );

      const ctx = createContext();
      const { result, issues } = await evaluator.evaluate(ctx);

      expect(result.status).toBe('PASS');
      expect(result.issuesCount).toBe(0);
      expect(issues).toHaveLength(0);
    });

    it('returns FAIL with BLOCKING issue when LLM detects CONTRADICTION', async () => {
      setLlmProvider(
        new MockLlmProvider(() => ({
          relationship: 'CONTRADICTS',
          confidence: 0.95,
          explanation: 'Evidence quote directly disproves the asserted statement.',
        })),
      );

      const ctx = createContext();
      const { result, issues } = await evaluator.evaluate(ctx);

      expect(result.status).toBe('FAIL');
      expect(result.severity).toBe('BLOCKING');
      expect(result.issuesCount).toBe(1);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('BLOCKING');
      expect(issues[0].message).toContain('contradicts drafted prose');
    });

    it('returns WARNING when relationship is NEUTRAL (unsupported claim)', async () => {
      setLlmProvider(
        new MockLlmProvider(() => ({
          relationship: 'NEUTRAL',
          confidence: 0.85,
          explanation: 'Evidence mentions accuracy but does not speak to generation speed.',
        })),
      );

      const ctx = createContext();
      const { result, issues } = await evaluator.evaluate(ctx);

      expect(result.status).toBe('WARNING');
      expect(result.severity).toBe('BLOCKING');
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('WARNING');
    });
  });

  describe('G6: Claim Strength & Hedging Alignment', () => {
    const evaluator = new G6ClaimStrengthEvaluator();

    it('returns NOT_APPLICABLE when no paragraph plans are provided', async () => {
      const ctx: GateEvaluationContext = {
        manifest: { manuscriptId: 'm', snapshotId: 's', items: [], unresolvedCitations: [], totalCitations: 0, resolvedCitations: 0 },
        sections: [],
        registry: { studies: [], findings: [], evidence: [] },
        blueprint: { researchQuestions: [], sections: [] },
        paragraphPlans: [],
      };

      const { result, issues } = await evaluator.evaluate(ctx);
      expect(result.status).toBe('NOT_APPLICABLE');
      expect(issues).toHaveLength(0);
    });

    it('returns PASS when qualified paragraph text adheres to scientific hedging', async () => {
      const ctx: GateEvaluationContext = {
        manifest: { manuscriptId: 'm', snapshotId: 's', items: [], unresolvedCitations: [], totalCitations: 0, resolvedCitations: 0 },
        sections: [
          {
            sectionKey: 'results',
            version: 1,
            markdown: 'The results suggest that accuracy improves under certain conditions.',
            facts: {
              paragraphs: [
                {
                  paragraphId: 'p-1',
                  text: 'The results suggest that accuracy improves under evaluated conditions.',
                },
              ],
            },
          },
        ],
        registry: { studies: [], findings: [], evidence: [] },
        blueprint: { researchQuestions: [], sections: [] },
        paragraphPlans: [
          {
            id: 'p-1',
            sectionKey: 'results',
            claimStrength: 'qualified',
          },
        ],
      };

      const { result, issues } = await evaluator.evaluate(ctx);
      expect(result.status).toBe('PASS');
      expect(issues).toHaveLength(0);
    });

    it('returns WARNING when qualified paragraph contains absolutist / unhedged assertion', async () => {
      const ctx: GateEvaluationContext = {
        manifest: { manuscriptId: 'm', snapshotId: 's', items: [], unresolvedCitations: [], totalCitations: 0, resolvedCitations: 0 },
        sections: [
          {
            sectionKey: 'results',
            version: 1,
            markdown: 'Our evaluation proves beyond doubt that Copilot completely eliminates coding bugs.',
            facts: {
              paragraphs: [
                {
                  paragraphId: 'p-1',
                  text: 'Our evaluation proves beyond doubt that Copilot completely eliminates coding bugs.',
                },
              ],
            },
          },
        ],
        registry: { studies: [], findings: [], evidence: [] },
        blueprint: { researchQuestions: [], sections: [] },
        paragraphPlans: [
          {
            id: 'p-1',
            sectionKey: 'results',
            claimStrength: 'qualified',
          },
        ],
      };

      const { result, issues } = await evaluator.evaluate(ctx);
      expect(result.status).toBe('WARNING');
      expect(issues).toHaveLength(1);
      expect(issues[0].target).toBe('p-1');
      expect(issues[0].message).toContain('proves');
      expect(issues[0].suggestedRemedy).toContain('Add scientific hedges');
    });

    it('ignores strong/neutral plans even when assertive wording is used', async () => {
      const ctx: GateEvaluationContext = {
        manifest: { manuscriptId: 'm', snapshotId: 's', items: [], unresolvedCitations: [], totalCitations: 0, resolvedCitations: 0 },
        sections: [
          {
            sectionKey: 'results',
            version: 1,
            markdown: 'This proves beyond doubt that the algorithm functions.',
            facts: {
              paragraphs: [
                {
                  paragraphId: 'p-2',
                  text: 'This proves beyond doubt that the algorithm functions.',
                },
              ],
            },
          },
        ],
        registry: { studies: [], findings: [], evidence: [] },
        blueprint: { researchQuestions: [], sections: [] },
        paragraphPlans: [
          {
            id: 'p-2',
            sectionKey: 'results',
            claimStrength: 'strong',
          },
        ],
      };

      const { result, issues } = await evaluator.evaluate(ctx);
      expect(result.status).toBe('PASS');
      expect(issues).toHaveLength(0);
    });
  });
});
