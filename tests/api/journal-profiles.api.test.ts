import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { DEFAULT_JOURNAL_PROFILE } from '../../src/modules/journal-profiles/default-profile.js';

const app = createApp();
const as = (uid: string) => ({ 'X-Dev-User-Id': uid });

afterEach(() => { env.DEV_AUTH_ENABLED = true; });

describe('GET /api/journal-profiles', () => {
  it('lists the default profile with its unverified status and notice', async () => {
    const res = await request(app).get('/api/journal-profiles').set(as('alice'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual(JSON.parse(JSON.stringify(DEFAULT_JOURNAL_PROFILE)));
    expect(res.body.data[0].verification.status).toBe('unverified');
    expect(res.body.data[0].notice).toMatch(/not verified/i);
  });

  it('requires authentication', async () => {
    env.DEV_AUTH_ENABLED = false;
    const res = await request(app).get('/api/journal-profiles');
    expect([res.status, res.body.error.code]).toEqual([401, 'UNAUTHORIZED']);
  });

  it('gives every signed-in user the same profiles', async () => {
    const a = await request(app).get('/api/journal-profiles').set(as('alice'));
    const b = await request(app).get('/api/journal-profiles').set(as('bob'));
    expect(a.body.data).toEqual(b.body.data);
  });
});

describe('GET /api/journal-profiles/:profileId', () => {
  it('returns the profile with sections in manuscript order', async () => {
    const res = await request(app).get('/api/journal-profiles/generic-imrad').set(as('alice'));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('generic-imrad');
    expect(res.body.data.sections.map((section: { key: string }) => section.key)).toEqual(['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusion']);
    expect(res.body.data.sections.find((section: { key: string }) => section.key === 'methods').generator).toBe('methods-template@1');
  });

  it.each(['unknown', 'GENERIC-IMRAD', '__proto__', 'constructor', 'generic-imrad%20', '%00', 'x'.repeat(201)])('answers 404 JOURNAL_PROFILE_NOT_FOUND for %s', async (id) => {
    const res = await request(app).get(`/api/journal-profiles/${id}`).set(as('alice'));
    expect([res.status, res.body.error.code]).toEqual([404, 'JOURNAL_PROFILE_NOT_FOUND']);
  });

  it('answers 400 for a malformed percent-escape, not 500', async () => {
    const res = await request(app).get('/api/journal-profiles/%ZZ').set(as('alice'));
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    env.DEV_AUTH_ENABLED = false;
    expect((await request(app).get('/api/journal-profiles/generic-imrad')).status).toBe(401);
  });

  it('does not change under any method other than GET', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/api/journal-profiles/generic-imrad').set(as('alice')).send({ verification: { status: 'verified' } });
      expect(res.status, method).toBe(404);
    }
    const after = await request(app).get('/api/journal-profiles/generic-imrad').set(as('alice'));
    expect(after.body.data.verification.status).toBe('unverified');
  });
});

describe('documentation', () => {
  it('lists both routes in the OpenAPI document', async () => {
    const res = await request(app).get('/api-docs.json');
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(['/api/journal-profiles', '/api/journal-profiles/{profileId}']));
  });
});
