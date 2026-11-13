import { describe, it, expect } from 'vitest';
import { evidenceListQuerySchema } from '../../src/modules/evidence/evidence.schemas.js';

describe('Evidence Query Schema', () => {
  it('parses valid default query parameters', () => {
    const parsed = evidenceListQuerySchema.safeParse({ query: {} });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.query.page).toBe(1);
    expect(parsed.data.query.limit).toBe(50);
    expect(parsed.data.query.verified).toBeUndefined();
  });

  it('transforms string verified true/false to boolean', () => {
    const trueParsed = evidenceListQuerySchema.safeParse({ query: { verified: 'true' } });
    expect(trueParsed.success).toBe(true);
    if (trueParsed.success) {
      expect(trueParsed.data.query.verified).toBe(true);
    }

    const falseParsed = evidenceListQuerySchema.safeParse({ query: { verified: 'false' } });
    expect(falseParsed.success).toBe(true);
    if (falseParsed.success) {
      expect(falseParsed.data.query.verified).toBe(false);
    }
  });

  it('rejects invalid verified values', () => {
    const parsed = evidenceListQuerySchema.safeParse({ query: { verified: 'yes' } });
    expect(parsed.success).toBe(false);
  });

  it('rejects unstorable characters in search', () => {
    const parsed = evidenceListQuerySchema.safeParse({ query: { search: 'bad\u0000text' } });
    expect(parsed.success).toBe(false);
  });

  it('enforces limits on page and limit', () => {
    const pageZero = evidenceListQuerySchema.safeParse({ query: { page: '0' } });
    expect(pageZero.success).toBe(false);

    const limitTooLarge = evidenceListQuerySchema.safeParse({ query: { limit: '500' } });
    expect(limitTooLarge.success).toBe(false);

    const validLarge = evidenceListQuerySchema.safeParse({ query: { limit: '200', page: '5' } });
    expect(validLarge.success).toBe(true);
    if (validLarge.success) {
      expect(validLarge.data.query.limit).toBe(200);
      expect(validLarge.data.query.page).toBe(5);
    }
  });
});

