import { createHash } from 'node:crypto';
import type { ParagraphPlanContent, ParagraphPlanContext, ParagraphPlanItem, RhetoricalMove, SentenceSlot } from './paragraph-plan.types.js';

const MAX_ID_LENGTH = 250;

/** Generates a safe, deterministic, unique paragraph plan ID. */
export function paragraphIdOf(subsectionId: string, index: number): string {
  const paddedIndex = String(index).padStart(2, '0');
  const plain = `P-${subsectionId}-${paddedIndex}`;
  if (plain.length <= MAX_ID_LENGTH) return plain;
  const hash = createHash('sha256').update(subsectionId).digest('hex').slice(0, 32);
  return `P-sha256-${hash}-${paddedIndex}`;
}

/**
 * Builds a deterministic initial ParagraphPlan set from the approved Blueprint and Snapshot data.
 * No LLM is used; the mapping is governed strictly by the evidence graph in the snapshot.
 */
export function generateParagraphPlans(context: ParagraphPlanContext): ParagraphPlanContent {
  const { blueprint, claims, findings, evidence } = context;
  const claimsByExternalId = new Map(claims.map((c) => [c.externalId, c]));
  const findingsByExternalId = new Map(findings.map((f) => [f.externalId, f]));
  const evidenceByExternalId = new Map(evidence.map((e) => [e.externalId, e]));

  const plans: ParagraphPlanItem[] = [];

  for (const section of blueprint.content.sections) {
    if (!section.include) continue;

    for (const subsection of section.subsections) {
      let subIndex = 1;

      if (subsection.claimIds.length > 0) {
        // Results or synthesis subsections tied to specific claims
        for (const claimExternalId of subsection.claimIds) {
          const claim = claimsByExternalId.get(claimExternalId);
          const claimFindingIds = claim ? claim.findingExternalIds.filter((fid) => findingsByExternalId.has(fid)) : [];

          // Collect all evidence IDs belonging to these findings
          const claimEvidenceIds: string[] = [];
          for (const fid of claimFindingIds) {
            const f = findingsByExternalId.get(fid);
            if (f) {
              for (const eid of f.evidenceExternalIds) {
                if (evidenceByExternalId.has(eid) && !claimEvidenceIds.includes(eid)) {
                  claimEvidenceIds.push(eid);
                }
              }
            }
          }

          const hasEvidence = claimEvidenceIds.length > 0;
          const status = hasEvidence ? 'READY_TO_DRAFT' : 'NEEDS_EVIDENCE';

          // Paragraph 1: Overview & synthesis of the theme
          plans.push({
            id: paragraphIdOf(subsection.id, subIndex++),
            sectionKey: section.key,
            subsectionId: subsection.id,
            rhetoricalMove: 'theme_overview' as RhetoricalMove,
            rqIds: [...subsection.rqIds],
            claimIds: [claimExternalId],
            findingIds: claimFindingIds.slice(0, 5),
            evidenceIds: claimEvidenceIds.slice(0, 5),
            claimStrength: 'qualified',
            conditionsRequired: true,
            citationPolicy: 'registry_only',
            sentenceSlots: ['topic', 'evidence', 'synthesis'] as SentenceSlot[],
            limitations: hasEvidence ? [] : ['No direct verbatim evidence linked to this theme in the review registry.'],
            status,
          });

          // Paragraph 2: Detailed presentation of findings across studies (if findings exist)
          if (claimFindingIds.length > 0) {
            plans.push({
              id: paragraphIdOf(subsection.id, subIndex++),
              sectionKey: section.key,
              subsectionId: subsection.id,
              rhetoricalMove: 'report_evidence' as RhetoricalMove,
              rqIds: [...subsection.rqIds],
              claimIds: [claimExternalId],
              findingIds: [...claimFindingIds],
              evidenceIds: [...claimEvidenceIds],
              claimStrength: 'neutral',
              conditionsRequired: true,
              citationPolicy: 'registry_only',
              sentenceSlots: ['topic', 'evidence', 'qualification'] as SentenceSlot[],
              limitations: [],
              status,
            });
          }

          // Paragraph 3: Comparison and synthesis across included studies
          if (claimFindingIds.length > 1) {
            plans.push({
              id: paragraphIdOf(subsection.id, subIndex++),
              sectionKey: section.key,
              subsectionId: subsection.id,
              rhetoricalMove: 'compare_and_synthesize' as RhetoricalMove,
              rqIds: [...subsection.rqIds],
              claimIds: [claimExternalId],
              findingIds: [...claimFindingIds],
              evidenceIds: [...claimEvidenceIds],
              claimStrength: 'qualified',
              conditionsRequired: true,
              citationPolicy: 'registry_only',
              sentenceSlots: ['topic', 'synthesis', 'qualification'] as SentenceSlot[],
              limitations: [],
              status,
            });
          }
        }
      } else {
        // Subsections without specific claim IDs (e.g. Introduction RQ list, Discussion limitations)
        let move: RhetoricalMove = 'theme_overview';
        let slots: SentenceSlot[] = ['topic', 'synthesis'];

        if (subsection.id.includes('limitations')) {
          move = 'discuss_limitation';
          slots = ['topic', 'limitation'];
        } else if (subsection.id.includes('conflict') || subsection.id.includes('agreement')) {
          move = 'compare_and_synthesize';
          slots = ['topic', 'synthesis', 'qualification'];
        }

        plans.push({
          id: paragraphIdOf(subsection.id, subIndex++),
          sectionKey: section.key,
          subsectionId: subsection.id,
          rhetoricalMove: move,
          rqIds: [...subsection.rqIds],
          claimIds: [],
          findingIds: [],
          evidenceIds: [],
          claimStrength: 'neutral',
          conditionsRequired: false,
          citationPolicy: 'registry_only',
          sentenceSlots: slots,
          limitations: [],
          status: 'READY_TO_DRAFT',
        });
      }
    }
  }

  return {
    blueprintVersion: blueprint.version,
    plans,
  };
}

