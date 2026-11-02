import { z } from 'zod';
import { showsNothing } from '../../shared/utils/invisible-text.js';
import { findStorableProblem, hasUnstorableText } from '../../shared/utils/storable.js';
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
export const MAX_SUBSECTIONS = 5_000;
export const MAX_REFERENCES = 50_000;
// Text the database can store (no NUL, no lone surrogate) and that shows something.
const storable = (schema: z.ZodString) => schema.refine((value) => !hasUnstorableText(value), 'Contains a character that cannot be stored');
const visible = (max: number) => storable(z.string().max(max)).refine((value) => !showsNothing(value), 'Must contain visible text');
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
  key: storable(z.string().min(1).max(40)),
  include: z.boolean(),
  wordBudget: z.object({ min: z.number().int().positive().max(1_000_000), max: z.number().int().positive().max(1_000_000) }).strict(),
  subsections: z.array(blueprintSubsectionSchema).max(MAX_SUBSECTIONS),
}).strict();

export const blueprintCoverageSchema = z.object({
  rqId: reference,
  /** Subsections that answer the question. */
  subsectionIds: z.array(reference).max(1000),
  /** Why the question is not covered, when it is not. A question needs subsections or a reason, never neither. */
  notApplicableReason: visible(1000).nullable(),
}).strict();

const blueprintContentShape = z.object({
  profile: z.object({ id: storable(z.string().min(1).max(64)), version: z.number().int().positive().max(1_000_000) }).strict(),
  sections: z.array(blueprintSectionSchema).min(1).max(20),
  coverage: z.array(blueprintCoverageSchema).max(500),
}).strict().superRefine((content, ctx) => {
  // The limits on each list are generous, but together they would allow a blueprint of millions of references, which
  // every read has to check. These totals keep a blueprint to the size a person could have written.
  const subsections = content.sections.flatMap((section) => section.subsections);
  const references = subsections.reduce((sum, subsection) => sum + subsection.claimIds.length + subsection.rqIds.length, 0)
    + content.coverage.reduce((sum, entry) => sum + entry.subsectionIds.length, 0);
  if (subsections.length > MAX_SUBSECTIONS) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `A blueprint can have at most ${MAX_SUBSECTIONS} subsections` });
  if (references > MAX_REFERENCES) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `A blueprint can have at most ${MAX_REFERENCES} references to themes, questions and subsections` });
});

/**
 * The whole blueprint. The first step only counts the values in the input and stops at the limit, so an input of a million
 * references is turned away in time proportional to the limit; the field-by-field checks run only on input that passed it.
 */
export const MAX_CONTENT_NODES = 200_000;
export const blueprintContentSchema = z.unknown()
  .superRefine((value, ctx) => {
    if (findStorableProblem(value, { maxDepth: 64, maxNodes: MAX_CONTENT_NODES }) !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The blueprint is too large, nested too deeply, or holds a character that cannot be stored' });
    }
  })
  .pipe(blueprintContentShape);

export type BlueprintContent = z.infer<typeof blueprintContentShape>;
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
