import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { openApiDocument } from '../../src/config/openapi.js';
import { setTokenVerifier } from '../../src/middleware/auth.middleware.js';
import { DEFAULT_JOURNAL_PROFILE } from '../../src/modules/journal-profiles/default-profile.js';

// QA (adversarial) HTTP tests of M3. No database needed.
const app = createApp();
const as = (uid = 'qa-jp-alice') => ({ 'X-Dev-User-Id': uid });
const expected = JSON.parse(JSON.stringify(DEFAULT_JOURNAL_PROFILE));
const LIST = '/api/journal-profiles';
const ONE = '/api/journal-profiles/generic-imrad';

afterEach(() => { env.DEV_AUTH_ENABLED = true; setTokenVerifier(null); });

function expectNoLeak(body: unknown) {
  expect(JSON.stringify(body)).not.toMatch(/stack|at .*\.ts|node_modules|zod|ZodError|superRefine|PROFILES/i);
}

describe('auth', () => {
  it('both routes 401 with dev auth off, even with the dev header', async () => {
    env.DEV_AUTH_ENABLED = false;
    for (const path of [LIST, ONE, '/api/journal-profiles/unknown']) {
      const res = await request(app).get(path).set(as());
      expect([path, res.status, res.body.error?.code]).toEqual([path, 401, 'UNAUTHORIZED']);
      expect(JSON.stringify(res.body)).not.toContain('generic-imrad');
    }
  });

  it('a bearer token without a verifier is 401, a rejected token is 401 INVALID_TOKEN', async () => {
    env.DEV_AUTH_ENABLED = false;
    expect((await request(app).get(ONE).set('Authorization', 'Bearer abc')).status).toBe(401);
    setTokenVerifier(async () => null);
    const res = await request(app).get(ONE).set('Authorization', 'Bearer abc');
    expect([res.status, res.body.error.code]).toEqual([401, 'INVALID_TOKEN']);
  });

  it('auth runs before the id guard: unknown and long ids give 401, not 404, when unauthenticated', async () => {
    env.DEV_AUTH_ENABLED = false;
    expect((await request(app).get(`/api/journal-profiles/${'x'.repeat(300)}`)).status).toBe(401);
    expect((await request(app).get('/api/journal-profiles/%00')).status).toBe(401);
  });

  it('a valid token gives 200 with dev auth off', async () => {
    env.DEV_AUTH_ENABLED = false;
    setTokenVerifier(async () => ({ uid: 'tok-user', email: 'a@b.c' }));
    const res = await request(app).get(ONE).set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expected);
  });
});

