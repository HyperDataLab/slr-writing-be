import { z } from 'zod';
import { showsNothing } from '../../shared/utils/invisible-text.js';
import { hasUnstorableText } from '../../shared/utils/storable.js';
import type { Approval, SectionRevision } from '../../generated/prisma/client.js';
import type { ApprovalStatus } from '../approvals/approvals.service.js';
import type { LlmModelInfo } from '../llm/llm.types.js';
import type { ClaimStrength, RhetoricalMove, SentenceSlot } from '../paragraph-plans/paragraph-plan.types.js';

const storable = (schema: z.ZodString) =>
  schema.refine((value) => !hasUnstorableText(value), 'Contains a character that cannot be stored');
const visible = (max: number, min = 1) =>
  storable(z.string().min(min).max(max)).refine((value) => !showsNothing(value), 'Must contain visible text');

/** The strict output shape demanded of the LLM for drafting a single paragraph. */
export const paragraphDraftOutputSchema = z.object({
  paragraphId: visible(250),
  /** Drafted academic prose for this paragraph in English. */
  text: visible(10_000, 10),
  /** Evidence IDs that the LLM actually cited or grounded this paragraph upon. */
  usedEvidenceIds: z.array(visible(250)).max(100),
  /** Finding IDs that the LLM referred to or summarized. */
  usedFindingIds: z.array(visible(250)).max(100),
  /** Methodological notes or caveats highlighted in the text. */
  limitationsNoted: z.array(visible(1000)).max(20).optional(),
}).strict();

export type ParagraphDraftOutput = z.infer<typeof paragraphDraftOutputSchema>;

/** Minimal evidence pack passed to the LLM for drafting a single paragraph. */
export interface ParagraphEvidencePack {
  paragraphId: string;
  sectionKey: string;
  subsectionId: string;
  rhetoricalMove: RhetoricalMove;
  claimStrength: ClaimStrength;
  conditionsRequired: boolean;
  sentenceSlots: SentenceSlot[];
  limitations: string[];
  claims: Array<{
    id: string;
    title: string;
  }>;
  findings: Array<{
    id: string;
    fieldName: string;
    valueText: string;
    studyId: string;
    studyTitle: string;
  }>;
  evidence: Array<{
    id: string;
    quote: string;
    studyId: string;
  }>;
}

export interface DraftedParagraph {
  paragraphId: string;
  text: string;
  usedEvidenceIds: string[];
  usedFindingIds: string[];
  limitationsNoted: string[];
}

export interface DraftSectionFacts {
  sectionKey: string;
  paragraphPlanRevisionId: string;
  blueprintVersion: number;
  paragraphs: DraftedParagraph[];
  modelInfo?: LlmModelInfo;
}

export interface DraftSectionView {
  sectionKey: string;
  revision: SectionRevision;
  approval: {
    status: ApprovalStatus;
    decision: Approval | null;
  };
  versions: Array<
    Pick<SectionRevision, 'id' | 'version' | 'generator' | 'contentHash' | 'createdBy' | 'createdAt'>
  >;
}

export const manualDraftEditSchema = z.object({
  baseVersion: z.number().int().positive().max(1_000_000),
  markdown: visible(100_000),
}).strict();

export type ManualDraftEdit = z.infer<typeof manualDraftEditSchema>;
