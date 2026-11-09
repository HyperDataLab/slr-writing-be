import { randomUUID } from 'node:crypto';
import type { GateEvaluator, GateEvaluationContext } from './gate.interface.js';
import type { QualityGateResult, ReviewIssue } from '../verification.types.js';

export class G3PrismaReconciliationEvaluator implements GateEvaluator {
  readonly gateId = 'G3';
  readonly name = 'PRISMA & Quantitative Flow Reconciliation';

  async evaluate(context: GateEvaluationContext): Promise<{ result: QualityGateResult; issues: ReviewIssue[] }> {
    const prisma = context.supplements?.prismaWritingExport;
    const corpusStudyCount = context.registry.studies.length;
    const issues: ReviewIssue[] = [];

    if (!prisma) {
      const issue: ReviewIssue = {
        id: randomUUID(),
        gateId: 'G3',
        severity: 'WARNING',
        sectionKey: 'methods',
        target: 'prisma-flow',
        message: 'PRISMA writing export was not supplied in snapshot supplements.',
        suggestedRemedy: 'Re-export snapshot from slr-be including PRISMA writing export supplement.',
      };
      return {
        result: {
          gateId: 'G3',
          name: this.name,
          status: 'WARNING',
          severity: 'WARNING',
          message: 'PRISMA flow counts cannot be reconciled because PRISMA export is missing.',
          issuesCount: 1,
          details: { corpusStudyCount },
          evaluatedAt: new Date().toISOString(),
        },
        issues: [issue],
      };
    }

    const listed = prisma.includedStudies?.map((s) => s.id) ?? [];
    const counted = prisma.flow?.studiesIncluded ?? listed.length;

    if (counted !== corpusStudyCount) {
      issues.push({
        id: randomUUID(),
        gateId: 'G3',
        severity: 'BLOCKING',
        sectionKey: 'methods',
        target: 'prisma-flow',
        message: `PRISMA flow specifies ${counted} included studies, but corpus contains ${corpusStudyCount} studies.`,
        suggestedRemedy: 'Reconcile screening flow counts on slr-be and re-import snapshot.',
      });
    }

    const isPass = issues.length === 0;
    const result: QualityGateResult = {
      gateId: 'G3',
      name: this.name,
      status: isPass ? 'PASS' : 'FAIL',
      severity: 'BLOCKING',
      message: isPass
        ? `PRISMA flow count (${counted} studies) reconciles with corpus.`
        : `PRISMA flow count mismatch: flow says ${counted}, corpus has ${corpusStudyCount}.`,
      issuesCount: issues.length,
      details: {
        prismaCount: counted,
        corpusCount: corpusStudyCount,
      },
      evaluatedAt: new Date().toISOString(),
    };

    return { result, issues };
  }
}

