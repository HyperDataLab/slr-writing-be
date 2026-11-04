import type { ParagraphPlanContent, ParagraphPlanContext, ParagraphPlanIssue } from './paragraph-plan.types.js';

export const MAX_ISSUES_PER_CODE = 50;

/**
 * Validates a set of ParagraphPlans against the approved Blueprint and Snapshot data.
 * Pure function: blocking issues stop drafting; warnings highlight areas needing review.
 */
export function validateParagraphPlans(
  content: ParagraphPlanContent,
  context: ParagraphPlanContext,
): ParagraphPlanIssue[] {
  const issues: ParagraphPlanIssue[] = [];
  const seen = new Map<string, number>();

  const add = (issue: ParagraphPlanIssue) => {
    const count = (seen.get(issue.code) ?? 0) + 1;
    seen.set(issue.code, count);
    if (count <= MAX_ISSUES_PER_CODE) issues.push(issue);
  };

  const block = (code: string, message: string, ref?: string) =>
    add({ code, severity: 'blocking', message, ...(ref === undefined ? {} : { ref }) });
  const warn = (code: string, message: string, ref?: string) =>
    add({ code, severity: 'warning', message, ...(ref === undefined ? {} : { ref }) });

  const { blueprint, researchQuestions, claims, findings, evidence } = context;

  // 1. Blueprint version alignment
  if (content.blueprintVersion !== blueprint.version) {
    block(
      'BLUEPRINT_VERSION_MISMATCH',
      `The paragraph plans follow blueprint version ${content.blueprintVersion}, but the latest approved blueprint is version ${blueprint.version}`,
      String(content.blueprintVersion),
    );
  }

  // 2. Plans non-empty
  if (content.plans.length === 0) {
    block('PLANS_EMPTY', 'No paragraph plans provided', 'plans');
    return issues;
  }

  // Build lookup sets for snapshot entities
  const knownRqs = new Set(researchQuestions.map((rq) => rq.externalId));
  const knownClaims = new Set(claims.map((c) => c.externalId));
  const knownFindings = new Set(findings.map((f) => f.externalId));
  const knownEvidence = new Set(evidence.map((e) => e.externalId));

  // Build lookup map for included subsections from the approved blueprint
  const includedSubsections = new Map<string, { sectionKey: string; claimIds: Set<string>; rqIds: Set<string> }>();
  for (const section of blueprint.content.sections) {
    if (!section.include) continue;
    for (const sub of section.subsections) {
      includedSubsections.set(sub.id, {
        sectionKey: section.key,
        claimIds: new Set(sub.claimIds),
        rqIds: new Set(sub.rqIds),
      });
    }
  }

  // 3. Duplicate paragraph IDs
  const planIdCounts = new Map<string, number>();
  for (const plan of content.plans) {
    planIdCounts.set(plan.id, (planIdCounts.get(plan.id) ?? 0) + 1);
  }
  for (const [id, count] of planIdCounts) {
    if (count > 1) {
      block('PARAGRAPH_ID_DUPLICATE', `Paragraph id ${id} is used ${count} times`, id);
    }
  }

  const plannedSubsections = new Set<string>();

  // 4. Validate each paragraph plan item
  for (const plan of content.plans) {
    const subsection = includedSubsections.get(plan.subsectionId);

    if (!subsection) {
      block(
        'SUBSECTION_UNKNOWN',
        `Paragraph ${plan.id} points to subsection ${plan.subsectionId}, which is not part of the approved blueprint`,
        `${plan.id} -> ${plan.subsectionId}`,
      );
    } else {
      plannedSubsections.add(plan.subsectionId);
      if (plan.sectionKey !== subsection.sectionKey) {
        block(
          'SECTION_KEY_MISMATCH',
          `Paragraph ${plan.id} has sectionKey "${plan.sectionKey}", but its subsection belongs to "${subsection.sectionKey}"`,
          `${plan.id} (${plan.sectionKey} != ${subsection.sectionKey})`,
        );
      }
    }

    // Check duplicate references within the plan
    if (new Set(plan.rqIds).size !== plan.rqIds.length) {
      warn('DUPLICATE_REFERENCE', `Paragraph ${plan.id} lists the same research question more than once`, plan.id);
    }
    if (new Set(plan.claimIds).size !== plan.claimIds.length) {
      warn('DUPLICATE_REFERENCE', `Paragraph ${plan.id} lists the same theme/claim more than once`, plan.id);
    }
    if (new Set(plan.findingIds).size !== plan.findingIds.length) {
      warn('DUPLICATE_REFERENCE', `Paragraph ${plan.id} lists the same finding more than once`, plan.id);
    }
    if (new Set(plan.evidenceIds).size !== plan.evidenceIds.length) {
      warn('DUPLICATE_REFERENCE', `Paragraph ${plan.id} lists the same evidence more than once`, plan.id);
    }

    // Reference existence checks against snapshot registry
    for (const rqId of plan.rqIds) {
      if (!knownRqs.has(rqId)) {
        block(
          'UNKNOWN_RESEARCH_QUESTION',
          `Paragraph ${plan.id} references research question ${rqId} which is not in the snapshot`,
          `${plan.id} -> ${rqId}`,
        );
      }
    }

    for (const claimId of plan.claimIds) {
      if (!knownClaims.has(claimId)) {
        block(
          'UNKNOWN_CLAIM',
          `Paragraph ${plan.id} references claim ${claimId} which is not in the snapshot`,
          `${plan.id} -> ${claimId}`,
        );
      }
    }

    for (const findingId of plan.findingIds) {
      if (!knownFindings.has(findingId)) {
        block(
          'UNKNOWN_FINDING',
          `Paragraph ${plan.id} references finding ${findingId} which is not in the snapshot`,
          `${plan.id} -> ${findingId}`,
        );
      }
    }

    for (const evidenceId of plan.evidenceIds) {
      if (!knownEvidence.has(evidenceId)) {
        block(
          'UNKNOWN_EVIDENCE',
          `Paragraph ${plan.id} references evidence ${evidenceId} which is not in the snapshot`,
          `${plan.id} -> ${evidenceId}`,
        );
      }
    }

    // Evidence sufficiency check
    if (plan.claimIds.length > 0 && plan.evidenceIds.length === 0) {
      if (plan.status === 'READY_TO_DRAFT') {
        block(
          'EVIDENCE_STATUS_INVALID',
          `Paragraph ${plan.id} reports claims but has no supporting evidence IDs, so it cannot be READY_TO_DRAFT`,
          plan.id,
        );
      } else {
        warn(
          'CLAIM_EVIDENCE_MISSING',
          `Paragraph ${plan.id} reports claims without verbatim evidence in the registry`,
          plan.id,
        );
      }
    }
  }

  // 5. Check if any Results subsection was left completely unplanned
  for (const [subId, subInfo] of includedSubsections) {
    if (subInfo.sectionKey === 'results' && !plannedSubsections.has(subId)) {
      warn('RESULTS_SUBSECTION_UNPLANNED', `Results subsection ${subId} has no planned paragraphs`, subId);
    }
  }

  // 6. Handle issue truncation
  for (const [code, count] of seen) {
    if (count > MAX_ISSUES_PER_CODE) {
      issues.push({
        code: 'ISSUES_TRUNCATED',
        severity: 'warning',
        message: `${count - MAX_ISSUES_PER_CODE} more ${code} issues are not listed`,
        ref: code,
      });
    }
  }

  return issues;
}

export const hasBlockingIssue = (issues: ParagraphPlanIssue[]): boolean =>
  issues.some((issue) => issue.severity === 'blocking');

