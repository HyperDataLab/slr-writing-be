import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/config/prisma.js';
import { importSnapshot } from '../../src/modules/snapshots/snapshot-import.service.js';
import { FakeSlrBe } from '../slr-client/fake-slr-be.js';

const app = createApp();
const fake = new FakeSlrBe();
const tag = `slr-runs-${Date.now()}`;
const alice = `${tag}-alice`;
const bob = `${tag}-bob`;
let counter = 0;
const as = (uid: string) => ({ 'X-Dev-User-Id': uid });
const real = () => JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));
const originalBase = env.SLR_API_BASE_URL;

beforeAll(async () => {
  await fake.start();
  env.SLR_API_BASE_URL = fake.baseUrl;
});
afterAll(async () => {
  env.SLR_API_BASE_URL = originalBase;
  await fake.stop();
  await prisma.$disconnect();
});
beforeEach(() => fake.reset());

const art = (type: string, review_status: string) => ({ artifact_type: type, artifact_id: `${type}-id`, content_hash: 'h', review_status, validation_status: 'valid' });
const listPath = (slr: string) => `/api/projects/${slr}/synthesis/artifacts/runs`;
const wrap = (data: unknown) => ({ success: true, isSuccess: true, data, message: 'ok' });

async function newProject(uid = alice) {
  const slrProjectId = `${tag}-slr-${counter++}`;
  const project = await prisma.project.create({ data: { name: `P ${slrProjectId}`, ownerId: uid, slrProjectId } });
  return { project, slrProjectId };
}

