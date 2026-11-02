import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/config/prisma.js';
import { importSnapshot } from '../../src/modules/snapshots/snapshot-import.service.js';

// QA: concurrency of the blueprint writers (advisory lock, fast path, transaction timeouts) and DoS shapes. Needs PostgreSQL.
const app = createApp();
const tag = `qa-bpc-${Date.now()}`;
const alice = `${tag}-alice`;
let counter = 0;
const as = (uid: string) => ({ 'X-Dev-User-Id': uid });
const real = () => JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));

afterAll(() => prisma.$disconnect());

async function setup() {
  const slrProjectId = `${tag}-slr-${counter++}`;
  const project = await prisma.project.create({ data: { name: slrProjectId, ownerId: alice, slrProjectId } });
  const raw = real();
  raw.run.project_id = slrProjectId;
  raw.corpus.project_id = slrProjectId;
  raw.supplements.prisma_writing_export.project.id = slrProjectId;
  const { snapshot } = await importSnapshot({ projectId: project.id, importedBy: alice, input: raw, source: 'slr-be' });
  return { project, snapshot };
}
const base = (p: string, s: string) => `/api/projects/${p}/snapshots/${s}/manuscript/blueprint`;
const create = (p: string, s: string) => request(app).post(base(p, s)).set(as(alice)).send({});
const put = (p: string, s: string, body: unknown) => request(app).put(base(p, s)).set(as(alice)).send(body as object);
const approve = (p: string, s: string, version: number) => request(app).post(`${base(p, s)}/approve`).set(as(alice)).send({ version });
const reject = (p: string, s: string, version: number, note: string) => request(app).post(`${base(p, s)}/reject`).set(as(alice)).send({ version, note });
const status5xx = (list: Array<{ status: number }>) => list.filter((r) => r.status >= 500).map((r) => r.status);

async function ready() {
  const s = await setup();
  const first = await create(s.project.id, s.snapshot.id);
  return { ...s, content: structuredClone(first.body.data.revision.content) };
}

