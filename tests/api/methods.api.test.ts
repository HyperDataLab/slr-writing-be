import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/config/prisma.js';
import { importSnapshot } from '../../src/modules/snapshots/snapshot-import.service.js';

// Integration test: needs PostgreSQL with migrations applied. Uses the run exported from a real slr-be.
const app = createApp();
const tag = `methods-${Date.now()}`;
const alice = `${tag}-alice`;
const bob = `${tag}-bob`;
let counter = 0;
const as = (uid: string) => ({ 'X-Dev-User-Id': uid });
const real = () => JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));

afterAll(() => prisma.$disconnect());

/** A project owned by `uid` with the real run stored as a snapshot. */
async function setup(uid = alice, mutate?: (raw: any) => void) {
  const slrProjectId = `${tag}-slr-${counter++}`;
  const project = await prisma.project.create({ data: { name: slrProjectId, ownerId: uid, slrProjectId } });
  const raw = real();
  raw.run.project_id = slrProjectId;
  raw.corpus.project_id = slrProjectId;
  raw.supplements.prisma_writing_export.project.id = slrProjectId;
  mutate?.(raw);
  const { snapshot } = await importSnapshot({ projectId: project.id, importedBy: uid, input: raw, source: 'slr-be' });
  return { project, snapshot };
}
const base = (projectId: string, snapshotId: string) => `/api/projects/${projectId}/snapshots/${snapshotId}/manuscript/methods`;
const generate = (projectId: string, snapshotId: string, uid = alice) => request(app).post(base(projectId, snapshotId)).set(as(uid));

