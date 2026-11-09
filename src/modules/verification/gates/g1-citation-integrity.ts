import { randomUUID } from 'node:crypto';
import type { GateEvaluator, GateEvaluationContext } from './gate.interface.js';
import type { QualityGateResult, ReviewIssue } from '../verification.types.js';

export class G1CitationIntegrityEvaluator implements GateEvaluator {
  readonly gateId = 'G1';
  readonly name = 'Citation Integrity & Registry Grounding';

  async evaluate(context: GateEvaluationContext): Promise<{ result: QualityGateResult; issues: ReviewIssue[] }> {
    const { manifest } = context;
    const issues: ReviewIssue[] = [];

    for (const unresolved of manifest.unresolvedCitations) {
      const parts = unresolved.location.split('/');
      const sectionKey = parts[0] || 'manuscript';
      const target = parts[1] || unresolved.marker;

      issues.push({
        id: randomUUID(),
        gateId: 'G1',
        severity: 'BLOCKING',
        sectionKey,
        target,
        message: unresolved.reason,
        suggestedRemedy: `Remove marker "[${unresolved.marker}]" or link it to a verified study/evidence in the snapshot corpus.`,
      });
    }

    // Nothing to resolve is not the same as everything resolved: do not report a vacuous PASS.
    if (manifest.totalCitations === 0 && issues.length === 0) {
      return {
        result: {
          gateId: 'G1',
          name: this.name,
          status: 'NOT_APPLICABLE',
          severity: 'BLOCKING',
          message: 'The manuscript contains no citation markers, so there is nothing to resolve against the registry.',
          issuesCount: 0,
          details: { totalCitations: 0, resolvedCitations: 0, unresolvedCount: 0 },
          evaluatedAt: new Date().toISOString(),
        },
        issues,
      };
    }

    const isPass = issues.length === 0;
    const result: QualityGateResult = {
      gateId: 'G1',
      name: this.name,
      status: isPass ? 'PASS' : 'FAIL',
      severity: 'BLOCKING',
      message: isPass
        ? `All ${manifest.resolvedCitations} citations successfully resolved to valid snapshot entities.`
        : `Found ${issues.length} unresolved or ungrounded citation references.`,
      issuesCount: issues.length,
      details: {
        totalCitations: manifest.totalCitations,
        resolvedCitations: manifest.resolvedCitations,
        unresolvedCount: issues.length,
      },
      evaluatedAt: new Date().toISOString(),
    };

    return { result, issues };
  }
}

