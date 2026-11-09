import { buildPrompt, SAFETY_RULES } from '../llm/prompt.js';
import type { ParagraphPlanItem } from '../paragraph-plans/paragraph-plan.types.js';
import type { DraftedParagraph, ParagraphDraftOutput, ParagraphEvidencePack } from './drafting.types.js';

export const PROMPT_TEMPLATE_ID = 'results-paragraph-draft';
export const PROMPT_TEMPLATE_VERSION = 1;

export interface SnapshotRegistryLookup {
  claims: Map<string, { externalId: string; title: string }>;
  findings: Map<string, { externalId: string; fieldName: string; valueText: string; studyId: string; studyTitle: string }>;
  evidence: Map<string, { externalId: string; quote: string; studyId: string }>;
}

/**
 * Extracts a minimal evidence pack for a single paragraph plan.
 * Only the findings and evidence items explicitly requested in the plan are included.
 */
export function buildMinimalEvidencePack(
  plan: ParagraphPlanItem,
  lookup: SnapshotRegistryLookup,
): ParagraphEvidencePack {
  const claims = plan.claimIds
    .map((id) => lookup.claims.get(id))
    .filter((c): c is NonNullable<typeof c> => c !== undefined)
    .map((c) => ({ id: c.externalId, title: c.title }));

  const findings = plan.findingIds
    .map((id) => lookup.findings.get(id))
    .filter((f): f is NonNullable<typeof f> => f !== undefined)
    .map((f) => ({
      id: f.externalId,
      fieldName: f.fieldName,
      valueText: f.valueText,
      studyId: f.studyId,
      studyTitle: f.studyTitle,
    }));

  const evidence = plan.evidenceIds
    .map((id) => lookup.evidence.get(id))
    .filter((e): e is NonNullable<typeof e> => e !== undefined)
    .map((e) => ({
      id: e.externalId,
      quote: e.quote,
      studyId: e.studyId,
    }));

  return {
    paragraphId: plan.id,
    sectionKey: plan.sectionKey,
    subsectionId: plan.subsectionId,
    rhetoricalMove: plan.rhetoricalMove,
    claimStrength: plan.claimStrength,
    conditionsRequired: plan.conditionsRequired,
    sentenceSlots: plan.sentenceSlots,
    limitations: plan.limitations,
    claims,
    findings,
    evidence,
  };
}

/** Builds the system prompt and safe user prompt with DATA isolation. */
export function buildDraftingPrompts(pack: ParagraphEvidencePack): { system: string; prompt: string } {
  const system = [
    'You are an expert scientific manuscript writer assisting in drafting a Systematic Literature Review (SLR) paper in English.',
    'Write exactly one cohesive academic paragraph based solely on the provided evidence pack.',
    `Adhere to the requested rhetorical move (${pack.rhetoricalMove}) and sentence structure (${pack.sentenceSlots.join(' -> ')}).`,
    `Claim strength rule: "${pack.claimStrength}". ${
      pack.claimStrength === 'qualified'
        ? 'Preserve hedges, conditions, and uncertainty; do not make definitive assertions.'
        : pack.claimStrength === 'strong'
          ? 'Present the consensus with appropriate scientific confidence supported by the evidence.'
          : 'Report findings with objective neutrality.'
    }`,
    'Citation rule: Citations in the text must refer to the provided evidence or studies. In your JSON response, return the exact IDs of the evidence and findings you used in usedEvidenceIds and usedFindingIds.',
    SAFETY_RULES,
  ].join(' ');

  const task = `Draft academic paragraph ${pack.paragraphId} for section "${pack.sectionKey}". Follow the sentence slots: [${pack.sentenceSlots.join(', ')}]. Output valid JSON with paragraphId, text, usedEvidenceIds, usedFindingIds, and optional limitationsNoted.`;

  const prompt = buildPrompt({
    task,
    data: pack as unknown as Record<string, unknown>,
  });

  return { system, prompt };
}

/**
 * Validates that the LLM only referenced evidence and findings that were part of the minimal pack.
 * Enforces the Registry-only citation invariant.
 */
export function validateDraftOutput(
  output: ParagraphDraftOutput,
  pack: ParagraphEvidencePack,
): { valid: boolean; sanitized: DraftedParagraph; errorReason?: string } {
  const allowedEvidenceIds = new Set(pack.evidence.map((e) => e.id));
  const allowedFindingIds = new Set(pack.findings.map((f) => f.id));

  // Check for foreign/hallucinated IDs
  const foreignEvidence = output.usedEvidenceIds.filter((id) => !allowedEvidenceIds.has(id));
  const foreignFindings = output.usedFindingIds.filter((id) => !allowedFindingIds.has(id));

  if (foreignEvidence.length > 0 || foreignFindings.length > 0) {
    return {
      valid: false,
      sanitized: {
        paragraphId: pack.paragraphId,
        text: output.text,
        usedEvidenceIds: output.usedEvidenceIds.filter((id) => allowedEvidenceIds.has(id)),
        usedFindingIds: output.usedFindingIds.filter((id) => allowedFindingIds.has(id)),
        limitationsNoted: output.limitationsNoted ?? [],
      },
      errorReason: `The model cited IDs not present in the evidence pack: ${[...foreignEvidence, ...foreignFindings].join(', ')}`,
    };
  }

  return {
    valid: true,
    sanitized: {
      paragraphId: pack.paragraphId,
      text: output.text,
      usedEvidenceIds: Array.from(new Set(output.usedEvidenceIds)),
      usedFindingIds: Array.from(new Set(output.usedFindingIds)),
      limitationsNoted: output.limitationsNoted ?? [],
    },
  };
}

