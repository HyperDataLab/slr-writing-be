import { randomUUID } from 'node:crypto';
import type { GateEvaluator, GateEvaluationContext } from './gate.interface.js';
import type { QualityGateResult, ReviewIssue } from '../verification.types.js';

/** Paragraph ids recorded in a drafted section's facts (`facts.paragraphs[].paragraphId`). Methods facts are not paragraphs. */
function draftedParagraphIds(facts: unknown): string[] {
  const paragraphs = (facts as { paragraphs?: unknown } | null)?.paragraphs;
  if (!Array.isArray(paragraphs)) return [];
  return paragraphs
    .map((p) => (p as { paragraphId?: unknown } | null)?.paragraphId)
    .filter((id): id is string => typeof id === 'string');
}

export class G7RqCoverageEvaluator implements GateEvaluator {
  readonly gateId = 'G7';
  readonly name = 'Research Question (RQ) Coverage Audit';

  async evaluate(context: GateEvaluationContext): Promise<{ result: QualityGateResult; issues: ReviewIssue[] }> {
    const { blueprint, sections } = context;
    const rqs = blueprint.researchQuestions;
    const issues: ReviewIssue[] = [];

    // Fail-closed: every required section must have a drafted revision, otherwise coverage cannot be claimed.
    const draftedKeys = new Set(sections.map((s) => s.sectionKey));
    const missingSections = (context.requiredSections ?? []).filter((key) => !draftedKeys.has(key));
    for (const key of missingSections) {
      issues.push({
        id: randomUUID(),
        gateId: 'G7',
        severity: 'BLOCKING',
        sectionKey: key,
        target: key,
        message: `Required section "${key}" has not been drafted.`,
        suggestedRemedy: `Draft and approve the "${key}" section before verification can pass.`,
      });
    }

    if (rqs.length === 0 && issues.length === 0) {
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

    // An RQ is covered when at least one drafted paragraph was planned for it.
    const planRqIds = new Map((context.paragraphPlans ?? []).map((plan) => [plan.id, plan.rqIds ?? []]));
    const coveredRqIds = new Set<string>();
    for (const section of sections) {
      for (const paragraphId of draftedParagraphIds(section.facts)) {
        for (const rqId of planRqIds.get(paragraphId) ?? []) coveredRqIds.add(rqId);
      }
    }

    let uncovered = 0;
    for (const rq of rqs) {
      if (coveredRqIds.has(rq.rqId)) continue;
      uncovered += 1;
      issues.push({
        id: randomUUID(),
        gateId: 'G7',
        severity: 'BLOCKING',
        sectionKey: 'results',
        target: rq.code ?? rq.rqId,
        message: `Research question "${rq.code ?? rq.rqId}" has no drafted paragraph in the manuscript.`,
        suggestedRemedy: `Draft the designated subsection covering "${rq.question}".`,
      });
    }

    const isPass = issues.length === 0;
    const result: QualityGateResult = {
      gateId: 'G7',
      name: this.name,
      status: isPass ? 'PASS' : 'FAIL',
      severity: 'BLOCKING',
      message: isPass
        ? `All ${rqs.length} research questions are addressed by drafted paragraphs.`
        : `Coverage incomplete: ${missingSections.length} required section(s) not drafted, ${uncovered} research question(s) without a drafted paragraph.`,
      issuesCount: issues.length,
      details: {
        totalRQs: rqs.length,
        uncoveredRQs: uncovered,
        missingSections,
      },
      evaluatedAt: new Date().toISOString(),
    };

    return { result, issues };
  }
}