describe('POST .../manuscript/methods', () => {
  it('writes Methods from the snapshot as version 1 (201) and keeps the facts and warnings with it', async () => {
    const { project, snapshot } = await setup();
    const res = await generate(project.id, snapshot.id);
    expect(res.status).toBe(201);
    const { revision, created } = res.body.data;
    expect(created).toBe(true);
    expect(revision).toMatchObject({ version: 1, generator: 'methods-template@1', createdBy: alice });
    expect(revision.markdown).toContain('## Methods');
    expect(revision.markdown).toContain('A total of 6 records were screened');
    expect(revision.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(revision.facts.find((fact: any) => fact.key === 'prisma.screened')).toMatchObject({ status: 'explicit', value: 6 });
    const codes = revision.warnings.map((w: any) => w.code);
    expect(codes).toContain('FACT_MISSING');
    expect(revision.warnings.find((w: any) => w.ref === 'search.sources')).toBeTruthy();
  });

  it('answers 200 with the same version when nothing changed, and stores no new row', async () => {
    const { project, snapshot } = await setup();
    const first = await generate(project.id, snapshot.id);
    const second = await generate(project.id, snapshot.id);
    expect(second.status).toBe(200);
    expect(second.body.data.created).toBe(false);
    expect(second.body.data.revision.id).toBe(first.body.data.revision.id);
    expect(await prisma.sectionRevision.count({ where: { section: { manuscript: { snapshotId: snapshot.id } } } })).toBe(1);
  });

  it('adds version 2 when the data it is written from changes, and keeps version 1', async () => {
    const { project, snapshot } = await setup();
    const v1 = await generate(project.id, snapshot.id);
    // Artifact rows are not protected by a trigger, so this stands in for "the same snapshot would now read differently".
    const row = await prisma.snapshotArtifact.findFirstOrThrow({ where: { snapshotId: snapshot.id, artifactType: 'A10' } });
    const payload: any = structuredClone(row.payload);
    payload.search_strategy.sources = [{ source_id: 'src1', name: 'Scopus' }];
    await prisma.snapshotArtifact.update({ where: { id: row.id }, data: { payload } });

    const v2 = await generate(project.id, snapshot.id);
    expect(v2.status).toBe(201);
    expect(v2.body.data.revision.version).toBe(2);
    expect(v2.body.data.revision.markdown).toContain('The following sources were searched: Scopus.');
    expect(v1.body.data.revision.markdown).toContain('were not reported');

    const old = await request(app).get(`${base(project.id, snapshot.id)}/revisions/1`).set(as(alice));
    expect(old.status).toBe(200);
    expect(old.body.data.markdown).toBe(v1.body.data.revision.markdown);
  });

  it('writes a provenance event for a new version and none for an unchanged one', async () => {
    const { project, snapshot } = await setup();
    await generate(project.id, snapshot.id);
    await generate(project.id, snapshot.id);
    const events = await prisma.provenanceEvent.findMany({ where: { snapshotId: snapshot.id, activity: 'manuscript.methods.generate' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: alice, method: 'methods-template@1' });
    expect(events[0].inputRefs).toMatchObject({ snapshotId: snapshot.id, snapshotIntegrityHash: snapshot.integrityHash });
  });

  it('keeps two snapshots apart: each has its own manuscript', async () => {
    const a = await setup(); const b = await setup();
    await generate(a.project.id, a.snapshot.id); await generate(b.project.id, b.snapshot.id);
    expect(await prisma.manuscript.count({ where: { snapshotId: { in: [a.snapshot.id, b.snapshot.id] } } })).toBe(2);
  });

  it('six requests at once give one version, one manuscript and no error', async () => {
    const { project, snapshot } = await setup();
    const results = await Promise.all(Array.from({ length: 6 }, () => generate(project.id, snapshot.id)));
    expect(results.map((r) => r.status).filter((status) => status >= 500)).toEqual([]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.data.revision.id)).size).toBe(1);
    expect(await prisma.manuscript.count({ where: { snapshotId: snapshot.id } })).toBe(1);
    expect(await prisma.sectionRevision.count({ where: { section: { manuscript: { snapshotId: snapshot.id } } } })).toBe(1);
  });

  it('refuses with 422 when the snapshot has no A10, and stores nothing', async () => {
    const { project, snapshot } = await setup();
    await prisma.snapshotArtifact.deleteMany({ where: { snapshotId: snapshot.id, artifactType: 'A10' } });
    const res = await generate(project.id, snapshot.id);
    expect([res.status, res.body.error.code]).toEqual([422, 'METHODS_INPUT_MISSING']);
    expect(await prisma.manuscript.count({ where: { snapshotId: snapshot.id } })).toBe(0);
  });

  it('still writes (with warnings) when the PRISMA export or A2 is missing', async () => {
    const { project, snapshot } = await setup();
    await prisma.snapshotSupplement.deleteMany({ where: { snapshotId: snapshot.id } });
    await prisma.snapshotArtifact.deleteMany({ where: { snapshotId: snapshot.id, artifactType: 'A2' } });
    const res = await generate(project.id, snapshot.id);
    expect(res.status).toBe(201);
    expect(res.body.data.revision.markdown).toContain('The review record does not report the following counts');
    expect(res.body.data.revision.markdown).toContain('Their publication years were not reported');
    expect(res.body.data.revision.warnings.some((w: any) => w.ref === 'prisma.screened')).toBe(true);
  });

  it('carries the PRISMA issues recorded at import into the warnings', async () => {
    const { project, snapshot } = await setup(alice, (raw) => { raw.supplements.prisma_writing_export.flow.studiesIncluded = 5; });
    const res = await generate(project.id, snapshot.id);
    const codes = res.body.data.revision.warnings.map((w: any) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['PRISMA_COUNT_MISMATCH', 'PRISMA_LIST_MISMATCH']));
  });
});

