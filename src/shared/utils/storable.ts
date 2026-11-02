// PostgreSQL text and JSON columns cannot hold a NUL, and a lone surrogate cannot be encoded as UTF-8.
// Either one makes the whole write fail with a 500, so reject them at the edge with a 400.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const hasUnstorableText = (value: string): boolean => UNSTORABLE.test(value);

export type StorableProblem = 'too_deep' | 'too_large' | 'unstorable_text';

export interface StorableLimits {
  /** Deepest nesting allowed. Deeper input could overflow the stack of anything that walks or hashes it. */
  maxDepth?: number;
  /** Most values (strings, numbers, arrays, objects...) allowed in the whole input. Cheap to count, costly to validate. */
  maxNodes?: number;
}

/**
 * Looks through a parsed JSON value, keys included, for text the database cannot store, for nesting so deep that
 * walking it would overflow the stack, and for input with more values than the caller will ever accept.
 * The size check comes first and stops counting at the limit, so a hostile input is turned away in time proportional
 * to the limit, not to its own size. Returns the first problem found, or null.
 */
export function findStorableProblem(value: unknown, limits: StorableLimits = {}): StorableProblem | null {
  const maxDepth = limits.maxDepth ?? 64;
  const maxNodes = limits.maxNodes ?? Infinity;
  let nodes = 0;
  let textProblem = false;

  const walk = (current: unknown, depth: number): StorableProblem | null => {
    nodes += 1;
    if (nodes > maxNodes) return 'too_large';
    if (depth > maxDepth) return 'too_deep';
    if (typeof current === 'string') {
      if (hasUnstorableText(current)) textProblem = true;
    } else if (Array.isArray(current)) {
      for (const item of current) {
        const problem = walk(item, depth + 1);
        if (problem) return problem;
      }
    } else if (current && typeof current === 'object') {
      for (const [key, item] of Object.entries(current)) {
        if (hasUnstorableText(key)) textProblem = true;
        const problem = walk(item, depth + 1);
        if (problem) return problem;
      }
    }
    return null;
  };

  // Size and depth win over text: they are the ones that must stop the walk early.
  const structural = walk(value, 0);
  if (structural) return structural;
  return textProblem ? 'unstorable_text' : null;
}
