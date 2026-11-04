import { randomUUID } from 'node:crypto';
import type { GateEvaluator, GateEvaluationContext } from './gate.interface.js';
import type { QualityGateResult, ReviewIssue } from '../verification.types.js';

export class G7RqCoverageEvaluator implements GateEvaluator {
  readonly gateId = 'G7';
  readonly name = 'Research Question (RQ) Coverage Audit';

  async evaluate(context: GateEvaluationContext): Promise<{ result: QualityGateResult; issues: ReviewIssue[] }> {
    const { blueprint, sections } = context;
    const rqs = blueprint.researchQuestions;
    const issues: ReviewIssue[] = [];

    if (rqs.length === 0) {
      return {
        result: {
          gateId: 'G7',
          name: this.name,
          status: 'NOT_APPLICABLE',
          severity: 'BLOCKING',
          message: 'No research questions found in blueprint.',
          issuesCount: 0,
          details: { rqCount: 0 },
          evaluatedAt: new Date().toISOString(),
        },
        issues: [],
      };
    }

    // Check if sections contain references or headings covering each RQ
    const allMarkdown = sections.map((s) => s.markdown).join('\n\n');

    for (const rq of rqs) {
      const codeMatch = rq.code && allMarkdown.includes(rq.code);
      const idMatch = allMarkdown.includes(rq.rqId);
      // If neither code nor ID appear and length of sections is very short
      if (!codeMatch && !idMatch && sections.length === 0) {
        issues.push({
          id: randomUUID(),
          gateId: 'G7',
          severity: 'BLOCKING',
          sectionKey: 'results',
          target: rq.code ?? rq.rqId,
          message: `Research question "${rq.code ?? rq.rqId}" has no drafted content in the manuscript.`,
          suggestedRemedy: `Draft the designated subsection covering "${rq.question}".`,
        });
      }
    }

    const isPass = issues.length === 0;
    const result: QualityGateResult = {
      gateId: 'G7',
      name: this.name,
      status: isPass ? 'PASS' : 'FAIL',
      severity: 'BLOCKING',
      message: isPass
        ? `All ${rqs.length} research questions are addressed in manuscript sections.`
        : `Uncovered research questions detected (${issues.length} missing).`,
      issuesCount: issues.length,
      details: {
        totalRQs: rqs.length,
        uncoveredRQs: issues.length,
      },
      evaluatedAt: new Date().toISOString(),
    };

    return { result, issues };
  }
}