describe('GET /projects/:projectId/slr-runs', () => {
  it('lists the runs with MVP artifact review state, newest first, forwarding the caller token', async () => {
    const { project, slrProjectId } = await newProject();
    fake.json(listPath(slrProjectId), wrap([
      { run_id: 'run-2', generated_at: '2026-11-02T10:00:00Z', generated_by: 'u1', corpus_hash: 'c2', artifacts: [art('A1', 'approved'), art('A2', 'approved'), art('A7', 'approved'), art('A10', 'approved'), art('A3', 'unreviewed')] },
      { run_id: 'run-1', generated_at: '2026-11-01T10:00:00Z', generated_by: null, corpus_hash: 'c1', artifacts: [art('A1', 'approved'), art('A10', 'needs_human_review')] },
    ]));

    const res = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(alice)).set('Authorization', 'Bearer dev-token');

    expect(res.status).toBe(200);
    const [first, second] = res.body.data;
    expect(first.runId).toBe('run-2');
    expect(first.importable).toBe(true);
    expect(first.complete).toBe(true);
    expect(first.mvpArtifacts).toEqual({ A1: 'approved', A2: 'approved', A7: 'approved', A10: 'approved' });
    expect(second.importable).toBe(false);
    expect(second.complete).toBe(false);
    expect(second.mvpArtifacts).toEqual({ A1: 'approved', A2: 'missing', A7: 'missing', A10: 'needs_human_review' });
    expect(second.generatedBy).toBeNull();
    expect(fake.requests.at(-1)?.authorization).toBe('Bearer dev-token');
  });

  it('marks runs that were already imported as snapshots of this project', async () => {
    const { project, slrProjectId } = await newProject();
    const raw = real();
    raw.run.project_id = slrProjectId;
    raw.corpus.project_id = slrProjectId;
    raw.supplements.prisma_writing_export.project.id = slrProjectId;
    const { snapshot } = await importSnapshot({ projectId: project.id, importedBy: alice, input: raw, source: 'slr-be' });
    fake.json(listPath(slrProjectId), wrap([
      { run_id: raw.run.run_id, generated_at: '2026-11-01T10:00:00Z', corpus_hash: 'c1', artifacts: [art('A1', 'approved')] },
      { run_id: 'run-other', generated_at: '2026-10-01T10:00:00Z', corpus_hash: 'c0', artifacts: [] },
    ]));

    const res = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(alice));

    expect(res.body.data[0].snapshots).toEqual([{ id: snapshot.id, status: snapshot.status }]);
    expect(res.body.data[1].snapshots).toEqual([]);
  });

  it('hides a project that belongs to someone else (404) without calling slr-be', async () => {
    const { project } = await newProject(alice);
    const res = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(bob));
    expect(res.status).toBe(404);
    expect(fake.requests).toHaveLength(0);
  });

  it('does not pass on an incomplete run entry as if it were valid', async () => {
    const { project, slrProjectId } = await newProject();
    fake.json(listPath(slrProjectId), wrap([{ run_id: 'run-1' }]));
    const res = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(alice));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('reports slr-be access problems with the existing upstream error codes', async () => {
    const { project, slrProjectId } = await newProject();
    fake.json(listPath(slrProjectId), { success: false, message: 'forbidden' }, 403);
    const res = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(alice));
    expect(res.status).toBe(403);
  });

  it('treats a run as importable with A1 and A10 approved even when A2 and A7 are not (what readiness requires)', async () => {
    const { project, slrProjectId } = await newProject();
    fake.json(listPath(slrProjectId), wrap([
      { run_id: 'run-1', generated_at: '2026-11-01T10:00:00Z', corpus_hash: 'c1', artifacts: [art('A1', 'approved'), art('A10', 'approved'), art('A7', 'unreviewed')] },
    ]));
    const res = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(alice));
    expect(res.body.data[0]).toMatchObject({ importable: true, complete: false });
  });

  it('accepts a bare array without the slr-be envelope', async () => {
    const { project, slrProjectId } = await newProject();
    fake.json(listPath(slrProjectId), [{ run_id: 'run-1', generated_at: '2026-11-01T10:00:00Z', corpus_hash: 'c1', artifacts: [] }]);
    const res = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(alice));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('skips a run it does not understand instead of failing the whole list', async () => {
    const { project, slrProjectId } = await newProject();
    fake.json(listPath(slrProjectId), wrap([
      { run_id: 'run-odd', generated_at: '2026-11-02T10:00:00Z', corpus_hash: 'c2', artifacts: [{ artifact_type: 'A1', review_status: 'a-new-status', validation_status: 'valid' }] },
      { run_id: 'run-ok', generated_at: '2026-11-01T10:00:00Z', corpus_hash: 'c1', artifacts: [art('A1', 'approved')] },
    ]));
    const res = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(alice));
    expect(res.status).toBe(200);
    expect(res.body.data.map((run: { runId: string }) => run.runId)).toEqual(['run-ok']);
  });

  it('answers 502 when slr-be does not return a list', async () => {
    const { project, slrProjectId } = await newProject();
    fake.json(listPath(slrProjectId), wrap({ not: 'a list' }));
    const res = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(alice));
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SLR_INVALID_RESPONSE');
  });

  it('passes on a rejected token as 401 and an unreachable slr-be as 502', async () => {
    const { project, slrProjectId } = await newProject();
    fake.json(listPath(slrProjectId), { success: false, message: 'no' }, 401);
    const rejected = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(alice));
    expect(rejected.status).toBe(401);
    expect(rejected.body.error.code).toBe('SLR_AUTH_REJECTED');

    const originalBase = env.SLR_API_BASE_URL;
    env.SLR_API_BASE_URL = 'http://127.0.0.1:1';
    try {
      const down = await request(app).get(`/api/projects/${project.id}/slr-runs`).set(as(alice));
      expect(down.status).toBe(502);
      expect(down.body.error.code).toBe('SLR_UNREACHABLE');
    } finally {
      env.SLR_API_BASE_URL = originalBase;
    }
  });

  it('requires authentication', async () => {
    const { project } = await newProject();
    const previous = env.DEV_AUTH_ENABLED;
    env.DEV_AUTH_ENABLED = false;
    try {
      const res = await request(app).get(`/api/projects/${project.id}/slr-runs`);
      expect(res.status).toBe(401);
    } finally {
      env.DEV_AUTH_ENABLED = previous;
    }
  });
});
