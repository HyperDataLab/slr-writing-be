import type { Fact, FactItem } from './methods.types.js';

/**
 * Layer 3 of the Methods section: the check between facts and prose. It is what lets a model write the sentences
 * later without being able to change the science: any number in the text that no fact contains is reported.
 *
 * Limits, stated plainly: it looks at digits only. It cannot see a number written as a word ("six"), it ignores the sign
 * and the decimal point (3.5 needs a 3 and a 5), and it does not check that a number sits next to the right words.
 * Any digit that appears in the review's own text (for example "87%" inside a research question) counts as grounded
 * everywhere. Those need the verification gates of a later milestone.
 */

// Digits of every script count: fullwidth and superscript forms are folded by NFKC, and the other decimal digits
// (Arabic-Indic, Devanagari...) are mapped to their ASCII value. Without this a text could hide a number from the check.
const digitCache = new Map<string, string>();
const digitValue = (char: string): string => {
  const cached = digitCache.get(char);
  if (cached !== undefined) return cached;
  const code = char.codePointAt(0)!;
  let start = code;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
  const value = String((code - start) % 10);
  digitCache.set(char, value);
  return value;
};
export const asciiDigits = (value: string): string => value.normalize('NFKC').replace(/\p{Nd}/gu, digitValue);

const digitRuns = (value: string): string[] => asciiDigits(value).match(/\d+/g) ?? [];

const itemStrings = (item: FactItem): string[] => [item.id ?? '', item.text, item.count === undefined ? '' : String(item.count)];

/** Every run of digits that appears in the facts, as a string so that '007' and '7' stay different. */
export function groundedNumbers(facts: Fact[]): Set<string> {
  const allowed = new Set<string>();
  const add = (value: string) => digitRuns(value).forEach((run) => allowed.add(run));
  for (const fact of facts) {
    if (fact.status !== 'explicit' || fact.value === null) continue;
    if (typeof fact.value === 'number') add(String(fact.value));
    else if (typeof fact.value === 'string') add(fact.value);
    else fact.value.forEach((item) => itemStrings(item).forEach(add));
  }
  return allowed;
}

/** Digit runs in the text that no explicit fact contains. An empty list means every number is grounded. */
export function findUngroundedNumbers(markdown: string, facts: Fact[]): string[] {
  const allowed = groundedNumbers(facts);
  return [...new Set(digitRuns(markdown).filter((run) => !allowed.has(run)))];
}
