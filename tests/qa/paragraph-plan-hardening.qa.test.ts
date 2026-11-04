import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/config/prisma.js';
import { importSnapshot } from '../../src/modules/snapshots/snapshot-import.service.js';
import { FakeSlrBe } from '../slr-client/fake-slr-be.js';

// Adversarial QA test: Concurrency, append-only trigger enforcement, parameter injection, DoS protection.
const app = createApp();
const fake = new FakeSlrBe();
const tag = `pp-qa-${Date.now()}`;
const alice = `${tag}-alice`;
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

async function setup() {
  const slrProjectId = `${tag}-slr-${counter++}`;
  const project = await prisma.project.create({ data: { name: slrProjectId, ownerId: alice, slrProjectId } });
  const raw = real();
  raw.run.project_id = slrProjectId;
  raw.corpus.project_id = slrProjectId;
  raw.supplements.prisma_writing_export.project.id = slrProjectId;
  const { snapshot } = await importSnapshot({ projectId: project.id, importedBy: alice, input: raw, source: 'slr-be' });
  await request(app)
    .post(`/api/projects/${project.id}/snapshots/${snapshot.id}/manuscript/blueprint`)
    .set(as(alice))
    .send({});
  await request(app)
    .post(`/api/projects/${project.id}/snapshots/${snapshot.id}/manuscript/blueprint/approve`)
    .set(as(alice))
    .send({ version: 1 });
  return { project, snapshot };
}

const ppBase = (p: string, s: string) => `/api/projects/${p}/snapshots/${s}/manuscript/paragraph-plans`;

describe('ParagraphPlan Hardening & Invariants', () => {
  describe('Concurrency & Race Invariants', () => {
    it('20 parallel create calls on a fresh snapshot: no 5xx, exactly one 201, one version, one provenance event', async () => {
      const { project, snapshot } = await setup();
      const calls = Array.from({ length: 20 }, () =>
        request(app).post(ppBase(project.id, snapshot.id)).set(as(alice)).send({}),
      );
      const responses = await Promise.all(calls);

      const statuses = responses.map((r) => r.status);
      expect(statuses.every((s) => s === 200 || s === 201)).toBe(true);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(19);

      // Verify DB row count
      const revisions = await prisma.paragraphPlanRevision.findMany({
        where: { manuscript: { snapshotId: snapshot.id } },
      });
      expect(revisions).toHaveLength(1);

      // Verify ProvenanceEvent count
      const events = await prisma.provenanceEvent.findMany({
        where: { projectId: project.id, activity: 'manuscript.paragraph_plan.generate' },
      });
      expect(events).toHaveLength(1);
    });

    it('20 concurrent edits with the same baseVersion: exactly one succeeds (201), rest rejected with 409', async () => {
      const { project, snapshot } = await setup();
      const first = await request(app).post(ppBase(project.id, snapshot.id)).set(as(alice)).send({});
      expect(first.status).toBe(201);
      const content = structuredClone(first.body.data.revision.content);

      const calls = Array.from({ length: 20 }, (_, i) => {
        const c = structuredClone(content);
        c.plans[0].limitations = [`Edit attempt ${i}`];
        return request(app).put(ppBase(project.id, snapshot.id)).set(as(alice)).send({ baseVersion: 1, content: c });
      });

      const responses = await Promise.all(calls);
      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    });
  });

  describe('PostgreSQL Append-Only Protection (Triggers)', () => {
    it('raw UPDATE, DELETE and TRUNCATE are blocked on ParagraphPlanRevision', async () => {
      const { project, snapshot } = await setup();
      const res = await request(app).post(ppBase(project.id, snapshot.id)).set(as(alice)).send({});
      const revId = res.body.data.revision.id;

      // UPDATE via raw SQL is rejected by trigger
      await expect(
        prisma.$executeRaw`UPDATE "ParagraphPlanRevision" SET "origin" = 'hacked' WHERE "id" = ${revId}`,
      ).rejects.toThrow(/append-only/i);

      // DELETE via raw SQL is rejected by trigger
      await expect(
        prisma.$executeRaw`DELETE FROM "ParagraphPlanRevision" WHERE "id" = ${revId}`,
      ).rejects.toThrow(/append-only/i);

      // TRUNCATE is rejected by trigger
      await expect(
        prisma.$executeRaw`TRUNCATE TABLE "ParagraphPlanRevision"`,
      ).rejects.toThrow(/append-only/i);
    });

    it('deleting Manuscript or BlueprintRevision is blocked by foreign key while plan exists', async () => {
      const { project, snapshot } = await setup();
      await request(app).post(ppBase(project.id, snapshot.id)).set(as(alice)).send({});

      const manuscript = await prisma.manuscript.findUnique({ where: { snapshotId: snapshot.id } });
      expect(manuscript).not.toBeNull();

      // Deleting manuscript blocked
      await expect(
        prisma.manuscript.delete({ where: { id: manuscript!.id } }),
      ).rejects.toThrow();

      // Deleting blueprint revision blocked
      const bp = await prisma.blueprintRevision.findFirst({ where: { manuscriptId: manuscript!.id } });
      await expect(
        prisma.blueprintRevision.delete({ where: { id: bp!.id } }),
      ).rejects.toThrow();
    });
  });

  describe('Parameter Guard & DoS Shapes', () => {
    it('rejects malformed percent-escape in version segment without 500', async () => {
      const { project, snapshot } = await setup();
      await request(app).post(ppBase(project.id, snapshot.id)).set(as(alice)).send({});

      const res = await request(app)
        .get(`${ppBase(project.id, snapshot.id)}/revisions/%ZZ`)
        .set(as(alice));
      expect(res.status).toBe(400);
    });

    it('rejects body with unstorable text (NUL byte) with 400', async () => {
      const { project, snapshot } = await setup();
      const first = await request(app).post(ppBase(project.id, snapshot.id)).set(as(alice)).send({});
      const content = structuredClone(first.body.data.revision.content);
      content.plans[0].limitations = ['Note with NUL \u0000 byte'];

      const res = await request(app)
        .put(ppBase(project.id, snapshot.id))
        .set(as(alice))
        .send({ baseVersion: 1, content });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PARAGRAPH_PLANS');
    });

    it('rejects excessively large payload before zod parsing', async () => {
      const { project, snapshot } = await setup();
      await request(app).post(ppBase(project.id, snapshot.id)).set(as(alice)).send({});

      // Create an object with excessive nodes
      const hugeObject: any = { blueprintVersion: 1, plans: [] };
      let curr = hugeObject;
      for (let i = 0; i < 70; i++) {
        curr.child = {};
        curr = curr.child;
      }

      const res = await request(app)
        .put(ppBase(project.id, snapshot.id))
        .set(as(alice))
        .send({ baseVersion: 1, content: hugeObject });
      expect(res.status).toBe(400);
    });
  });
});

