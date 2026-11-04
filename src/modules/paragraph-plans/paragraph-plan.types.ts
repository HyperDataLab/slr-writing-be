import { z } from 'zod';
import { showsNothing } from '../../shared/utils/invisible-text.js';
import { findStorableProblem, hasUnstorableText } from '../../shared/utils/storable.js';
import type { BlueprintContent } from '../blueprint/blueprint.types.js';

/**
 * ParagraphPlan represents the fine-grained plan for each paragraph of the manuscript.
 * It connects the approved Blueprint (H1) and the immutable ReviewSnapshot to the upcoming
 * LLM drafting engine (M7), ensuring no paragraph is generated without an explicit rhetorical
 * role and grounded evidence IDs.
 */

const MAX_ID_LENGTH = 250;
export const MAX_PARAGRAPHS = 5_000;
export const MAX_PLAN_REFERENCES = 50_000;
export const MAX_CONTENT_NODES = 200_000;

// Text the database can store (no NUL, no lone surrogate) and that shows something visible.
const storable = (schema: z.ZodString) => schema.refine((value) => !hasUnstorableText(value), 'Contains a character that cannot be stored');
const visible = (max: number) => storable(z.string().max(max)).refine((value) => !showsNothing(value), 'Must contain visible text');
const reference = visible(MAX_ID_LENGTH);

export const rhetoricalMoveEnum = z.enum([
  'theme_overview',
  'report_evidence',
  'compare_and_synthesize',
  'discuss_limitation',
  'conclude_subtopic',
]);
export type RhetoricalMove = z.infer<typeof rhetoricalMoveEnum>;

export const claimStrengthEnum = z.enum(['neutral', 'qualified', 'strong']);
export type ClaimStrength = z.infer<typeof claimStrengthEnum>;

export const paragraphPlanStatusEnum = z.enum(['DRAFT', 'NEEDS_EVIDENCE', 'READY_TO_DRAFT']);
export type ParagraphPlanStatus = z.infer<typeof paragraphPlanStatusEnum>;

export const sentenceSlotEnum = z.enum(['topic', 'evidence', 'synthesis', 'qualification', 'limitation']);
export type SentenceSlot = z.infer<typeof sentenceSlotEnum>;

export const paragraphPlanItemSchema = z.object({
  /** Unique paragraph plan identifier across the manuscript, e.g. 'P-claim:123-01'. */
  id: reference,
  /** Section key from the journal profile / blueprint, e.g. 'results', 'discussion'. */
  sectionKey: storable(z.string().min(1).max(40)),
  /** The subsection ID from the blueprint this paragraph belongs to. */
  subsectionId: reference,
  /** Rhetorical purpose of the paragraph in the scientific argument. */
  rhetoricalMove: rhetoricalMoveEnum,
  /** Research question external IDs addressed. */
  rqIds: z.array(reference).max(500),
  /** Snapshot Claim external IDs reported or analyzed. */
  claimIds: z.array(reference).max(1000),
  /** ExtractedFinding external IDs serving as data points. */
  findingIds: z.array(reference).max(1000),
  /** Evidence external IDs providing verbatim grounded quotes and source anchors. */
  evidenceIds: z.array(reference).max(1000),
  /** Degree of assertiveness allowed when drafting. */
  claimStrength: claimStrengthEnum,
  /** Whether caveats, hedges, and study conditions must be explicitly preserved. */
  conditionsRequired: z.boolean(),
  /** Fixed citation policy: citations can only be picked from snapshot registry. */
  citationPolicy: z.literal('registry_only'),
  /** Slots specifying sentence roles in this paragraph. */
  sentenceSlots: z.array(sentenceSlotEnum).min(1).max(20),
  /** Notes on methodological limitations or gaps in the evidence. */
  limitations: z.array(visible(1000)).max(50),
  /** Status: READY_TO_DRAFT only when supporting evidence is present for any claims made. */
  status: paragraphPlanStatusEnum,
}).strict();

export type ParagraphPlanItem = z.infer<typeof paragraphPlanItemSchema>;

const paragraphPlanContentShape = z.object({
  /** The version of the approved Blueprint that this plan is built upon. */
  blueprintVersion: z.number().int().positive().max(1_000_000),
  /** The collection of individual paragraph plans. */
  plans: z.array(paragraphPlanItemSchema).max(MAX_PARAGRAPHS),
}).strict().superRefine((content, ctx) => {
  const references = content.plans.reduce(
    (sum, plan) => sum + plan.rqIds.length + plan.claimIds.length + plan.findingIds.length + plan.evidenceIds.length,
    0,
  );
  if (content.plans.length > MAX_PARAGRAPHS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `A paragraph plan set can have at most ${MAX_PARAGRAPHS} paragraphs` });
  }
  if (references > MAX_PLAN_REFERENCES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `A paragraph plan set can have at most ${MAX_PLAN_REFERENCES} references` });
  }
});

export const paragraphPlanContentSchema = z.unknown()
  .superRefine((value, ctx) => {
    if (findStorableProblem(value, { maxDepth: 64, maxNodes: MAX_CONTENT_NODES }) !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The paragraph plan is too large, nested too deeply, or holds a character that cannot be stored',
      });
    }
  })
  .pipe(paragraphPlanContentShape);

export type ParagraphPlanContent = z.infer<typeof paragraphPlanContentShape>;

/** Context provided to the generator and validator to ensure pure and deterministic execution. */
export interface ParagraphPlanContext {
  blueprint: {
    version: number;
    content: BlueprintContent;
  };
  researchQuestions: Array<{ externalId: string }>;
  claims: Array<{
    externalId: string;
    title: string;
    researchQuestionExternalId: string | null;
    findingExternalIds: string[];
  }>;
  findings: Array<{
    externalId: string;
    fieldName: string;
    valueText: string;
    isNotReported: boolean;
    evidenceExternalIds: string[];
    studyExternalId: string;
  }>;
  evidence: Array<{
    externalId: string;
    quote: string;
    studyExternalId: string;
  }>;
}

export interface ParagraphPlanIssue {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  ref?: string;
}

