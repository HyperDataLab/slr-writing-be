import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/config/prisma.js';
import { importSnapshot } from '../../src/modules/snapshots/snapshot-import.service.js';
import { FakeSlrBe } from '../slr-client/fake-slr-be.js';

// Integration test: needs PostgreSQL. Uses the run exported from real slr-be and a fake slr-be for role checks.
const app = createApp();
const fake = new FakeSlrBe();
const tag = `pp-${Date.now()}`;
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
  env.REQUIRE_SLR_OWNER_FOR_APPROVAL = false;
  await fake.stop();
  await prisma.$disconnect();
});

beforeEach(() => fake.reset());
afterEach(() => {
  env.DEV_AUTH_ENABLED = true;
  env.REQUIRE_SLR_OWNER_FOR_APPROVAL = false;
});

async function setup(uid = alice) {
  const slrProjectId = `${tag}-slr-${counter++}`;
  const project = await prisma.project.create({ data: { name: slrProjectId, ownerId: uid, slrProjectId } });
  const raw = real();
  raw.run.project_id = slrProjectId;
  raw.corpus.project_id = slrProjectId;
  raw.supplements.prisma_writing_export.project.id = slrProjectId;
  const { snapshot } = await importSnapshot({ projectId: project.id, importedBy: uid, input: raw, source: 'slr-be' });
  return { project, snapshot, slrProjectId };
}

const bpBase = (projectId: string, snapshotId: string) =>
  `/api/projects/${projectId}/snapshots/${snapshotId}/manuscript/blueprint`;
const ppBase = (projectId: string, snapshotId: string) =>
  `/api/projects/${projectId}/snapshots/${snapshotId}/manuscript/paragraph-plans`;

const createBlueprint = (p: string, s: string, uid = alice) =>
  request(app).post(bpBase(p, s)).set(as(uid)).send({});
const approveBlueprint = (p: string, s: string, version: number, uid = alice) =>
  request(app).post(`${bpBase(p, s)}/approve`).set(as(uid)).send({ version });

const createPlans = (p: string, s: string, uid = alice) =>
  request(app).post(ppBase(p, s)).set(as(uid)).send({});
const getPlans = (p: string, s: string, uid = alice) =>
  request(app).get(ppBase(p, s)).set(as(uid));
const putPlans = (p: string, s: string, body: object, uid = alice) =>
  request(app).put(ppBase(p, s)).set(as(uid)).send(body);
const getRevision = (p: string, s: string, version: string | number, uid = alice) =>
  request(app).get(`${ppBase(p, s)}/revisions/${version}`).set(as(uid));

/** Sets up a project with an approved blueprint (H1) ready for paragraph planning. */
async function readyWithApprovedBlueprint() {
  const s = await setup();
  await createBlueprint(s.project.id, s.snapshot.id);
  const approveRes = await approveBlueprint(s.project.id, s.snapshot.id, 1);
  expect(approveRes.status).toBe(201);
  return s;
}

