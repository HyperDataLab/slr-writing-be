import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { openApiDocument } from '../../src/config/openapi.js';
import { prisma } from '../../src/config/prisma.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { importSnapshot } from '../../src/modules/snapshots/snapshot-import.service.js';

// QA (adversarial) integration tests of M2. Needs PostgreSQL with migrations applied.
const app = createApp();
const tag = `qa-methods-${Date.now()}`;
const alice = `${tag}-alice`;
const bob = `${tag}-bob`;
let counter = 0;
const as = (uid: string) => ({ 'X-Dev-User-Id': uid });
const real = () => JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));

afterAll(() => prisma.$disconnect());

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
const revisionsOf = (snapshotId: string) => prisma.sectionRevision.findMany({ where: { section: { manuscript: { snapshotId } } }, orderBy: { version: 'asc' } });
const eventsOf = (snapshotId: string) => prisma.provenanceEvent.count({ where: { snapshotId, activity: 'manuscript.methods.generate' } });
async function setA10(snapshotId: string, change: (payload: any) => any) {
  const row = await prisma.snapshotArtifact.findFirstOrThrow({ where: { snapshotId, artifactType: 'A10' } });
  const next = change(structuredClone(row.payload));
  await prisma.snapshotArtifact.update({ where: { id: row.id }, data: { payload: next === null ? Prisma.JsonNull : (next ?? row.payload) } });
}
function expectNoLeak(body: any) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/prisma|postgres|stack|at .*\.ts|invalid input|P20\d\d|RangeError|SELECT|INSERT/i);
}

