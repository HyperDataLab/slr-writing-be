import { z } from 'zod';
import { showsNothing } from '../../shared/utils/invisible-text.js';
import { hasUnstorableText } from '../../shared/utils/storable.js';
import { buildPrompt, SAFETY_RULES } from '../llm/prompt.js';
import { asciiDigits } from '../methods/methods-grounding.js';

/**
 * Abstract and Conclusion are written last, from the sections a person has already approved (H2), not from the corpus.
 * That keeps one rule for the whole manuscript: the writer adds no science. Whatever these two sections say must already
 * be said in an approved section, and the checks below refuse text that brings in a number or a citation of its own.
 */
export const SYNTHESIS_SECTIONS = ['abstract', 'conclusion'] as const;
export type SynthesisSectionKey = (typeof SYNTHESIS_SECTIONS)[number];

export const isSynthesisSection = (key: string): key is SynthesisSectionKey =>
  (SYNTHESIS_SECTIONS as readonly string[]).includes(key);

export const SUMMARY_PROMPT_VERSION = 1;
export const SUMMARY_PROMPT_IDS: Record<SynthesisSectionKey, string> = {
  abstract: 'abstract-draft',
  conclusion: 'conclusion-draft',
};

const MIN_WORDS = 30;
/** The profile's word budget is a suggestion; text beyond this multiple of its maximum is refused as runaway output. */
const MAX_BUDGET_FACTOR = 1.5;

const storableText = (max: number) =>
  z.string().min(1).max(max)
    .refine((value) => !hasUnstorableText(value), 'Contains a character that cannot be stored')
    .refine((value) => !showsNothing(value), 'Must contain visible text');

/** The strict shape demanded of the model. */
export const summaryOutputSchema = z.object({
  /** The section text in English: plain paragraphs separated by a blank line, no headings. */
  text: storableText(10_000),
  /** Keys of the approved sections the text draws on. */
  usedSections: z.array(storableText(40)).min(1).max(10),
}).strict();
export type SummaryOutput = z.infer<typeof summaryOutputSchema>;

export interface SummarySource {
  sectionKey: string;
  version: number;
  contentHash: string;
  markdown: string;
}

export interface SummaryInput {
  sectionKey: SynthesisSectionKey;
  researchQuestions: Array<{ code: string | null; text: string }>;
  /** PRISMA flow counts of the snapshot, when it has them. */
  prismaFlow: Record<string, unknown> | null;
  sources: SummarySource[];
  wordBudget: { min: number; max: number };
}

const TASKS: Record<SynthesisSectionKey, (input: SummaryInput) => string> = {
  abstract: (input) =>
    `Write the Abstract of this systematic review in English, between ${input.wordBudget.min} and ${input.wordBudget.max} words, as one to four short plain paragraphs without headings: the objective, the methods, the main results and what they imply. Use only the approved sections in DATA.`,
  conclusion: (input) =>
    `Write the Conclusion of this systematic review in English, between ${input.wordBudget.min} and ${input.wordBudget.max} words, as plain paragraphs without headings. Answer the research questions one by one using only what the Results and Discussion sections state, and say where the evidence is limited. Use only the approved sections in DATA.`,
};

/** Builds the prompts. All review text goes into the DATA object (see llm/prompt.ts), never into the instructions. */
export function buildSummaryPrompts(input: SummaryInput): { system: string; prompt: string } {
  const system = [
    'You are an expert scientific writer finishing a Systematic Literature Review (SLR) manuscript in English.',
    'Summarise only what the approved sections already say. Do not add findings, numbers, studies, names, citations or conclusions that are not stated in them.',
    'Keep the strength of every claim as the approved text has it: do not turn a hedged statement into a firm one.',
    'Do not write citation markers in square brackets and do not write headings.',
    'In usedSections return the keys of the approved sections you drew on.',
    SAFETY_RULES,
  ].join(' ');

  const prompt = buildPrompt({
    task: TASKS[input.sectionKey](input),
    data: {
      sectionKey: input.sectionKey,
      researchQuestions: input.researchQuestions,
      prismaFlow: input.prismaFlow,
      wordBudget: input.wordBudget,
      approvedSections: input.sources.map((source) => ({ sectionKey: source.sectionKey, markdown: source.markdown })),
    },
  });
  return { system, prompt };
}

