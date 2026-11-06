import { randomUUID } from 'node:crypto';
import type { GateEvaluator, GateEvaluationContext } from './gate.interface.js';
import type { QualityGateResult, ReviewIssue } from '../verification.types.js';

/**
 * Paragraph ids recorded in a drafted section's facts (`facts.paragraphs[].paragraphId`) whose text is still part of
 * the section markdown. A manual edit keeps the old facts, so a paragraph that was edited away must not count.
 * Methods facts are not paragraphs.
 */
function draftedParagraphIds(facts: unknown, markdown: string): string[] {
  const paragraphs = (facts as { paragraphs?: unknown } | null)?.paragraphs;
  if (!Array.isArray(paragraphs)) return [];
  const ids: string[] = [];
  for (const p of paragraphs as Array<{ paragraphId?: unknown; text?: unknown } | null>) {
    if (typeof p?.paragraphId !== 'string') continue;
    if (typeof p.text === 'string' && p.text.trim() !== '' && markdown.includes(p.text.trim())) ids.push(p.paragraphId);
  }
  return ids;
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

    // A required section whose drafted paragraphs were all edited away is as good as missing (Methods has no paragraphs).
    const required = new Set(context.requiredSections ?? []);
    const hollowSections: string[] = [];
    for (const section of sections) {
      if (section.sectionKey === 'methods' || !required.has(section.sectionKey)) continue;
      if (draftedParagraphIds(section.facts, section.markdown).length > 0) continue;
      hollowSections.push(section.sectionKey);
      issues.push({
        id: randomUUID(),
        gateId: 'G7',
        severity: 'BLOCKING',
        sectionKey: section.sectionKey,
        target: section.sectionKey,
        message: `Required section "${section.sectionKey}" has no drafted paragraph left (its text was replaced or emptied).`,
        suggestedRemedy: `Re-draft the "${section.sectionKey}" section from its paragraph plans.`,
      });
    }

    // An RQ is covered when at least one drafted paragraph was planned for it.
    const planRqIds = new Map((context.paragraphPlans ?? []).map((plan) => [plan.id, plan.rqIds ?? []]));
    const coveredRqIds = new Set<string>();
    for (const section of sections) {
      for (const paragraphId of draftedParagraphIds(section.facts, section.markdown)) {
        for (const rqId of planRqIds.get(paragraphId) ?? []) coveredRqIds.add(rqId);
      }
    }

    // H1 lets the owner declare a question not applicable with a reason; that exemption is recorded, not ignored.
    const exempt = new Map((context.coverage ?? []).filter((c) => c.notApplicableReason).map((c) => [c.rqId, c.notApplicableReason]));
    const notApplicableRQs = rqs.filter((rq) => exempt.has(rq.rqId)).map((rq) => rq.code ?? rq.rqId);

    let uncovered = 0;
    for (const rq of rqs) {
      if (coveredRqIds.has(rq.rqId) || exempt.has(rq.rqId)) continue;
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
        : `Coverage incomplete: ${missingSections.length + hollowSections.length} required section(s) not drafted, ${uncovered} research question(s) without a drafted paragraph.`,
      issuesCount: issues.length,
      details: {
        totalRQs: rqs.length,
        uncoveredRQs: uncovered,
        missingSections,
        hollowSections,
        notApplicableRQs,
      },
      evaluatedAt: new Date().toISOString(),
    };

    return { result, issues };
  }
}
