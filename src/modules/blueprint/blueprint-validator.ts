import type { BlueprintContent, BlueprintContext, BlueprintIssue } from './blueprint.types.js';

/**
 * Decides whether a blueprint can be approved (H1). A pure function of the blueprint and the snapshot's themes and
 * research questions. Blocking issues stop the approval; warnings are shown but do not.
 *
 * The profile it is checked against is `context.profile`, which the service loads by the id the blueprint names.
 */
export function validateBlueprint(content: BlueprintContent, context: BlueprintContext): BlueprintIssue[] {
  const issues: BlueprintIssue[] = [];
  const block = (code: string, message: string, ref?: string) => issues.push({ code, severity: 'blocking', message, ...(ref === undefined ? {} : { ref }) });
  const warn = (code: string, message: string, ref?: string) => issues.push({ code, severity: 'warning', message, ...(ref === undefined ? {} : { ref }) });
  const { profile } = context;

  // The profile the blueprint was made for.
  if (content.profile.id !== profile.id) {
    block('PROFILE_MISMATCH', `The blueprint was made for profile ${content.profile.id}, not ${profile.id}`, content.profile.id);
  } else if (content.profile.version !== profile.version) {
    block('PROFILE_OUTDATED', `The blueprint follows version ${content.profile.version} of the profile, which is now version ${profile.version}`, profile.id);
  }

  // Sections: exactly the profile's, each once.
  const profileKeys = new Set(profile.sections.map((section) => section.key));
  const seenKeys = new Set<string>();
  for (const section of content.sections) {
    if (seenKeys.has(section.key)) block('SECTION_DUPLICATE', `Section ${section.key} appears more than once`, section.key);
    seenKeys.add(section.key);
    if (!profileKeys.has(section.key)) block('SECTION_UNKNOWN', `Section ${section.key} is not in the profile`, section.key);
    if (section.wordBudget.min > section.wordBudget.max) block('WORD_BUDGET_INVALID', `Section ${section.key} has a minimum above its maximum`, section.key);
  }
  for (const required of profile.sections) {
    const section = content.sections.find((candidate) => candidate.key === required.key);
    if (!section) block('SECTION_MISSING', `Section ${required.key} is missing`, required.key);
    else if (required.required && !section.include) block('REQUIRED_SECTION_EXCLUDED', `Section ${required.key} is required and cannot be left out`, required.key);
  }

  // Subsections of the sections that are in the manuscript.
  const included = content.sections.filter((section) => section.include && profileKeys.has(section.key));
  const knownClaims = new Set(context.claims.map((claim) => claim.externalId));
  const knownQuestions = new Set(context.researchQuestions.map((question) => question.externalId));
  const subsectionIds = new Map<string, number>();
  const includedSubsectionIds = new Set<string>();
  const placedClaims = new Set<string>();

  for (const section of content.sections) {
    for (const subsection of section.subsections) {
      subsectionIds.set(subsection.id, (subsectionIds.get(subsection.id) ?? 0) + 1);
    }
    if (!section.include && section.subsections.length > 0) {
      warn('EXCLUDED_SECTION_HAS_SUBSECTIONS', `Section ${section.key} is left out, so its subsections will not be written`, section.key);
    }
  }
  for (const [id, count] of subsectionIds) {
    if (count > 1) block('SUBSECTION_ID_DUPLICATE', `The subsection id ${id} is used ${count} times`, id);
  }
  for (const section of included) {
    for (const subsection of section.subsections) {
      includedSubsectionIds.add(subsection.id);
      for (const claimId of subsection.claimIds) {
        if (!knownClaims.has(claimId)) block('UNKNOWN_CLAIM', `Subsection ${subsection.id} points to a theme that is not in the snapshot`, `${subsection.id} -> ${claimId}`);
        else placedClaims.add(claimId);
      }
      for (const rqId of subsection.rqIds) {
        if (!knownQuestions.has(rqId)) block('UNKNOWN_RESEARCH_QUESTION', `Subsection ${subsection.id} points to a research question that is not in the snapshot`, `${subsection.id} -> ${rqId}`);
      }
    }
  }

  // Results with no structure cannot be planned into paragraphs.
  const results = included.find((section) => section.key === 'results');
  if (results && results.subsections.length === 0) block('RESULTS_EMPTY', 'Results has no subsections, so there is nothing to plan the paragraphs from', 'results');

  // Every research question is covered by a subsection, or has a reason it is not.
  const coverageByQuestion = new Map<string, number>();
  for (const entry of content.coverage) coverageByQuestion.set(entry.rqId, (coverageByQuestion.get(entry.rqId) ?? 0) + 1);
  for (const [rqId, count] of coverageByQuestion) {
    if (count > 1) block('COVERAGE_DUPLICATE', `The research question ${rqId} has ${count} coverage entries`, rqId);
    if (!knownQuestions.has(rqId)) block('UNKNOWN_RESEARCH_QUESTION', `Coverage names a research question that is not in the snapshot`, rqId);
  }
  for (const question of context.researchQuestions) {
    const entry = content.coverage.find((candidate) => candidate.rqId === question.externalId);
    const label = question.code ?? question.externalId;
    if (!entry) { block('COVERAGE_MISSING', `Research question ${label} has no coverage entry`, question.externalId); continue; }
    for (const id of entry.subsectionIds) {
      if (!includedSubsectionIds.has(id)) block('COVERAGE_UNKNOWN_SUBSECTION', `Coverage of ${label} points to ${id}, which is not a subsection of a section in the manuscript`, `${question.externalId} -> ${id}`);
    }
    if (entry.subsectionIds.length === 0 && entry.notApplicableReason === null) {
      block('COVERAGE_UNRESOLVED', `Research question ${label} is neither covered by a subsection nor given a reason`, question.externalId);
    }
  }

  // Themes of the snapshot that no subsection reports.
  for (const claim of context.claims) {
    if (!placedClaims.has(claim.externalId)) warn('THEME_NOT_PLACED', `The theme "${claim.title}" is not reported in any subsection`, claim.externalId);
  }

  return issues;
}

export const hasBlockingIssue = (issues: BlueprintIssue[]): boolean => issues.some((issue) => issue.severity === 'blocking');