const NUMBER = /\b\d+(?:\.\d+)?%?\b/g;
const MARKER = /\[[^\]\s]{1,100}\]/g;
const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const stripPercent = (token: string) => (token.endsWith('%') ? token.slice(0, -1) : token);
/**
 * Digits of every script count as digits (fullwidth, superscript, Arabic-Indic, Devanagari...), and compatibility forms
 * such as a fullwidth bracket are folded, so a number or a marker cannot hide in another script. Limits: a number written
 * as a word ("ninety-nine") or glued to letters ("3rd", "RQ7") is not seen; the G4 gate has the same limits.
 */
const fold = (text: string): string => asciiDigits(text);

export type SummaryValidation =
  | { ok: true; paragraphs: string[] }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

/** Numbers the text may repeat: those of the approved sections, the PRISMA flow, and the counts the writer was shown. */
export function allowedNumbers(input: SummaryInput, studyCount: number): Set<string> {
  const allowed = new Set<string>();
  const add = (raw: string) => {
    for (const token of fold(raw).match(NUMBER) ?? []) {
      allowed.add(token);
      allowed.add(stripPercent(token));
    }
  };
  for (const source of input.sources) add(source.markdown);
  if (input.prismaFlow) add(JSON.stringify(input.prismaFlow));
  add(String(studyCount));
  add(String(input.researchQuestions.length));
  return allowed;
}

/**
 * Checks the model's answer against what it was allowed to use: only approved sections, a sensible length, no citation
 * marker that the approved sections do not already contain, and no number that is not in them. Fail-closed: any problem
 * refuses the text and nothing is stored.
 */
export function validateSummaryOutput(output: SummaryOutput, input: SummaryInput, studyCount: number): SummaryValidation {
  const sourceKeys = new Set(input.sources.map((source) => source.sectionKey));
  const foreign = output.usedSections.filter((key) => !sourceKeys.has(key));
  if (foreign.length > 0) {
    return { ok: false, code: 'LLM_UNKNOWN_SOURCE_SECTION', message: `The model named sections that were not provided: ${foreign.join(', ')}`, details: { foreign } };
  }

  const words = countWords(output.text);
  const ceiling = Math.ceil(input.wordBudget.max * MAX_BUDGET_FACTOR);
  if (words < MIN_WORDS || words > ceiling) {
    return { ok: false, code: 'LLM_OUTPUT_LENGTH', message: `The ${input.sectionKey} has ${words} words; expected between ${MIN_WORDS} and ${ceiling}`, details: { words } };
  }

  if (/^\s{0,3}#/m.test(output.text)) {
    return { ok: false, code: 'LLM_OUTPUT_HEADING', message: 'The text contains a heading; the section heading is added when the manuscript is assembled' };
  }

  const sourceText = fold(input.sources.map((source) => source.markdown).join('\n'));
  const strayMarkers = [...new Set(fold(output.text).match(MARKER) ?? [])].filter((marker) => !sourceText.includes(marker));
  if (strayMarkers.length > 0) {
    return { ok: false, code: 'LLM_HALLUCINATED_REFERENCE', message: `The text contains citation markers that no approved section has: ${strayMarkers.join(', ')}`, details: { markers: strayMarkers } };
  }

  const allowed = allowedNumbers(input, studyCount);
  const strayNumbers = [...new Set(fold(output.text).match(NUMBER) ?? [])].filter((token) => !allowed.has(token) && !allowed.has(stripPercent(token)));
  if (strayNumbers.length > 0) {
    return { ok: false, code: 'LLM_UNGROUNDED_NUMBER', message: `The text contains numbers that no approved section or the PRISMA flow has: ${strayNumbers.join(', ')}`, details: { numbers: strayNumbers } };
  }

  const paragraphs = output.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return { ok: true, paragraphs };
}