describe('service: inputs of the wrong shape', () => {
  it('A10 payload that is an array or a string gives 422 and stores nothing', async () => {
    for (const payload of [[1, 2], 'a string', 42, null]) {
      const { project, snapshot } = await setup();
      await setA10(snapshot.id, () => payload);
      const res = await generate(project.id, snapshot.id);
      expect([res.status, res.body.error?.code], JSON.stringify(payload)).toEqual([422, 'METHODS_INPUT_MISSING']);
      expect(await prisma.manuscript.count({ where: { snapshotId: snapshot.id } })).toBe(0);
    }
  });

  it('PRISMA export payload that is an array still writes, with all counts not reported', async () => {
    const { project, snapshot } = await setup();
    await prisma.snapshotSupplement.updateMany({ where: { snapshotId: snapshot.id }, data: { payload: [1, 2, 3] } });
    const res = await generate(project.id, snapshot.id);
    expect(res.status).toBe(201);
    expect(res.body.data.revision.markdown).toContain('does not report the following counts');
  });

  it('a snapshot with zero studies cannot be imported (so Methods never sees one)', async () => {
    await expect(setup(alice, (raw) => { raw.corpus.studies = []; })).rejects.toThrow();
  });

  it('a huge A2 by_year list imported from slr-be does not end in a 500', async () => {
    const { project, snapshot } = await setup(alice, (raw) => {
      raw.artifacts.A2.distributions.by_year = Array.from({ length: 200_000 }, (_, i) => ({ key: `y${i}`, label: String(2000 + (i % 25)), study_count: 0, study_ids: [] }));
    });
    const res = await generate(project.id, snapshot.id);
    expect(res.status).toBe(201);
    expect(res.body.data.revision.markdown).toContain('publication years were not reported');
  }, 120_000);

  it('a 10 MB list of search sources is written in reasonable time', async () => {
    const { project, snapshot } = await setup();
    await setA10(snapshot.id, (payload) => { payload.search_strategy.sources = Array.from({ length: 100_000 }, (_, i) => ({ source_id: `s${i}`, name: `Database number ${i} ${'x'.repeat(70)}` })); return payload; });
    const started = Date.now();
    const res = await generate(project.id, snapshot.id);
    expect(res.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(res.body.data.revision.markdown.length).toBeGreaterThan(9_000_000);
  }, 120_000);
});

describe('service: versions', () => {
  it('a change only in a fact that is not shown (source_id) adds a version with identical text', async () => {
    const { project, snapshot } = await setup();
    await setA10(snapshot.id, (p) => { p.search_strategy.sources = [{ source_id: 'a', name: 'Scopus' }]; return p; });
    const v1 = await generate(project.id, snapshot.id);
    await setA10(snapshot.id, (p) => { p.search_strategy.sources = [{ source_id: 'b', name: 'Scopus' }]; return p; });
    const v2 = await generate(project.id, snapshot.id);
    expect(v2.body.data.revision.markdown).toBe(v1.body.data.revision.markdown);
    // Documented: "200 when the text is unchanged (nothing is stored)".
    expect(v2.status).toBe(200);
  });

  it('key order of the stored payload does not change the hash', async () => {
    const { project, snapshot } = await setup();
    const v1 = await generate(project.id, snapshot.id);
    const reverse = (value: any): any => Array.isArray(value) ? value.map(reverse)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)])) : value;
    await setA10(snapshot.id, reverse);
    const v2 = await generate(project.id, snapshot.id);
    expect([v2.status, v2.body.data.revision.contentHash]).toEqual([200, v1.body.data.revision.contentHash]);
  });

  it('40 parallel POSTs give exactly one version, no 5xx', async () => {
    const { project, snapshot } = await setup();
    const results = await Promise.all(Array.from({ length: 40 }, () => generate(project.id, snapshot.id)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s >= 500), JSON.stringify(results.find((r) => r.status >= 500)?.body)).toEqual([]);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect((await revisionsOf(snapshot.id)).length).toBe(1);
    expect(await eventsOf(snapshot.id)).toBe(1);
  }, 120_000);

  it('parallel POSTs while the payload changes keep versions gap-free, consecutive hashes distinct, one event per version', async () => {
    const { project, snapshot } = await setup();
    const posts: Promise<request.Response>[] = [];
    for (let round = 0; round < 6; round++) {
      await setA10(snapshot.id, (p) => { p.search_strategy.sources = [{ source_id: `r${round}`, name: `Source round ${round}` }]; return p; });
      for (let i = 0; i < 5; i++) posts.push(generate(project.id, snapshot.id).then((r) => r));
    }
    const results = await Promise.all(posts);
    expect(results.filter((r) => r.status >= 500).map((r) => r.body)).toEqual([]);
    const revisions = await revisionsOf(snapshot.id);
    expect(revisions.map((r) => r.version)).toEqual(revisions.map((_, i) => i + 1));
    for (let i = 1; i < revisions.length; i++) expect(revisions[i].contentHash).not.toBe(revisions[i - 1].contentHash);
    expect(await eventsOf(snapshot.id)).toBe(revisions.length);
    expect(results.filter((r) => r.status === 201)).toHaveLength(revisions.length);
    // After everything settles, the latest version must match the current payload.
    const settle = await generate(project.id, snapshot.id);
    const latest = (await revisionsOf(snapshot.id)).at(-1)!;
    expect(latest.markdown).toContain('Source round 5');
    expect(settle.body.data.revision.id).toBe(latest.id);
  }, 120_000);

  it('GET returns the highest version as latest and versions ascending', async () => {
    const { project, snapshot } = await setup();
    for (let round = 0; round < 3; round++) {
      await setA10(snapshot.id, (p) => { p.search_strategy.sources = [{ name: `S${round}` }]; return p; });
      await generate(project.id, snapshot.id);
    }
    const res = await request(app).get(base(project.id, snapshot.id)).set(as(alice));
    expect(res.body.data.revision.version).toBe(3);
    expect(res.body.data.versions.map((v: any) => v.version)).toEqual([1, 2, 3]);
    expect(Object.keys(res.body.data.versions[0]).sort()).toEqual(['contentHash', 'createdAt', 'createdBy', 'generator', 'id', 'version']);
  });
});

