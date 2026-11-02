import { z } from 'zod';
import { KNOWN_GENERATORS } from '../../shared/constants/generators.js';
import { showsNothing } from '../../shared/utils/invisible-text.js';

/**
 * A journal profile says how a manuscript for one kind of venue is laid out: which sections, in which order, with what
 * length, written from which data. It is not the journal's policy unless the profile says it was checked against it.
 *
 * The rules at the bottom are the point of this file: a profile that was not verified can never present its numbers as
 * a journal's requirements, and a profile that claims to be verified must show who checked it, when, and against what.
 */

/** Where the content of a section comes from. Artifacts and exports are the ones a snapshot holds. */
export const SECTION_SOURCES = ['A1', 'A2', 'A7', 'A10', 'prisma_writing_export', 'rq_findings', 'other_sections'] as const;

const MAX_SECTIONS = 20;
const MAX_URL_LENGTH = 2048;
const MAX_VERSION = 1_000_000;
// How far a verification date may be ahead of this server's clock before it is called a future date.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * A page a person is sent to: https only, a real host name, and a sane length. Plain `z.string().url()` accepts anything
 * `new URL()` can read, including javascript:, data: and file: links, which must never be shown as a policy source.
 */
const publicHttpsUrl = z.string().max(MAX_URL_LENGTH).url().refine((value) => {
  // A failed .url() check does not stop this refinement from running, so it must cope with text that is not a URL.
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === 'https:' && host.includes('.') && !IPV4.test(host) && !host.startsWith('[') && host !== 'localhost' && !host.endsWith('.localhost');
  } catch {
    return false;
  }
}, 'Must be an https URL on a public host name');

/** Text that shows something: not empty, and not only spaces or zero-width characters. */
const visibleText = z.string().trim().min(1).refine((value) => !showsNothing(value), 'Must contain visible text');

export const wordBudgetSchema = z.object({
  min: z.number().int().positive(),
  max: z.number().int().positive(),
}).refine((budget) => budget.min <= budget.max, 'min must not be greater than max');

export const profileSectionSchema = z.object({
  /** Stable name used by the manuscript, for example 'methods'. */
  key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(40),
  title: visibleText,
  /** Position in the manuscript, starting at 1 with no gaps. */
  order: z.number().int().positive(),
  required: z.boolean(),
  wordBudget: wordBudgetSchema,
  sources: z.array(z.enum(SECTION_SOURCES)).min(1).refine((sources) => new Set(sources).size === sources.length, 'Sources must not repeat'),
  /** The generator that can write this section today, written name@version, such as 'methods-template@1'. null while none exists. */
  generator: z.string().regex(/^[a-z][a-z0-9-]*@[1-9]\d*$/)
    .refine((name) => KNOWN_GENERATORS.includes(name), 'Must name a generator that exists')
    .nullable(),
  /** One sentence on what the section is for. */
  purpose: visibleText,
});

export const verificationSchema = z.object({
  status: z.enum(['unverified', 'verified']),
  verifiedAt: z.string().datetime().nullable(),
  verifiedBy: visibleText.nullable(),
  /** Official pages the profile was checked against. */
  policySourceUrls: z.array(publicHttpsUrl).refine((urls) => new Set(urls).size === urls.length, 'Policy sources must not repeat'),
});

export const journalProfileSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64),
  /** Increases whenever the content of the profile changes, so a manuscript can say which one it used. */
  version: z.number().int().positive().max(MAX_VERSION),
  name: visibleText,
  articleType: z.enum(['systematic_review']),
  /** Language of the manuscript text. */
  language: z.enum(['en']),
  /** The venue this profile is for. Both null for a generic profile that targets no journal. */
  journal: z.object({ name: visibleText.nullable(), url: publicHttpsUrl.nullable() }),
  verification: verificationSchema,
  /** Whether the word budgets are suggestions of this system or the journal's own limits. */
  wordBudgetSource: z.enum(['suggested_default', 'journal_policy']),
  /** Citation style of the journal. null until a venue is chosen. */
  citationStyle: visibleText.nullable(),
  /** Shown wherever the profile is shown. Required while the profile is unverified. */
  notice: visibleText.nullable(),
  sections: z.array(profileSectionSchema).min(1).max(MAX_SECTIONS),
}).superRefine((profile, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  const keys = profile.sections.map((section) => section.key);
  if (new Set(keys).size !== keys.length) issue(['sections'], 'Section keys must be unique');

  // Listed in manuscript order: a reader that follows the array must not lay the manuscript out backwards.
  if (profile.sections.some((section, index) => section.order !== index + 1)) {
    issue(['sections'], 'Sections must be listed in order, with orders 1, 2, 3... and no gaps or repeats');
  }

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
    if (verification.verifiedAt !== null && Date.parse(verification.verifiedAt) > Date.now() + CLOCK_SKEW_MS) {
      issue(['verification', 'verifiedAt'], 'The verification date cannot be in the future');
    }
    if (profile.journal.name === null) issue(['journal'], 'A verified profile must name the journal it was checked against');
  }
});

export type ProfileSection = z.infer<typeof profileSectionSchema>;
export type JournalProfile = z.infer<typeof journalProfileSchema>;
