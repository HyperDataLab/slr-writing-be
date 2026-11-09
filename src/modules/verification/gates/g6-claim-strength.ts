import { randomUUID } from 'node:crypto';
import type { GateEvaluator, GateEvaluationContext } from './gate.interface.js';
import type { QualityGateResult, ReviewIssue } from '../verification.types.js';

const ABSOLUTIST_MARKERS = [
  /\bproves? beyond (?:any )?doubt\b/i,
  /\bcompletely eliminates?\b/i,
  /\balways guaranteed?\b/i,
  /\bunquestionably\b/i,
  /\bflawless(?:ly)?\b/i,
  /\b100% effective\b/i,
];

export class G6ClaimStrengthEvaluator implements GateEvaluator {
  readonly gateId = 'G6';
  readonly name = 'Claim Strength & Hedging Alignment';

  async evaluate(context: GateEvaluationContext): Promise<{ result: QualityGateResult; issues: ReviewIssue[] }> {
    const { sections, paragraphPlans } = context;
    const issues: ReviewIssue[] = [];

    if (!paragraphPlans || paragraphPlans.length === 0) {
      return {
        result: {
          gateId: 'G6',
          name: this.name,
          status: 'NOT_APPLICABLE',
          severity: 'WARNING',
          message: 'No paragraph plan claim strength constraints defined.',
          issuesCount: 0,
          details: { planCount: 0 },
          evaluatedAt: new Date().toISOString(),
        },
        issues: [],
      };
    }

    const qualifiedPlans = paragraphPlans.filter((p) => p.claimStrength === 'qualified');

    for (const sec of sections) {
      const facts = (sec.facts && typeof sec.facts === 'object' ? sec.facts : {}) as Record<string, unknown>;
      const paragraphs = Array.isArray(facts.paragraphs) ? (facts.paragraphs as Array<Record<string, unknown>>) : [];

      for (const p of paragraphs) {
        const paragraphId = typeof p.paragraphId === 'string' ? p.paragraphId : '';
        const matchingPlan = qualifiedPlans.find((qp) => qp.id === paragraphId);
        if (matchingPlan) {
          const text = typeof p.text === 'string' ? p.text : '';
          for (const pattern of ABSOLUTIST_MARKERS) {
            if (pattern.test(text)) {
              issues.push({
                id: randomUUID(),
                gateId: 'G6',
                severity: 'WARNING',
                sectionKey: sec.sectionKey,
                target: paragraphId,
                message: `Paragraph planned with "qualified" strength contains absolutist assertion matching ${pattern}.`,
                suggestedRemedy: 'Add scientific hedges (e.g. "suggests", "indicates", "under evaluated conditions").',
              });
              break;
            }
          }
        }
      }
    }

    const isPass = issues.length === 0;
    const result: QualityGateResult = {
      gateId: 'G6',
      name: this.name,
      status: isPass ? 'PASS' : 'WARNING',
      severity: 'WARNING',
      message: isPass
        ? 'All drafted paragraphs align with designated scientific claim strength & hedging rules.'
        : `Detected ${issues.length} potential overclaims or missing hedges in qualified paragraphs.`,
      issuesCount: issues.length,
      details: {
        qualifiedPlanCount: qualifiedPlans.length,
        issueCount: issues.length,
      },
      evaluatedAt: new Date().toISOString(),
    };

    return { result, issues };
  }
}

