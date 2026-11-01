/**
 * Characters that take no space on the page. The zero-width characters are built from code points, not written as
 * characters in a regular expression, so the source stays readable and an editor cannot silently drop them.
 */
const ZERO_WIDTH = new RegExp(`[${String.fromCharCode(0x200b, 0x2060, 0xfeff)}]`, 'g'); // zero-width space, word joiner, byte order mark

/** True when the text shows nothing: empty, spaces, control characters or format characters (zero-width and the like) only. */
export const showsNothing = (value: string): boolean => value.replace(/[\p{Cc}\p{Cf}\p{Z}\s]/gu, '') === '';

/**
 * Turns text into one visible line: zero-width characters are removed first (U+FEFF would otherwise count as a space),
 * then every run of whitespace, line breaks included, becomes one space, then the remaining control characters go.
 * The zero-width joiners (U+200C, U+200D) stay: scripts such as Persian and Devanagari need them to spell words.
 */
export const toVisibleLine = (value: string): string =>
  value.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').replace(/\p{Cc}/gu, '');
