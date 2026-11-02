import { z } from 'zod';

/**
 * A journal profile says how a manuscript for one kind of venue is laid out: which sections, in which order, with what
 * length, written from which data. It is not the journal's policy unless the profile says it was checked against it.
 *
 * The rules at the bottom are the point of this file: a profile that was not verified can never present its numbers as
 * a journal's requirements, and a profile that claims to be verified must show who checked it, when, and against what.
 */

/** Where the content of a section comes from. Artifacts and exports are the ones a snapshot holds. */
export const SECTION_SOURCES = ['A1', 'A2', 'A7', 'A10', 'prisma_writing_export', 'rq_findings', 'other_sections'] as const;

export const wordBudgetSchema = z.object({
  min: z.number().int().positive(),
  max: z.number().int().positive(),
}).refine((budget) => budget.min <= budget.max, 'min must not be greater than max');

export const profileSectionSchema = z.object({
  /** Stable name used by the manuscript, for example 'methods'. */
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title: z.string().trim().min(1),
  /** Position in the manuscript, starting at 1 with no gaps. */
  order: z.number().int().positive(),
  required: z.boolean(),
  wordBudget: wordBudgetSchema,
  sources: z.array(z.enum(SECTION_SOURCES)).min(1),
  /** The generator that can write this section today, such as 'methods-template@1'. null while none exists. */
  generator: z.string().min(1).nullable(),
  /** One sentence on what the section is for. */
  purpose: z.string().trim().min(1),
});

export const verificationSchema = z.object({
  status: z.enum(['unverified', 'verified']),
  verifiedAt: z.string().datetime().nullable(),
  verifiedBy: z.string().trim().min(1).nullable(),
  /** Official pages the profile was checked against. */
  policySourceUrls: z.array(z.string().url()),
});

export const journalProfileSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** Increases whenever the content of the profile changes, so a manuscript can say which one it used. */
  version: z.number().int().positive(),
  name: z.string().trim().min(1),
  articleType: z.enum(['systematic_review']),
  /** Language of the manuscript text. */
  language: z.enum(['en']),
  /** The venue this profile is for. Both null for a generic profile that targets no journal. */
  journal: z.object({ name: z.string().trim().min(1).nullable(), url: z.string().url().nullable() }),
  verification: verificationSchema,
  /** Whether the word budgets are suggestions of this system or the journal's own limits. */
  wordBudgetSource: z.enum(['suggested_default', 'journal_policy']),
  /** Citation style of the journal. null until a venue is chosen. */
  citationStyle: z.string().trim().min(1).nullable(),
  /** Shown wherever the profile is shown. Required while the profile is unverified. */
  notice: z.string().trim().min(1).nullable(),
  sections: z.array(profileSectionSchema).min(1),
}).superRefine((profile, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  const keys = profile.sections.map((section) => section.key);
  if (new Set(keys).size !== keys.length) issue(['sections'], 'Section keys must be unique');

  const orders = profile.sections.map((section) => section.order).sort((a, b) => a - b);
  if (orders.some((order, index) => order !== index + 1)) issue(['sections'], 'Section orders must be 1, 2, 3... with no gaps or repeats');

  const { verification } = profile;
  if (verification.status === 'unverified') {
    if (verification.verifiedAt !== null || verification.verifiedBy !== null || verification.policySourceUrls.length > 0) {
      issue(['verification'], 'An unverified profile cannot carry a verification date, a verifier or policy sources');
    }
    if (profile.notice === null) issue(['notice'], 'An unverified profile must carry a notice that says so');
    if (profile.wordBudgetSource !== 'suggested_default') issue(['wordBudgetSource'], 'An unverified profile can only offer suggested word budgets, not journal policy');
  } else {
    if (verification.verifiedAt === null || verification.verifiedBy === null || verification.policySourceUrls.length === 0) {
      issue(['verification'], 'A verified profile needs a verification date, a verifier and at least one policy source');
    }
    if (profile.journal.name === null) issue(['journal'], 'A verified profile must name the journal it was checked against');
  }
});

export type ProfileSection = z.infer<typeof profileSectionSchema>;
export type JournalProfile = z.infer<typeof journalProfileSchema>;
