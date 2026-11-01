import type { Fact, FactItem } from './methods.types.js';

/**
 * Layer 3 of the Methods section: the check between facts and prose. It is what lets a model write the sentences
 * later without being able to change the science: any number in the text that no fact contains is reported.
 *
 * Limits, stated plainly: it looks at digits only. It cannot see a number written as a word ("six"), and it does not
 * check that a number sits next to the right words. Those need the verification gates of a later milestone.
 */

const digitRuns = (value: string): string[] => value.match(/\d+/g) ?? [];

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