describe('reading Methods', () => {
  it('returns the latest version with the list of versions (no text in the list)', async () => {
    const { project, snapshot } = await setup();
    await generate(project.id, snapshot.id);
    const res = await request(app).get(base(project.id, snapshot.id)).set(as(alice));
    expect(res.status).toBe(200);
    expect(res.body.data.revision.version).toBe(1);
    expect(res.body.data.versions).toHaveLength(1);
    expect(res.body.data.versions[0]).not.toHaveProperty('markdown');
  });

  it('answers 404 METHODS_NOT_GENERATED before anything was written', async () => {
    const { project, snapshot } = await setup();
    const res = await request(app).get(base(project.id, snapshot.id)).set(as(alice));
    expect([res.status, res.body.error.code]).toEqual([404, 'METHODS_NOT_GENERATED']);
  });

  it('answers 404 for a version that does not exist and 400 for a bad version', async () => {
    const { project, snapshot } = await setup();
    await generate(project.id, snapshot.id);
    expect((await request(app).get(`${base(project.id, snapshot.id)}/revisions/2`).set(as(alice))).body.error.code).toBe('METHODS_REVISION_NOT_FOUND');
    for (const bad of ['0', '-1', 'abc', '1.5', '99999999999', '1e3']) {
      const res = await request(app).get(`${base(project.id, snapshot.id)}/revisions/${bad}`).set(as(alice));
      expect([res.status, res.body.error.code]).toEqual([400, 'INVALID_VERSION']);
    }
  });
});

describe('access', () => {
  it('hides another user snapshot as 404 for write and read, and writes nothing', async () => {
    const { project, snapshot } = await setup(alice);
    await generate(project.id, snapshot.id);
    expect((await generate(project.id, snapshot.id, bob)).status).toBe(404);
    expect((await request(app).get(base(project.id, snapshot.id)).set(as(bob))).status).toBe(404);
    expect((await request(app).get(`${base(project.id, snapshot.id)}/revisions/1`).set(as(bob))).status).toBe(404);
  });

  it('does not find a snapshot through a different project of the same owner', async () => {
    const a = await setup(alice); const b = await setup(alice);
    const res = await generate(b.project.id, a.snapshot.id);
    expect([res.status, res.body.error.code]).toEqual([404, 'SNAPSHOT_NOT_FOUND']);
    expect(await prisma.manuscript.count({ where: { snapshotId: a.snapshot.id } })).toBe(0);
  });

  it('requires authentication', async () => {
    const { project, snapshot } = await setup();
    env.DEV_AUTH_ENABLED = false;
    try {
      expect((await request(app).post(base(project.id, snapshot.id))).status).toBe(401);
      expect((await request(app).get(base(project.id, snapshot.id))).status).toBe(401);
    } finally { env.DEV_AUTH_ENABLED = true; }
  });

  it('answers 404 for an unknown snapshot id and for a malformed one', async () => {
    const { project } = await setup();
    for (const id of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid', '%00']) {
      const res = await generate(project.id, id);
      expect(res.status).toBeLessThan(500);
      expect([400, 404]).toContain(res.status);
    }
  });
});

describe('revisions are append-only', () => {
  it('rejects UPDATE and DELETE of a stored version at the database', async () => {
    const { project, snapshot } = await setup();
    const { body } = await generate(project.id, snapshot.id);
    const id = body.data.revision.id as string;
    await expect(prisma.sectionRevision.update({ where: { id }, data: { markdown: 'changed' } })).rejects.toThrow();
    await expect(prisma.sectionRevision.delete({ where: { id } })).rejects.toThrow();
    const stored = await prisma.sectionRevision.findUniqueOrThrow({ where: { id } });
    expect(stored.markdown).toBe(body.data.revision.markdown);
  });
});

describe('ids that cannot match any row', () => {
  it('answer 404, not 500, on every route that takes a project or snapshot id', async () => {
    const { project, snapshot } = await setup();
    const nul = '%00';
    const long = 'x'.repeat(201);
    const paths = [
      `/api/projects/${nul}`, `/api/projects/${long}`, `/api/projects/${nul}/snapshots`,
      `/api/projects/${project.id}/snapshots/${nul}`, `/api/projects/${project.id}/snapshots/${long}`,
      `${base(project.id, nul)}`, `${base(nul, snapshot.id)}`, `${base(project.id, snapshot.id)}/revisions/1/${nul}`,
    ];
    for (const path of paths) {
      const res = await request(app).get(path).set(as(alice));
      expect(res.status, path).toBe(404);
    }
    expect((await request(app).post(base(project.id, nul)).set(as(alice))).status).toBe(404);
    expect((await request(app).post(`/api/projects/${nul}/snapshots/from-slr`).set(as(alice)).send({ runId: 'run-1' })).status).toBe(404);
  });
});
