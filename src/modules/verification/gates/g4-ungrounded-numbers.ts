import { randomUUID } from 'node:crypto';
import type { GateEvaluator, GateEvaluationContext } from './gate.interface.js';
import type { QualityGateResult, ReviewIssue } from '../verification.types.js';

export class G4UngroundedNumbersEvaluator implements GateEvaluator {
  readonly gateId = 'G4';
  readonly name = 'Ungrounded Numerical Claims Audit';

  async evaluate(context: GateEvaluationContext): Promise<{ result: QualityGateResult; issues: ReviewIssue[] }> {
    const { sections, registry, supplements } = context;

    // Collect all authorized numbers into a Grounded Set
    const groundedNumbers = new Set<string>();

    // 1. Study years
    for (const study of registry.studies) {
      if (study.year !== null) groundedNumbers.add(String(study.year));
    }

    // 2. Finding numerical values
    const numRegex = /\b\d+(?:\.\d+)?%?\b/g;
    for (const f of registry.findings) {
      const matches = f.valueText.match(numRegex) ?? [];
      for (const m of matches) groundedNumbers.add(m);
    }

    // 3. PRISMA flow numbers
    if (supplements?.prismaWritingExport?.flow?.studiesIncluded !== undefined && supplements.prismaWritingExport.flow.studiesIncluded !== null) {
      groundedNumbers.add(String(supplements.prismaWritingExport.flow.studiesIncluded));
    }
    groundedNumbers.add(String(registry.studies.length));

    // 4. Section facts numbers
    for (const sec of sections) {
      const factsStr = JSON.stringify(sec.facts ?? {});
      const matches = factsStr.match(numRegex) ?? [];
      for (const m of matches) groundedNumbers.add(m);
    }

    // Common benign numbers (markdown numbering, single-digit indexes 1-10)
    for (let i = 1; i <= 10; i++) groundedNumbers.add(String(i));

    const issues: ReviewIssue[] = [];

    for (const sec of sections) {
      const textMatches = sec.markdown.match(numRegex) ?? [];
      for (const token of textMatches) {
        // Strip percentage symbol for matching raw number if present
        const rawNum = token.endsWith('%') ? token.slice(0, -1) : token;
        if (!groundedNumbers.has(token) && !groundedNumbers.has(rawNum)) {
          issues.push({
            id: randomUUID(),
            gateId: 'G4',
            severity: 'BLOCKING',
            sectionKey: sec.sectionKey,
            target: token,
            message: `Numerical value "${token}" in section "${sec.sectionKey}" is ungrounded in corpus facts or evidence.`,
            suggestedRemedy: 'Ground this number in a verified finding or remove the unbacked statistic.',
          });
        }
      }
    }

    const isPass = issues.length === 0;
    const result: QualityGateResult = {
      gateId: 'G4',
      name: this.name,
      status: isPass ? 'PASS' : 'FAIL',
      severity: 'BLOCKING',
      message: isPass
        ? 'All numerical figures in drafted prose are grounded in snapshot facts.'
        : `Detected ${issues.length} ungrounded numerical figures in drafted sections.`,
      issuesCount: issues.length,
      details: {
        totalAuthorizedFigures: groundedNumbers.size,
        ungroundedCount: issues.length,
      },
      evaluatedAt: new Date().toISOString(),
    };

    return { result, issues };
  }
}

