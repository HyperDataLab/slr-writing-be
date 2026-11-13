import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { FakeSlrBe } from '../slr-client/fake-slr-be.js';

const app = createApp();
const fakeSlr = new FakeSlrBe();
const as = (uid: string) => ({ 'X-Dev-User-Id': uid, authorization: `Bearer token-${uid}` });

let originalBaseUrl: string;

beforeAll(async () => {
  await fakeSlr.start();
  originalBaseUrl = env.SLR_API_BASE_URL;
  env.SLR_API_BASE_URL = fakeSlr.baseUrl;
});

afterAll(async () => {
  env.SLR_API_BASE_URL = originalBaseUrl;
  await fakeSlr.stop();
});

afterEach(() => {
  fakeSlr.reset();
  env.DEV_AUTH_ENABLED = true;
});

describe('SLR Discovery API', () => {
  describe('GET /api/slr/projects', () => {
    it('requires authentication', async () => {
      env.DEV_AUTH_ENABLED = false;
      const res = await request(app).get('/api/slr/projects');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns project list from upstream slr-be', async () => {
      fakeSlr.json('/api/projects', {
        success: true,
        data: {
          items: [
            { id: 'proj-1', name: 'Software Architecture SLR' },
            { id: 'proj-2', name: 'Cloud Computing SLR' },
          ],
          pageNumber: 1,
          pageSize: 10,
          totalCount: 2,
          totalPages: 1,
        },
      });

      const res = await request(app).get('/api/slr/projects?search=cloud&pageNumber=1&pageSize=10').set(as('alice'));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.items[0].name).toBe('Software Architecture SLR');

      // Verify token forwarding
      expect(fakeSlr.requests[0].authorization).toBe('Bearer token-alice');
    });

    it('rejects unstorable characters in search query with 400', async () => {
      const res = await request(app).get('/api/slr/projects?search=bad%00text').set(as('alice'));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/slr/projects/:projectId/runs', () => {
    it('returns runs list from upstream slr-be', async () => {
      fakeSlr.json('/api/projects/proj-100/synthesis/artifacts/runs', {
        success: true,
        data: [
          {
            run_id: 'run-001',
            generated_at: '2026-11-01T10:00:00Z',
            generated_by: 'leader_user',
            corpus_hash: 'hash-abc',
            artifacts: [
              { artifact_type: 'A1', review_status: 'approved', validation_status: 'valid' },
              { artifact_type: 'A10', review_status: 'approved', validation_status: 'valid' },
            ],
          },
        ],
      });

      const res = await request(app).get('/api/slr/projects/proj-100/runs').set(as('alice'));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].run_id).toBe('run-001');
    });

    it('returns 404 if project does not exist on slr-be', async () => {
      fakeSlr.json('/api/projects/proj-999/synthesis/artifacts/runs', { success: false, message: 'Not found' }, 404);

      const res = await request(app).get('/api/slr/projects/proj-999/runs').set(as('alice'));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SLR_NOT_FOUND');
    });
  });
});