describe('database protection', () => {
  it('revisions cannot be updated or deleted, including through updateMany/deleteMany and raw SQL', async () => {
    const { project, snapshot } = await setup();
    const { body } = await generate(project.id, snapshot.id);
    const id = body.data.revision.id;
    await expect(prisma.sectionRevision.updateMany({ where: { id }, data: { version: 99 } })).rejects.toThrow();
    await expect(prisma.sectionRevision.deleteMany({ where: { id } })).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('UPDATE "SectionRevision" SET "markdown" = $1 WHERE "id" = $2', 'x', id)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('DELETE FROM "SectionRevision" WHERE "id" = $1', id)).rejects.toThrow();
    expect((await prisma.sectionRevision.findUniqueOrThrow({ where: { id } })).markdown).toBe(body.data.revision.markdown);
  });

  it('section, manuscript, snapshot and project cannot be deleted while revisions exist', async () => {
    const { project, snapshot } = await setup();
    await generate(project.id, snapshot.id);
    const manuscript = await prisma.manuscript.findUniqueOrThrow({ where: { snapshotId: snapshot.id } });
    await expect(prisma.manuscriptSection.deleteMany({ where: { manuscriptId: manuscript.id } })).rejects.toThrow();
    await expect(prisma.manuscript.delete({ where: { id: manuscript.id } })).rejects.toThrow();
    await expect(prisma.reviewSnapshot.delete({ where: { id: snapshot.id } })).rejects.toThrow();
    await expect(prisma.project.delete({ where: { id: project.id } })).rejects.toThrow();
    expect(await revisionsOf(snapshot.id)).toHaveLength(1);
  });

  it('changing ManuscriptSection.id is blocked (cascade would update revisions)', async () => {
    const { project, snapshot } = await setup();
    await generate(project.id, snapshot.id);
    const section = await prisma.manuscriptSection.findFirstOrThrow({ where: { manuscript: { snapshotId: snapshot.id } } });
    await expect(prisma.manuscriptSection.update({ where: { id: section.id }, data: { id: `${section.id}-x` } })).rejects.toThrow();
  });

  it('a manuscript with revisions cannot be re-pointed to another snapshot', async () => {
    const a = await setup(); const b = await setup();
    await generate(a.project.id, a.snapshot.id);
    const manuscript = await prisma.manuscript.findUniqueOrThrow({ where: { snapshotId: a.snapshot.id } });
    let moved = false;
    try {
      await prisma.manuscript.update({ where: { id: manuscript.id }, data: { snapshotId: b.snapshot.id, projectId: b.project.id } });
      moved = true;
    } catch { /* blocked */ }
    if (moved) await prisma.manuscript.update({ where: { id: manuscript.id }, data: { snapshotId: a.snapshot.id, projectId: a.project.id } });
    expect(moved).toBe(false);
  });

  it('a section key can be renamed so the stored Methods vanishes from the API', async () => {
    const { project, snapshot } = await setup();
    await generate(project.id, snapshot.id);
    const section = await prisma.manuscriptSection.findFirstOrThrow({ where: { manuscript: { snapshotId: snapshot.id } } });
    let renamed = false;
    try { await prisma.manuscriptSection.update({ where: { id: section.id }, data: { sectionKey: 'results' } }); renamed = true; } catch { /* blocked */ }
    if (renamed) await prisma.manuscriptSection.update({ where: { id: section.id }, data: { sectionKey: 'methods' } });
    expect(renamed).toBe(false);
  });
});

describe('HTTP: access', () => {
  it('another user gets 404 on POST, GET and revisions; nothing written', async () => {
    const { project, snapshot } = await setup();
    await generate(project.id, snapshot.id);
    for (const res of [
      await generate(project.id, snapshot.id, bob),
      await request(app).get(base(project.id, snapshot.id)).set(as(bob)),
      await request(app).get(`${base(project.id, snapshot.id)}/revisions/1`).set(as(bob)),
    ]) {
      expect([res.status, res.body.error.code]).toEqual([404, 'PROJECT_NOT_FOUND']);
    }
    expect(await revisionsOf(snapshot.id)).toHaveLength(1);
  });

  it('bob\'s own project with alice\'s snapshot id gives 404 SNAPSHOT_NOT_FOUND on every route', async () => {
    const a = await setup(alice); const b = await setup(bob);
    await generate(a.project.id, a.snapshot.id);
    for (const res of [
      await generate(b.project.id, a.snapshot.id, bob),
      await request(app).get(base(b.project.id, a.snapshot.id)).set(as(bob)),
      await request(app).get(`${base(b.project.id, a.snapshot.id)}/revisions/1`).set(as(bob)),
    ]) {
      expect([res.status, res.body.error.code]).toEqual([404, 'SNAPSHOT_NOT_FOUND']);
    }
    expect(await prisma.manuscript.count({ where: { projectId: b.project.id } })).toBe(0);
  });

  it('unauthenticated gives 401 on all three routes', async () => {
    const { project, snapshot } = await setup();
    env.DEV_AUTH_ENABLED = false;
    try {
      for (const res of [
        await request(app).post(base(project.id, snapshot.id)),
        await request(app).get(base(project.id, snapshot.id)),
        await request(app).get(`${base(project.id, snapshot.id)}/revisions/1`),
      ]) expect(res.status).toBe(401);
    } finally { env.DEV_AUTH_ENABLED = true; }
  });
});