describe('bursts', () => {
  it('40 parallel creates on a fresh snapshot: no 5xx, exactly one 201, one version, one event', async () => {
    const { project, snapshot } = await setup();
    const results = await Promise.all(Array.from({ length: 40 }, () => create(project.id, snapshot.id)));
    expect(status5xx(results)).toEqual([]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.blueprintRevision.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(1);
    expect(await prisma.provenanceEvent.count({ where: { snapshotId: snapshot.id, activity: 'manuscript.blueprint.generate' } })).toBe(1);
  }, 120_000);

  it('methods and blueprint created at the same time on a fresh snapshot share one manuscript, no 5xx', async () => {
    const { project, snapshot } = await setup();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2
      ? request(app).post(`/api/projects/${project.id}/snapshots/${snapshot.id}/manuscript/methods`).set(as(alice))
      : create(project.id, snapshot.id))));
    expect(status5xx(results)).toEqual([]);
    expect(await prisma.manuscript.count({ where: { snapshotId: snapshot.id } })).toBe(1);
  }, 120_000);

  it('20 sequential-base PUTs fired at once: one wins per base; versions stay gap-free', async () => {
    const { project, snapshot, content } = await ready();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => {
      const c = structuredClone(content); c.sections[3].subsections[0].title = `w${i}`;
      return put(project.id, snapshot.id, { baseVersion: 1 + (i % 4), content: c });
    }));
    expect(status5xx(results)).toEqual([]);
    const versions = (await prisma.blueprintRevision.findMany({ where: { manuscript: { snapshotId: snapshot.id } }, select: { version: true }, orderBy: { version: 'asc' } })).map((v) => v.version);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1));
    expect(results.filter((r) => r.status === 201)).toHaveLength(versions.length - 1);
  }, 120_000);

  it('create concurrent with PUT: no 5xx, create never overwrites', async () => {
    const { project, snapshot, content } = await ready();
    const c = structuredClone(content); c.sections[3].subsections[0].title = 'edited';
    const results = await Promise.all([put(project.id, snapshot.id, { baseVersion: 1, content: c }), ...Array.from({ length: 10 }, () => create(project.id, snapshot.id))]);
    expect(status5xx(results)).toEqual([]);
    expect(results[0].status).toBe(201);
    expect(await prisma.blueprintRevision.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(2);
  }, 120_000);

  it('20 parallel approves of the same version: one row, no 5xx', async () => {
    const { project, snapshot } = await ready();
    const results = await Promise.all(Array.from({ length: 20 }, () => approve(project.id, snapshot.id, 1)));
    expect(status5xx(results)).toEqual([]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.approval.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(1);
  }, 120_000);

  it('20 alternating approve/reject at once: rows alternate, final state = last row by seq, hashes match', async () => {
    const { project, snapshot } = await ready();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? reject(project.id, snapshot.id, 1, `n${i}`) : approve(project.id, snapshot.id, 1))));
    expect(status5xx(results)).toEqual([]);
    const rows = await prisma.approval.findMany({ where: { manuscript: { snapshotId: snapshot.id } }, orderBy: { seq: 'asc' } });
    // The same decision twice in a row is only recorded when its note differs from the one before.
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].decision === rows[i - 1].decision) expect(rows[i].note).not.toBe(rows[i - 1].note);
    }
    expect(rows.length).toBe(results.filter((r) => r.status === 201).length);
    const view = await request(app).get(base(project.id, snapshot.id)).set(as(alice));
    expect(view.body.data.approval.status).toBe(rows[rows.length - 1].decision);
    const rev = await prisma.blueprintRevision.findFirstOrThrow({ where: { manuscript: { snapshotId: snapshot.id }, version: 1 } });
    expect(rows.every((r) => r.targetHash === rev.contentHash && r.targetId === rev.id)).toBe(true);
    // Every created decision has exactly one provenance event.
    expect(await prisma.provenanceEvent.count({ where: { snapshotId: snapshot.id, activity: { startsWith: 'approval.H1.' } } })).toBe(rows.length);
  }, 120_000);

  it('PUTs and approves interleaved: every approval targets a version that was latest, with its hash', async () => {
    const { project, snapshot, content } = await ready();
    const calls = Array.from({ length: 16 }, (_, i) => {
      if (i % 2) return approve(project.id, snapshot.id, 1 + Math.floor(i / 4));
      const c = structuredClone(content); c.sections[3].subsections[0].title = `x${i}`;
      return put(project.id, snapshot.id, { baseVersion: 1 + Math.floor(i / 4), content: c });
    });
    const results = await Promise.all(calls);
    expect(status5xx(results)).toEqual([]);
    const rows = await prisma.approval.findMany({ where: { manuscript: { snapshotId: snapshot.id } } });
    for (const row of rows) {
      const rev = await prisma.blueprintRevision.findUniqueOrThrow({ where: { id: row.targetId } });
      expect(rev.contentHash).toBe(row.targetHash);
      // Approved content was the latest at decision time: no revision created before the approval's time is newer... check by version created before.
      const newer = await prisma.blueprintRevision.findFirst({ where: { manuscriptId: rev.manuscriptId, version: { gt: rev.version }, createdAt: { lt: row.decidedAt } } });
      expect(newer).toBeNull();
    }
  }, 120_000);
});

