import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GateEvaluator, GateEvaluationContext } from './gate.interface.js';
import type { QualityGateResult, ReviewIssue } from '../verification.types.js';
import { getLlmProvider } from '../../llm/llm.service.js';
import { buildPrompt } from '../../llm/prompt.js';

export const nliOutputSchema = z
  .object({
    relationship: z.enum(['ENTAILS', 'CONTRADICTS', 'NEUTRAL']),
    confidence: z.number().finite().min(0).max(1),
    explanation: z.string().min(1),
  })
  .strict();

export class G5EvidenceEntailmentEvaluator implements GateEvaluator {
  readonly gateId = 'G5';
  readonly name = 'Evidence Entailment & Contradiction Review';

  async evaluate(context: GateEvaluationContext): Promise<{ result: QualityGateResult; issues: ReviewIssue[] }> {
    const { manifest } = context;
    const itemsWithQuotes = manifest.items.filter((item) => typeof item.quote === 'string' && item.quote.length > 0);

    if (itemsWithQuotes.length === 0) {
      return {
        result: {
          gateId: 'G5',
          name: this.name,
          status: 'NOT_APPLICABLE',
          severity: 'BLOCKING',
          message: 'No evidence quotes available to evaluate entailment.',
          issuesCount: 0,
          details: { evaluatedPairs: 0 },
          evaluatedAt: new Date().toISOString(),
        },
        issues: [],
      };
    }

    let provider;
    try {
      provider = getLlmProvider();
    } catch {
      // If LLM is not configured, we do not fabricate PASS; return NEEDS_REVIEW / WARNING
      return {
        result: {
          gateId: 'G5',
          name: this.name,
          status: 'NEEDS_REVIEW',
          severity: 'WARNING',
          message: 'LLM provider not configured; entailment requires automated or human review.',
          issuesCount: 0,
          details: { evaluatedPairs: 0, reason: 'LLM_NOT_CONFIGURED' },
          evaluatedAt: new Date().toISOString(),
        },
        issues: [],
      };
    }

    const issues: ReviewIssue[] = [];

    // Evaluate up to first 5 quote-text pairs to remain bounded
    const sample = itemsWithQuotes.slice(0, 5);
    for (const item of sample) {
      try {
        const sec = context.sections.find((s) => s.sectionKey === item.sectionKey);
        const text = sec?.markdown ?? '';

        const system =
          'You are a strict Natural Language Inference (NLI) auditor for scientific literature reviews.\n' +
          'Evaluate whether the provided Premise (source evidence quote) ENTAILS, CONTRADICTS, or is NEUTRAL to the Hypothesis (drafted text claim).\n' +
          'Output strict JSON.';

        const prompt = buildPrompt({
          task: 'Analyze the entailment relationship between the evidence and the drafted claim.',
          data: {
            premiseQuote: item.quote,
            hypothesisClaim: text.slice(0, 500),
          },
        });

        const res = await provider.generateStructured({
          promptTemplateId: 'nli-entailment-audit',
          promptTemplateVersion: 1,
          system,
          prompt,
          schema: nliOutputSchema,
        });

        if (res.output.relationship === 'CONTRADICTS') {
          issues.push({
            id: randomUUID(),
            gateId: 'G5',
            severity: 'BLOCKING',
            sectionKey: item.sectionKey,
            target: item.citationId,
            evidenceExcerpt: item.quote,
            message: `Evidence contradicts drafted prose: ${res.output.explanation}`,
            suggestedRemedy: 'Revise the drafted paragraph to match findings or remove contradicting claim.',
          });
        } else if (res.output.relationship === 'NEUTRAL') {
          issues.push({
            id: randomUUID(),
            gateId: 'G5',
            severity: 'WARNING',
            sectionKey: item.sectionKey,
            target: item.citationId,
            evidenceExcerpt: item.quote,
            message: `Evidence does not strictly entail claim (neutral): ${res.output.explanation}`,
            suggestedRemedy: 'Review citation to ensure it directly supports the sentence assertion.',
          });
        }
      } catch (err: any) {
        // Log or treat error without crashing gate
        issues.push({
          id: randomUUID(),
          gateId: 'G5',
          severity: 'WARNING',
          sectionKey: item.sectionKey,
          target: item.citationId,
          message: `NLI evaluation encountered transient issue: ${err.message}`,
        });
      }
    }

    const hasBlocking = issues.some((i) => i.severity === 'BLOCKING');
    const isPass = issues.length === 0;

    const result: QualityGateResult = {
      gateId: 'G5',
      name: this.name,
      status: isPass ? 'PASS' : hasBlocking ? 'FAIL' : 'WARNING',
      severity: 'BLOCKING',
      message: isPass
        ? `Evaluated ${sample.length} citation pairs: evidence entails drafted assertions.`
        : `Found ${issues.length} potential entailment or contradiction issues.`,
      issuesCount: issues.length,
      details: {
        evaluatedCount: sample.length,
        issueCount: issues.length,
      },
      evaluatedAt: new Date().toISOString(),
    };

    return { result, issues };
  }
}