describe('HTTP: odd ids and versions', () => {
  it('odd snapshot ids never give 500 on POST/GET/revisions', async () => {
    const { project } = await setup();
    const ids = ['%00', '%2e%2e', '..', 'x'.repeat(200), 'x'.repeat(201), 'x'.repeat(5000), '%F0%9F%9A%80', 'a%2Fb', '%E2%80%AE', '%ED%A0%80', '%E0%A4%A', '%ZZ', '%', "'%20OR%201=1--"];
    const fails: string[] = [];
    for (const id of ids) {
      for (const [name, res] of [
        ['POST', await generate(project.id, id)],
        ['GET', await request(app).get(base(project.id, id)).set(as(alice))],
        ['REV', await request(app).get(`${base(project.id, id)}/revisions/1`).set(as(alice))],
      ] as const) {
        if (res.status >= 500) fails.push(`${name} ${id} ${res.status} ${res.body.error?.code}`);
        expectNoLeak(res.body);
      }
    }
    expect(fails).toEqual([]);
  });

  it('a malformed percent-escape in the version segment does not give 500', async () => {
    const { project, snapshot } = await setup();
    const res = await request(app).get(`${base(project.id, snapshot.id)}/revisions/%ZZ`).set(as(alice));
    expect(res.status).toBeLessThan(500);
  });

  it('odd project ids never give 500 on project and snapshot routes including validate/from-slr', async () => {
    const ids = ['%00', 'x'.repeat(201), '%ED%A0%80', '%E0%A4%A', '%ZZ'];
    const fails: string[] = [];
    for (const id of ids) {
      for (const [name, res] of [
        ['GET project', await request(app).get(`/api/projects/${id}`).set(as(alice))],
        ['POST validate', await request(app).post(`/api/projects/${id}/snapshots/validate`).set(as(alice)).send({})],
        ['POST from-slr', await request(app).post(`/api/projects/${id}/snapshots/from-slr`).set(as(alice)).send({ runId: 'run-1' })],
        ['POST import', await request(app).post(`/api/projects/${id}/snapshots`).set(as(alice)).send({})],
        ['GET snapshots', await request(app).get(`/api/projects/${id}/snapshots`).set(as(alice))],
      ] as const) {
        if (res.status >= 500) fails.push(`${name} ${id} ${res.status}`);
        else if (!id.startsWith('%E') && !id.startsWith('%Z')) expect(res.status, `${name} ${id}`).toBe(404);
      }
    }
    expect(fails).toEqual([]);
  });

  it('guardIdParam does not break valid ids: a 200-char id is looked up, 201 is cut off, both 404', async () => {
    const { project, snapshot } = await setup();
    expect((await request(app).get(`/api/projects/${project.id}`).set(as(alice))).status).toBe(200);
    expect((await request(app).get(`/api/projects/${project.id}/snapshots/${snapshot.id}`).set(as(alice))).status).toBe(200);
    for (const id of ['x'.repeat(200), 'x'.repeat(201)]) {
      const res = await request(app).get(`/api/projects/${id}`).set(as(alice));
      expect([res.status, res.body.error.code]).toEqual([404, 'PROJECT_NOT_FOUND']);
    }
  });

  it('version edge cases', async () => {
    const { project, snapshot } = await setup();
    await generate(project.id, snapshot.id);
    const at = (v: string) => request(app).get(`${base(project.id, snapshot.id)}/revisions/${v}`).set(as(alice));
    for (const bad of ['0', '01', '1e3', '2147483648', '99999999999', '-1', '%201', '1%20', '%EF%BC%91', '+1', '0x1', '1.0', '', '%00', '1,2']) {
      const res = await at(bad);
      if (bad === '') { expect(res.status).toBe(404); continue; } // falls through to the list route? see below
      expect([res.status, res.body.error?.code], bad).toEqual([400, 'INVALID_VERSION']);
    }
    expect((await at('999999999')).body.error.code).toBe('METHODS_REVISION_NOT_FOUND');
    expect((await at('1')).status).toBe(200);
    expect((await at('%31')).status).toBe(200); // percent-encoded "1"
  });

  it('PUT/PATCH/DELETE do nothing and answer 404', async () => {
    const { project, snapshot } = await setup();
    await generate(project.id, snapshot.id);
    for (const method of ['put', 'patch', 'delete'] as const) {
      for (const path of [base(project.id, snapshot.id), `${base(project.id, snapshot.id)}/revisions/1`]) {
        const res = await request(app)[method](path).set(as(alice)).send({ markdown: 'hacked' });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    const revisions = await revisionsOf(snapshot.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].markdown).not.toContain('hacked');
  });

  it('trailing slash works the same and a body is ignored', async () => {
    const { project, snapshot } = await setup();
    const first = await request(app).post(`${base(project.id, snapshot.id)}/`).set(as(alice)).send({ markdown: 'x', version: 7, createdBy: 'evil', facts: [] });
    expect(first.status).toBe(201);
    expect(first.body.data.revision).toMatchObject({ version: 1, createdBy: alice });
    expect(first.body.data.revision.markdown).not.toBe('x');
    expect((await request(app).get(`${base(project.id, snapshot.id)}/`).set(as(alice))).status).toBe(200);
    expect((await request(app).get(`${base(project.id, snapshot.id)}/revisions/1/`).set(as(alice))).status).toBe(200);
  });

  it('response JSON shape is stable', async () => {
    const { project, snapshot } = await setup();
    const res = await generate(project.id, snapshot.id);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'success']);
    expect(Object.keys(res.body.data).sort()).toEqual(['created', 'revision']);
    expect(Object.keys(res.body.data.revision).sort()).toEqual(['contentHash', 'createdAt', 'createdBy', 'factPassages', 'facts', 'generator', 'id', 'markdown', 'sectionId', 'version', 'warnings']);
    expect(res.body.data.revision.factPassages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.any(String),
        startLine: expect.any(Number),
        endLine: expect.any(Number),
        factKeys: expect.any(Array),
      }),
    ]));
    for (const w of res.body.data.revision.warnings) expect(w.severity).toBe('warning');
  });
});