describe('Paragraph Plans API', () => {
  describe('Prerequisite checks (H1 Approval)', () => {
    it('refuses to create paragraph plans when manuscript has no blueprint (404)', async () => {
      const { project, snapshot } = await setup();
      const res = await createPlans(project.id, snapshot.id);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MANUSCRIPT_NOT_FOUND');
    });

    it('refuses to create paragraph plans when blueprint is not approved (422 BLUEPRINT_NOT_APPROVED)', async () => {
      const { project, snapshot } = await setup();
      await createBlueprint(project.id, snapshot.id);
      const res = await createPlans(project.id, snapshot.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BLUEPRINT_NOT_APPROVED');
    });
  });

  describe('Creating paragraph plans', () => {
    it('creates version 1 from the approved blueprint and snapshot (201)', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      const res = await createPlans(project.id, snapshot.id);
      expect(res.status).toBe(201);
      const { revision, created } = res.body.data;
      expect(created).toBe(true);
      expect(revision.version).toBe(1);
      expect(revision.origin).toBe('generated');
      expect(revision.createdBy).toBe(alice);
      expect(revision.totalParagraphs).toBeGreaterThan(0);
      expect(Array.isArray(revision.content.plans)).toBe(true);

      // Provenance event is recorded
      const event = await prisma.provenanceEvent.findFirst({
        where: { projectId: project.id, activity: 'manuscript.paragraph_plan.generate' },
      });
      expect(event).not.toBeNull();
      expect(event?.actor).toBe(alice);
    });

    it('is idempotent: a second call returns existing version (200, created: false)', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      const first = await createPlans(project.id, snapshot.id);
      expect(first.status).toBe(201);
      const second = await createPlans(project.id, snapshot.id);
      expect(second.status).toBe(200);
      expect(second.body.data.created).toBe(false);
      expect(second.body.data.revision.id).toBe(first.body.data.revision.id);
    });
  });

  describe('Reading paragraph plans', () => {
    it('returns 404 PARAGRAPH_PLANS_NOT_FOUND before plans are generated', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      const res = await getPlans(project.id, snapshot.id);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PARAGRAPH_PLANS_NOT_FOUND');
    });

    it('returns latest plans view with issues, stats and version list (200)', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      await createPlans(project.id, snapshot.id);
      const res = await getPlans(project.id, snapshot.id);
      expect(res.status).toBe(200);
      const view = res.body.data;
      expect(view.revision.version).toBe(1);
      expect(view.stats.totalParagraphs).toBeGreaterThan(0);
      expect(Array.isArray(view.issues)).toBe(true);
      expect(typeof view.readyToDraft).toBe('boolean');
      expect(view.versions).toHaveLength(1);
    });

    it('reads a specific revision via /revisions/:version', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      await createPlans(project.id, snapshot.id);
      const res = await getRevision(project.id, snapshot.id, 1);
      expect(res.status).toBe(200);
      expect(res.body.data.revision.version).toBe(1);
    });

    it('rejects invalid version numbers with 400 INVALID_VERSION', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      await createPlans(project.id, snapshot.id);
      const res = await getRevision(project.id, snapshot.id, '0');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_VERSION');
    });
  });

  describe('Editing paragraph plans', () => {
    it('saves a valid edit as version 2 (201)', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      const first = await createPlans(project.id, snapshot.id);
      const content = structuredClone(first.body.data.revision.content);

      // Modify the first plan
      content.plans[0].limitations = ['Added note by researcher'];

      const editRes = await putPlans(project.id, snapshot.id, { baseVersion: 1, content });
      expect(editRes.status).toBe(201);
      expect(editRes.body.data.created).toBe(true);
      expect(editRes.body.data.revision.version).toBe(2);
      expect(editRes.body.data.revision.origin).toBe('edited');

      // GET now returns version 2 as latest with 2 versions in history
      const latestRes = await getPlans(project.id, snapshot.id);
      expect(latestRes.body.data.revision.version).toBe(2);
      expect(latestRes.body.data.versions).toHaveLength(2);
    });

    it('returns 200 unchanged when saving identical content', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      const first = await createPlans(project.id, snapshot.id);
      const content = structuredClone(first.body.data.revision.content);

      const res = await putPlans(project.id, snapshot.id, { baseVersion: 1, content });
      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(false);
      expect(res.body.data.revision.version).toBe(1);
    });

    it('refuses edit with stale baseVersion (409 STALE_PLAN)', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      const first = await createPlans(project.id, snapshot.id);
      const content = structuredClone(first.body.data.revision.content);

      // Try editing with baseVersion 99
      const res = await putPlans(project.id, snapshot.id, { baseVersion: 99, content });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('STALE_PLAN');
    });

    it('refuses malformed content with 400 INVALID_PARAGRAPH_PLANS', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      await createPlans(project.id, snapshot.id);
      const res = await putPlans(project.id, snapshot.id, {
        baseVersion: 1,
        content: { blueprintVersion: 1, plans: 'not an array' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PARAGRAPH_PLANS');
    });
  });

  describe('Access control and isolation', () => {
    it('returns 404 when another user tries to access alice plans', async () => {
      const { project, snapshot } = await readyWithApprovedBlueprint();
      await createPlans(project.id, snapshot.id, alice);

      const bobGet = await getPlans(project.id, snapshot.id, bob);
      expect(bobGet.status).toBe(404);
      expect(bobGet.body.error.code).toBe('PROJECT_NOT_FOUND');

      const bobCreate = await createPlans(project.id, snapshot.id, bob);
      expect(bobCreate.status).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
      env.DEV_AUTH_ENABLED = false;
      const { project, snapshot } = await setup();
      const res = await request(app).get(ppBase(project.id, snapshot.id));
      expect(res.status).toBe(401);
    });
  });
});

