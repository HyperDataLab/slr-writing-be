import { createHash } from 'node:crypto';

/** JSON with sorted object keys and no undefined members, so equal content always gives the same text. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 'sha256:<hex>' of the stable JSON of a value. */
export const hashOfJson = (value: unknown): string => `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