describe('OpenAPI accuracy', () => {
  const paths = openApiDocument.paths as any;
  const methodsPath = '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/methods';
  const revisionPath = `${methodsPath}/revisions/{version}`;

  it('documents the three routes', () => {
    expect(paths[methodsPath]?.post).toBeTruthy();
    expect(paths[methodsPath]?.get).toBeTruthy();
    expect(paths[revisionPath]?.get).toBeTruthy();
  });

  it('every status the routes really return is documented', async () => {
    const { project, snapshot } = await setup();
    const observed: Record<string, Set<string>> = { post: new Set(), get: new Set(), rev: new Set() };
    const add = (k: string, r: request.Response) => observed[k].add(String(r.status));
    add('get', await request(app).get(base(project.id, snapshot.id)).set(as(alice)));
    add('rev', await request(app).get(`${base(project.id, snapshot.id)}/revisions/1`).set(as(alice)));
    add('post', await generate(project.id, snapshot.id));
    add('post', await generate(project.id, snapshot.id));
    add('get', await request(app).get(base(project.id, snapshot.id)).set(as(alice)));
    add('rev', await request(app).get(`${base(project.id, snapshot.id)}/revisions/1`).set(as(alice)));
    add('rev', await request(app).get(`${base(project.id, snapshot.id)}/revisions/0`).set(as(alice)));
    add('post', await generate(project.id, 'nope'));
    env.DEV_AUTH_ENABLED = false;
    try {
      add('post', await request(app).post(base(project.id, snapshot.id)));
      add('get', await request(app).get(base(project.id, snapshot.id)));
      add('rev', await request(app).get(`${base(project.id, snapshot.id)}/revisions/1`));
    } finally { env.DEV_AUTH_ENABLED = true; }
    const missing: string[] = [];
    const check = (k: string, op: any) => observed[k].forEach((s) => { if (!op.responses[s]) missing.push(`${k} ${s}`); });
    check('post', paths[methodsPath].post); check('get', paths[methodsPath].get); check('rev', paths[revisionPath].get);
    expect(missing).toEqual([]);
  });
});
