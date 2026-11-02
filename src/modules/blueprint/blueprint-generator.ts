import type { BlueprintContent, BlueprintContext, BlueprintSection, BlueprintSubsection } from './blueprint.types.js';

/**
 * Builds the first blueprint from the journal profile and the snapshot, by fixed rules, so the same inputs always give
 * the same blueprint. It writes no prose; a person edits the result and the OWNER approves it (H1).
 *
 * - every section of the profile is included, with the profile's suggested word budget;
 * - Introduction gets one subsection for the research questions;
 * - Results gets one subsection per theme (claim) of the snapshot, tied to the research question the theme answers;
 * - Discussion gets the two subsections every systematic review needs: agreement and conflict, and limitations;
 * - each research question is covered by the Results subsections that answer it. A question no theme answers is left
 *   with no subsection and no reason, so the gap shows up and has to be dealt with before approval.
 */
export const CLAIM_SUBSECTION_PREFIX = 'claim:';

export function generateBlueprint(context: BlueprintContext): BlueprintContent {
  const { profile, researchQuestions, claims } = context;
  const knownQuestions = new Set(researchQuestions.map((question) => question.externalId));

  const resultsSubsections: BlueprintSubsection[] = claims.map((claim) => ({
    id: `${CLAIM_SUBSECTION_PREFIX}${claim.externalId}`,
    title: claim.title,
    purpose: null,
    claimIds: [claim.externalId],
    rqIds: claim.researchQuestionExternalId && knownQuestions.has(claim.researchQuestionExternalId) ? [claim.researchQuestionExternalId] : [],
  }));

  const subsectionsFor = (key: string): BlueprintSubsection[] => {
    switch (key) {
      case 'introduction':
        return [{ id: 'intro:research-questions', title: 'Research questions', purpose: null, claimIds: [], rqIds: researchQuestions.map((question) => question.externalId) }];
      case 'results':
        return resultsSubsections;
      case 'discussion':
        return [
          { id: 'discussion:agreement-and-conflict', title: 'Agreement and conflict between studies', purpose: null, claimIds: [], rqIds: [] },
          { id: 'discussion:limitations', title: 'Limitations', purpose: null, claimIds: [], rqIds: [] },
        ];
      default:
        return [];
    }
  };

  const sections: BlueprintSection[] = [...profile.sections]
    .sort((a, b) => a.order - b.order)
    .map((section) => ({
      key: section.key,
      include: true,
      wordBudget: { min: section.wordBudget.min, max: section.wordBudget.max },
      subsections: subsectionsFor(section.key),
    }));

  return {
    profile: { id: profile.id, version: profile.version },
    sections,
    coverage: researchQuestions.map((question) => ({
      rqId: question.externalId,
      subsectionIds: resultsSubsections.filter((subsection) => subsection.rqIds.includes(question.externalId)).map((subsection) => subsection.id),
      notApplicableReason: null,
    })),
  };
}