describe('race invariants under the pool size (8 concurrent calls)', () => {
  it('8 alternating approve/reject: rows alternate, final state = last row by seq, hashes match', async () => {
    const { project, snapshot } = await ready();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? reject(project.id, snapshot.id, 1, `n${i}`) : approve(project.id, snapshot.id, 1))));
    expect(status5xx(results)).toEqual([]);
    const rows = await prisma.approval.findMany({ where: { manuscript: { snapshotId: snapshot.id } }, orderBy: { seq: 'asc' } });
    // The same decision twice in a row is only recorded when its note differs from the one before.
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].decision === rows[i - 1].decision) expect(rows[i].note).not.toBe(rows[i - 1].note);
    }
    expect(rows.length).toBe(results.filter((r) => r.status === 201).length);
    const view = await request(app).get(base(project.id, snapshot.id)).set(as(alice));
    expect(view.body.data.approval.status).toBe(rows[rows.length - 1].decision);
    const rev = await prisma.blueprintRevision.findFirstOrThrow({ where: { manuscript: { snapshotId: snapshot.id }, version: 1 } });
    expect(rows.every((r) => r.targetHash === rev.contentHash && r.targetId === rev.id)).toBe(true);
    expect(await prisma.provenanceEvent.count({ where: { snapshotId: snapshot.id, activity: { startsWith: 'approval.H1.' } } })).toBe(rows.length);
  }, 120_000);

  it('8 interleaved PUT/approve: every 201 approval targets exactly the version it named, with its hash', async () => {
    const { project, snapshot, content } = await ready();
    const named: number[] = [];
    const calls = Array.from({ length: 8 }, (_, i) => {
      const v = 1 + Math.floor(i / 4);
      if (i % 2) { named.push(v); return approve(project.id, snapshot.id, v).then((r) => ({ r, v })); }
      const c = structuredClone(content); c.sections[3].subsections[0].title = `x${i}`;
      return put(project.id, snapshot.id, { baseVersion: v, content: c }).then((r) => ({ r, v }));
    });
    const results = await Promise.all(calls);
    expect(status5xx(results.map((x) => x.r))).toEqual([]);
    for (const { r, v } of results) {
      if (r.status !== 201 || !r.body.data.approval) continue;
      const rev = await prisma.blueprintRevision.findUniqueOrThrow({ where: { id: r.body.data.approval.targetId } });
      expect(rev.version).toBe(v);
      expect(r.body.data.approval.targetHash).toBe(rev.contentHash);
    }
  }, 120_000);
});

describe('DoS shapes over HTTP', () => {
  it('a draft over the size limit is refused, and a large draft under it stays bounded in PUT, GET and approve', async () => {
    const { project, snapshot, content } = await ready();
    const results = content.sections.find((s: any) => s.key === 'results');
    const subs = Number(process.env.QA_DOS_SUBS ?? 40); // 40 x 1000 = 40,000 references, under the limit of 50,000
    results.subsections = Array.from({ length: subs }, (_, i) => ({ id: `s${i}`, title: 't', purpose: null, claimIds: Array.from({ length: 1000 }, (_, j) => `u${i}-${j}`), rqIds: [] }));
    let start = Date.now();
    const saved = await put(project.id, snapshot.id, { baseVersion: 1, content });
    const putMs = Date.now() - start;
    expect(saved.status).toBe(201);
    start = Date.now();
    const view = await request(app).get(base(project.id, snapshot.id)).set(as(alice));
    const getMs = Date.now() - start;
    const bytes = Number(view.headers['content-length'] ?? JSON.stringify(view.body).length);
    start = Date.now();
    const a = await approve(project.id, snapshot.id, 2);
    const approveMs = Date.now() - start;
    const aBytes = Number(a.headers['content-length'] ?? 0);
    console.log(`[qa] dos put=${putMs}ms get=${getMs}ms getBytes=${(bytes / 1e6).toFixed(1)}MB issues=${view.body.data?.issues?.length} approve=${approveMs}ms approveBytes=${(aBytes / 1e6).toFixed(1)}MB`);
    expect(a.status).toBe(422);
    // The answer holds the saved content itself (about 0.4 MB here); the issues add little. Before the cap it was 46 MB.
    expect(bytes).toBeLessThan(1_000_000);
    expect(aBytes).toBeLessThan(200_000);
    expect(view.body.data.issues.some((issue: any) => issue.code === 'ISSUES_TRUNCATED')).toBe(true);

    // 300 x 1000 = 300,000 references is over the limit: refused up front instead of being saved.
    const over = structuredClone(content);
    over.sections.find((s: any) => s.key === 'results').subsections = Array.from({ length: 300 }, (_, i) => ({ id: `o${i}`, title: 't', purpose: null, claimIds: Array.from({ length: 1000 }, (_, j) => `u${i}-${j}`), rqIds: [] }));
    const refused = await put(project.id, snapshot.id, { baseVersion: 2, content: over });
    expect([refused.status, refused.body.error.code]).toEqual([400, 'INVALID_BLUEPRINT']);
  }, 300_000);
});
