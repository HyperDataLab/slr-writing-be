import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/projects/projects.service.js', () => ({
  getOwnedProject: vi.fn().mockImplementation((userId: string, projectId: string) => {
    return Promise.resolve({ id: projectId, ownerId: userId, name: 'Test Project', slrProjectId: 'slr-1' });
  }),
}));

import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';

const app = createApp();
const as = (uid: string) => ({ 'X-Dev-User-Id': uid });

afterEach(() => {
  env.DEV_AUTH_ENABLED = true;
});

describe('Evidence API', () => {
  const projectId = '00000000-0000-0000-0000-000000000001';
  const snapshotId = '00000000-0000-0000-0000-000000000002';

  describe('Authentication and Parameter Guarding', () => {
    it('requires authentication for listing evidence', async () => {
      env.DEV_AUTH_ENABLED = false;
      const res = await request(app).get(`/api/projects/${projectId}/snapshots/${snapshotId}/evidence`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('requires authentication for getting evidence by id', async () => {
      env.DEV_AUTH_ENABLED = false;
      const res = await request(app).get(`/api/projects/${projectId}/snapshots/${snapshotId}/evidence/ev-1`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects query with invalid page number (page=0)', async () => {
      const res = await request(app)
        .get(`/api/projects/${projectId}/snapshots/${snapshotId}/evidence?page=0`)
        .set(as('alice'));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects query with excessive limit (limit=999)', async () => {
      const res = await request(app)
        .get(`/api/projects/${projectId}/snapshots/${snapshotId}/evidence?limit=999`)
        .set(as('alice'));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects query with unstorable characters in search', async () => {
      const res = await request(app)
        .get(`/api/projects/${projectId}/snapshots/${snapshotId}/evidence?search=test%00invalid`)
        .set(as('alice'));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid verified parameter value (not true/false)', async () => {
      const res = await request(app)
        .get(`/api/projects/${projectId}/snapshots/${snapshotId}/evidence?verified=maybe`)
        .set(as('alice'));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

