import { z } from 'zod';
import { showsNothing } from '../../shared/utils/invisible-text.js';
import type { JournalProfile } from '../journal-profiles/journal-profile.schema.js';

/**
 * The blueprint (dàn ý) of a manuscript: which sections it has, how each is broken into subsections, which themes
 * and research questions each subsection answers, and where every research question of the review is covered.
 *
 * The schema below checks the shape of the data, so that a draft can always be saved. Whether the blueprint is good
 * enough to approve is decided by blueprint-validator.ts. Section titles and order are not stored here: they belong to
 * the journal profile, which the blueprint names by id and version.
 */

const MAX_ID_LENGTH = 250;
const visible = (max: number) => z.string().max(max).refine((value) => !showsNothing(value), 'Must contain visible text');
const reference = visible(MAX_ID_LENGTH);

export const blueprintSubsectionSchema = z.object({
  /** Unique across the whole blueprint. Generated ones look like 'claim:<id of the theme>'. */
  id: reference,
  title: visible(300),
  purpose: visible(1000).nullable(),
  /** Themes of the snapshot (Claim.externalId) that this subsection reports. */
  claimIds: z.array(reference).max(1000),
  /** Research questions (ResearchQuestion.externalId) that this subsection speaks to. */
  rqIds: z.array(reference).max(500),
}).strict();

export const blueprintSectionSchema = z.object({
  /** One of the keys of the journal profile. */
  key: z.string().min(1).max(40),
  include: z.boolean(),
  wordBudget: z.object({ min: z.number().int().positive().max(1_000_000), max: z.number().int().positive().max(1_000_000) }).strict(),
  subsections: z.array(blueprintSubsectionSchema).max(1000),
}).strict();

export const blueprintCoverageSchema = z.object({
  rqId: reference,
  /** Subsections that answer the question. */
  subsectionIds: z.array(reference).max(1000),
  /** Why the question is not covered, when it is not. A question needs subsections or a reason, never neither. */
  notApplicableReason: visible(1000).nullable(),
}).strict();

export const blueprintContentSchema = z.object({
  profile: z.object({ id: z.string().min(1).max(64), version: z.number().int().positive().max(1_000_000) }).strict(),
  sections: z.array(blueprintSectionSchema).min(1).max(20),
  coverage: z.array(blueprintCoverageSchema).max(500),
}).strict();

export type BlueprintContent = z.infer<typeof blueprintContentSchema>;
export type BlueprintSection = z.infer<typeof blueprintSectionSchema>;
export type BlueprintSubsection = z.infer<typeof blueprintSubsectionSchema>;

/** What the generator and the validator know about the snapshot. Plain data, so both stay pure. */
export interface BlueprintContext {
  profile: JournalProfile;
  researchQuestions: Array<{ externalId: string; code: string | null; text: string }>;
  claims: Array<{ externalId: string; title: string; researchQuestionExternalId: string | null }>;
}

export interface BlueprintIssue {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  ref?: string;
}
