import { randomUUID } from 'node:crypto';
import type { GateEvaluator, GateEvaluationContext } from './gate.interface.js';
import type { QualityGateResult, ReviewIssue } from '../verification.types.js';

export class G2QuoteFidelityEvaluator implements GateEvaluator {
  readonly gateId = 'G2';
  readonly name = 'Source Quote Verbatim Fidelity';

  async evaluate(context: GateEvaluationContext): Promise<{ result: QualityGateResult; issues: ReviewIssue[] }> {
    const { manifest } = context;
    const itemsWithQuotes = manifest.items.filter((item) => typeof item.quote === 'string' && item.quote.length > 0);

    if (itemsWithQuotes.length === 0) {
      return {
        result: {
          gateId: 'G2',
          name: this.name,
          status: 'NOT_APPLICABLE',
          severity: 'WARNING',
          message: 'No direct verbatim evidence quotes cited in the evaluated manuscript.',
          issuesCount: 0,
          details: { quotedItemsCount: 0 },
          evaluatedAt: new Date().toISOString(),
        },
        issues: [],
      };
    }

    const issues: ReviewIssue[] = [];

    for (const item of itemsWithQuotes) {
      if (!item.quoteHashVerified) {
        issues.push({
          id: randomUUID(),
          gateId: 'G2',
          severity: 'WARNING',
          sectionKey: item.sectionKey,
          target: item.citationId,
          evidenceExcerpt: item.quote,
          message: `Evidence quote "${item.evidenceId}" was not cryptographically verified against source text.`,
          suggestedRemedy: 'Re-verify source document hash or inspect extraction log.',
        });
      }
    }

    const isPass = issues.length === 0;
    const result: QualityGateResult = {
      gateId: 'G2',
      name: this.name,
      status: isPass ? 'PASS' : 'WARNING',
      severity: 'WARNING',
      message: isPass
        ? `All ${itemsWithQuotes.length} direct quotes verified against source text hashes.`
        : `Found ${issues.length} quotes that could not be cryptographically verified against source text.`,
      issuesCount: issues.length,
      details: {
        quotedItemsCount: itemsWithQuotes.length,
        verifiedCount: itemsWithQuotes.length - issues.length,
      },
      evaluatedAt: new Date().toISOString(),
    };

    return { result, issues };
  }
}