describe('methods and paths', () => {
  it.each(['post', 'put', 'patch', 'delete'] as const)('%s on list and item is 404 and changes nothing', async (method) => {
    for (const path of [LIST, ONE]) {
      const res = await request(app)[method](path).set(as()).send({ verification: { status: 'verified' }, wordBudgetSource: 'journal_policy' });
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expectNoLeak(res.body);
    }
    expect((await request(app).get(ONE).set(as())).body.data).toEqual(expected);
  });

  it('HEAD gives 200 with no body', async () => {
    const res = await request(app).head(ONE).set(as());
    expect(res.status).toBe(200);
    expect(res.text ?? '').toBe('');
  });

  it('OPTIONS from an allowed origin is a CORS preflight; from a foreign origin it gives no allow-origin', async () => {
    const allowed = env.FRONTEND_URL.split(',')[0].trim();
    const good = await request(app).options(ONE).set('Origin', allowed).set('Access-Control-Request-Method', 'GET');
    expect(good.status).toBe(204);
    expect(good.headers['access-control-allow-origin']).toBe(allowed);
    const bad = await request(app).options(ONE).set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('trailing slash and case-variant paths either serve the same profile or 404, never something else', async () => {
    for (const path of ['/api/journal-profiles/', '/api/journal-profiles/generic-imrad/', '/API/journal-profiles', '/api/Journal-Profiles/generic-imrad', '/api//journal-profiles']) {
      const res = await request(app).get(path).set(as());
      expect([200, 404], path).toContain(res.status);
      if (res.status === 200) {
        const data = Array.isArray(res.body.data) ? res.body.data[0] : res.body.data;
        expect(data, path).toEqual(expected);
      }
    }
  });

  it('query strings never change the output', async () => {
    const base = (await request(app).get(ONE).set(as())).body;
    for (const q of ['?verified=true', '?status=verified', '?verification[status]=verified', '?__proto__[status]=verified', '?wordBudgetSource=journal_policy', '?id=other', '?profileId=x']) {
      expect((await request(app).get(ONE + q).set(as())).body, q).toEqual(base);
      const list = await request(app).get(LIST + q).set(as());
      expect(list.body.data, q).toEqual([expected]);
    }
  });

  it('Accept headers do not change the JSON response', async () => {
    for (const accept of ['text/html', 'application/xml', '*/*', 'text/plain', 'application/json;q=0']) {
      const res = await request(app).get(ONE).set(as()).set('Accept', accept);
      expect([accept, res.status, res.headers['content-type']]).toEqual([accept, 200, expect.stringMatching(/^application\/json/)]);
      expect(res.body.data).toEqual(expected);
    }
  });
});

describe('ids', () => {
  const notFound = [
    'GENERIC-IMRAD', 'Generic-Imrad', 'generic-imrad%0A', 'generic-imrad%20', '%20generic-imrad', 'generic-imrad%00',
    '__proto__', 'constructor', 'hasOwnProperty', 'toString', 'prototype', 'length', '0',
    'generic-imrad%2F..', '..%2Fgeneric-imrad', '%2e%2e', '%2E%2E%2Fprojects', '%252e%252e', 'generic%2Dimrad%25',
    '%E2%80%8Bgeneric-imrad', '%C3%A9', '%F0%9F%98%80', 'x'.repeat(200), 'x'.repeat(201), 'x'.repeat(5000),
    'generic-imrad;x', 'generic-imrad.json',
  ];
  it.each(notFound)('%s is 404 JOURNAL_PROFILE_NOT_FOUND', async (id) => {
    const res = await request(app).get(`/api/journal-profiles/${id}`).set(as());
    expect([res.status, res.body.error?.code]).toEqual([404, 'JOURNAL_PROFILE_NOT_FOUND']);
    expectNoLeak(res.body);
  });

  it('percent-encoded letters of the real id resolve to the real profile (decoding is consistent)', async () => {
    const res = await request(app).get('/api/journal-profiles/generic%2Dimrad').set(as());
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('generic-imrad');
  });

  it('%2e%2e%2f traversal to another route is not followed', async () => {
    const res = await request(app).get('/api/journal-profiles/%2e%2e%2fhealth').set(as());
    expect(res.status).toBe(404);
  });

  it.each(['%ZZ', '%', '%E0%A4%A', '%C0%AF', '%ED%A0%80'])('malformed escape %s gives 400 or 404, never 500, without leaks', async (id) => {
    const res = await request(app).get(`/api/journal-profiles/${id}`).set(as());
    expect([400, 404]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expectNoLeak(res.body);
  });

  it('a very long URL does not crash the server', async () => {
    const res = await request(app).get(`/api/journal-profiles/${'a'.repeat(60_000)}`).set(as());
    expect([404, 414, 431]).toContain(res.status);
  });
});

describe('response', () => {
  it('list and item have exactly the envelope keys and the profile keys, nothing else', async () => {
    const list = await request(app).get(LIST).set(as());
    expect(Object.keys(list.body).sort()).toEqual(['data', 'success']);
    const one = await request(app).get(ONE).set(as());
    expect(Object.keys(one.body).sort()).toEqual(['data', 'success']);
    expect(Object.keys(one.body.data).sort()).toEqual(['articleType', 'citationStyle', 'id', 'journal', 'language', 'name', 'notice', 'sections', 'verification', 'version', 'wordBudgetSource']);
    expect(Object.keys(one.body.data.verification).sort()).toEqual(['policySourceUrls', 'status', 'verifiedAt', 'verifiedBy']);
    for (const s of one.body.data.sections) expect(Object.keys(s).sort()).toEqual(['generator', 'key', 'order', 'purpose', 'required', 'sources', 'title', 'wordBudget']);
    expect(list.body.data[0]).toEqual(one.body.data);
  });

  it('the response never reports the default profile as verified or as journal policy', async () => {
    const one = (await request(app).get(ONE).set(as())).body.data;
    expect(one.verification).toEqual({ status: 'unverified', verifiedAt: null, verifiedBy: null, policySourceUrls: [] });
    expect(one.wordBudgetSource).toBe('suggested_default');
    expect(one.notice).toMatch(/not verified/i);
  });

  it('the response is identical across users and repeated calls', async () => {
    const a = await request(app).get(ONE).set(as('u1'));
    const b = await request(app).get(ONE).set(as('u2'));
    const c = await request(app).get(ONE).set(as('u1'));
    expect(a.text).toBe(b.text);
    expect(a.text).toBe(c.text);
  });

  it('helmet headers are present and x-powered-by is gone', async () => {
    const res = await request(app).get(ONE).set(as());
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('a 404 body carries only code, message and requestId', async () => {
    const res = await request(app).get('/api/journal-profiles/nope').set(as());
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message', 'requestId']);
  });
});

describe('caching', () => {
  it('ETag revalidation: 304 only for the exact current representation', async () => {
    const first = await request(app).get(ONE).set(as());
    const etag = first.headers.etag;
    if (etag) {
      expect((await request(app).get(ONE).set(as()).set('If-None-Match', etag)).status).toBe(304);
      expect((await request(app).get(ONE).set(as()).set('If-None-Match', 'W/"stale"')).status).toBe(200);
    }
  });

  it('an authenticated response is not marked publicly cacheable', async () => {
    const res = await request(app).get(ONE).set(as());
    expect(res.headers['cache-control'] ?? '').not.toMatch(/public/);
  });

  it('a 304 is never sent to an unauthenticated caller holding a valid ETag', async () => {
    const etag = (await request(app).get(ONE).set(as())).headers.etag;
    env.DEV_AUTH_ENABLED = false;
    const res = await request(app).get(ONE).set('If-None-Match', etag ?? '*');
    expect(res.status).toBe(401);
  });
});

describe('OpenAPI matches behaviour', () => {
  const paths = openApiDocument.paths as Record<string, any>;
  it('documents GET only, and the status codes the routes really return', async () => {
    expect(Object.keys(paths['/api/journal-profiles'])).toEqual(['get']);
    expect(Object.keys(paths['/api/journal-profiles/{profileId}'])).toEqual(['get']);
    expect(Object.keys(paths['/api/journal-profiles'].get.responses).sort()).toEqual(['200', '401']);
    expect(Object.keys(paths['/api/journal-profiles/{profileId}'].get.responses).sort()).toEqual(['200', '401', '404']);
    expect((await request(app).get(ONE).set(as())).status).toBe(200);
    expect((await request(app).get('/api/journal-profiles/nope').set(as())).status).toBe(404);
  });
  // Not documenting the generic 400 for a malformed escape is the project-wide convention (no route documents it).
  it('a malformed escape gives the generic 400 BAD_REQUEST', async () => {
    const res = await request(app).get('/api/journal-profiles/%ZZ').set(as());
    expect([res.status, res.body.error.code]).toEqual([400, 'BAD_REQUEST']);
  });
});

describe('performance', () => {
  it('500 sequential GETs of the list finish in reasonable time', async () => {
    const t0 = performance.now();
    for (let i = 0; i < 500; i += 1) await request(app).get(LIST).set(as());
    expect(performance.now() - t0).toBeLessThan(20_000);
  });
});
