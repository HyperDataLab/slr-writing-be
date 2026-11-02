import { createHash } from 'node:crypto';

/** A whole number between `min` and `max`. Anything that is not a finite number (NaN, Infinity, a string) becomes `fallback`. */
export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** A number between `min` and `max`; not finite becomes `fallback`. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Hash of the system text and the prompt. Written as a JSON array of the two strings, so where one ends and the other
 * starts cannot be confused (a separator inside the text could make two different pairs hash the same).
 */
export const promptHashOf = (system: string, prompt: string): string =>
  `sha256:${createHash('sha256').update(JSON.stringify([system, prompt])).digest('hex')}`;

/** A pessimistic count of the tokens a call can use: a quarter of the input characters, plus the whole output ceiling. */
export const worstCaseTokens = (inputChars: number, maxOutputTokens: number): number =>
  Math.ceil(inputChars / 4) + maxOutputTokens;

/**
 * The value of a Retry-After header in milliseconds: a number of seconds, or an HTTP date. Missing, empty, negative,
 * or unreadable values give undefined, which means "no instruction", not "wait zero".
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  if (/^[A-Za-z]{3}, /.test(value)) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return undefined;
}

/** Removes the key from text for the log, and any run of 8 or more of its characters in a row, in case the service echoed part of it. */
export function redactKey(text: string, key: string): string {
  if (!key) return text;
  const MIN_RUN = 8;
  let out = '';
  for (let i = 0; i < text.length;) {
    let longest = 0;
    if (i + MIN_RUN <= text.length && key.includes(text.slice(i, i + MIN_RUN))) {
      longest = MIN_RUN;
      while (i + longest < text.length && key.includes(text.slice(i, i + longest + 1))) longest += 1;
    }
    if (longest > 0) { out += '<key>'; i += longest; } else { out += text[i]; i += 1; }
  }
  return out;
}
