import { readFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { openApiDocument } from '../../src/config/openapi.js';
import { prisma } from '../../src/config/prisma.js';
import { setTokenVerifier } from '../../src/middleware/auth.middleware.js';
import { getApprovedBlueprint } from '../../src/modules/blueprint/blueprint.service.js';
import { importSnapshot } from '../../src/modules/snapshots/snapshot-import.service.js';
import { FakeSlrBe } from '../slr-client/fake-slr-be.js';

// QA (adversarial) integration tests of M5: blueprint + H1. Needs PostgreSQL. A fake slr-be answers the role check.
const app = createApp();
const fake = new FakeSlrBe();
const tag = `qa-bp-${Date.now()}`;
const alice = `${tag}-alice`;
const bob = `${tag}-bob`;
let counter = 0;
const as = (uid: string) => ({ 'X-Dev-User-Id': uid });
const real = () => JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));
const originalBase = env.SLR_API_BASE_URL;
const originalTimeout = env.SLR_API_TIMEOUT_MS;
const originalMax = env.SLR_API_MAX_RESPONSE_BYTES;

beforeAll(async () => { await fake.start(); env.SLR_API_BASE_URL = fake.baseUrl; });
afterAll(async () => { env.SLR_API_BASE_URL = originalBase; env.REQUIRE_SLR_OWNER_FOR_APPROVAL = false; await fake.stop(); await prisma.$disconnect(); });
beforeEach(() => fake.reset());
afterEach(() => {
  env.DEV_AUTH_ENABLED = true; env.REQUIRE_SLR_OWNER_FOR_APPROVAL = false;
  env.SLR_API_TIMEOUT_MS = originalTimeout; env.SLR_API_MAX_RESPONSE_BYTES = originalMax; setTokenVerifier(null);
});

async function setup(uid = alice, mutate?: (raw: any) => void) {
  const slrProjectId = `${tag}-slr-${counter++}`;
  const project = await prisma.project.create({ data: { name: slrProjectId, ownerId: uid, slrProjectId } });
  const raw = real();
  raw.run.project_id = slrProjectId;
  raw.corpus.project_id = slrProjectId;
  raw.supplements.prisma_writing_export.project.id = slrProjectId;
  mutate?.(raw);
  const { snapshot } = await importSnapshot({ projectId: project.id, importedBy: uid, input: raw, source: 'slr-be' });
  return { project, snapshot, slrProjectId };
}
const base = (p: string, s: string) => `/api/projects/${p}/snapshots/${s}/manuscript/blueprint`;
const create = (p: string, s: string, uid = alice, body: object = {}) => request(app).post(base(p, s)).set(as(uid)).send(body);
const get = (p: string, s: string, uid = alice) => request(app).get(base(p, s)).set(as(uid));
const put = (p: string, s: string, body: unknown, uid = alice) => request(app).put(base(p, s)).set(as(uid)).send(body as object);
const approve = (p: string, s: string, body: unknown, uid = alice, headers: Record<string, string> = {}) =>
  request(app).post(`${base(p, s)}/approve`).set({ ...as(uid), ...headers }).send(body as object);
const reject = (p: string, s: string, body: unknown, uid = alice, headers: Record<string, string> = {}) =>
  request(app).post(`${base(p, s)}/reject`).set({ ...as(uid), ...headers }).send(body as object);
const roleAnswer = (slrProjectId: string, body: unknown, status = 200) => fake.json(`/api/projects/${slrProjectId}`, body, status);
const approvals = (snapshotId: string) => prisma.approval.count({ where: { manuscript: { snapshotId } } });
const events = (snapshotId: string) => prisma.provenanceEvent.count({ where: { snapshotId, activity: { in: ['manuscript.blueprint.generate', 'manuscript.blueprint.edit', 'approval.H1.approved', 'approval.H1.rejected'] } } });

async function ready(uid = alice, mutate?: (raw: any) => void) {
  const s = await setup(uid, mutate);
  const first = await create(s.project.id, s.snapshot.id, uid);
  expect(first.status).toBe(201);
  return { ...s, revision: first.body.data.revision, content: structuredClone(first.body.data.revision.content) };
}

describe('H1 authorization: only roleText === OWNER passes', () => {
  beforeEach(() => { env.REQUIRE_SLR_OWNER_FOR_APPROVAL = true; });

  const refused: Array<[string, unknown]> = [
    ['OWNER with a trailing space', { success: true, data: { roleText: 'OWNER ' } }],
    ['OWNER with a leading space', { success: true, data: { roleText: ' OWNER' } }],
    ['OWNER with a newline', { success: true, data: { roleText: 'OWNER\n' } }],
    ['owner lower case', { success: true, data: { roleText: 'owner' } }],
    ['OWNER in an array', { success: true, data: { roleText: ['OWNER'] } }],
    ['OWNER in a nested object', { success: true, data: { roleText: { value: 'OWNER' } } }],
    ['numeric role 1 only', { success: true, data: { role: 1 } }],
    ['role "OWNER" without roleText', { success: true, data: { role: 'OWNER' } }],
    ['isLeader true without roleText', { success: true, data: { isLeader: true, roleNumber: 1 } }],
    ['doubly wrapped data', { success: true, data: { data: { roleText: 'OWNER' } } }],
    ['UNKNOWN (slr-be default)', { success: true, data: { roleText: 'UNKNOWN', role: null, isLeader: false } }],
    ['fullwidth OWNER', { success: true, data: { roleText: 'ＯＷＮＥＲ' } }],
    ['OWNER with zero-width space', { success: true, data: { roleText: 'OWNER​' } }],
    ['Cyrillic O in OWNER', { success: true, data: { roleText: 'ОWNER' } }],
  ];
  it.each(refused)('refuses %s with 403 and writes nothing', async (_name, body) => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, body);
    const before = await events(snapshot.id);
    const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' });
    expect([res.status, res.body.error?.code]).toEqual([403, 'APPROVAL_REQUIRES_OWNER']);
    expect(await approvals(snapshot.id)).toBe(0);
    expect(await events(snapshot.id)).toBe(before);
  });

  it('an error envelope success:false with OWNER fails closed (502, nothing written)', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, { success: false, data: { roleText: 'OWNER' } });
    const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' });
    expect([res.status, res.body.error.code]).toEqual([502, 'SLR_UPSTREAM_ERROR']);
    expect(await approvals(snapshot.id)).toBe(0);
  });

  it('a bare (unwrapped) {roleText:OWNER} passes: unwrapEnvelope accepts bare data (by design)', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, { id: slrProjectId, roleText: 'OWNER' });
    expect((await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' })).status).toBe(201);
  });

  it.each([['"false"', 'false'], ['0', 0], ['null', null]])('an envelope with success %s is treated as an error, not as OWNER', async (_n, success) => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, { success, data: { id: slrProjectId, roleText: 'OWNER' } });
    const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' });
    expect(res.status).not.toBe(201);
  });

  it('slr-be answering 200 with another project id is not accepted as OWNER of this one', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, { success: true, data: { id: 'some-other-project', roleText: 'OWNER' } });
    const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' });
    expect(res.status).not.toBe(201);
  });

  it('refuses REJECT for every non-owner shape too', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    for (const [, body] of refused) {
      roleAnswer(slrProjectId, body);
      expect((await reject(project.id, snapshot.id, { version: 1, note: 'no' }, alice, { Authorization: 'Bearer t' })).status).toBe(403);
    }
    expect(await approvals(snapshot.id)).toBe(0);
  });

  it('the role is not cached: OWNER then REVIEWER gives 201 then 403', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    let calls = 0;
    fake.on(`/api/projects/${slrProjectId}`, (_req, res) => {
      calls += 1; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, data: { id: slrProjectId, roleText: calls === 1 ? 'OWNER' : 'REVIEWER' } }));
    });
    expect((await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' })).status).toBe(201);
    expect((await reject(project.id, snapshot.id, { version: 1, note: 'x' }, alice, { Authorization: 'Bearer t' })).status).toBe(403);
    // Even the no-op repeat asks again.
    expect((await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' })).status).toBe(403);
    expect(calls).toBe(3);
  });

  it('forwards the Authorization header exactly, and none when absent', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, { success: true, data: { roleText: 'REVIEWER' } });
    const odd = 'Bearer   a.b.c==  ';
    await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: odd });
    await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Basic dXNlcjpwYXNz' });
    await approve(project.id, snapshot.id, { version: 1 });
    // Node trims trailing whitespace of header values; compare with that in mind.
    expect(fake.requests.map((r) => r.authorization)).toEqual([odd.trimEnd(), 'Basic dXNlcjpwYXNz', undefined]);
    expect(fake.requests.every((r) => r.url === `/api/projects/${slrProjectId}` && r.method === 'GET')).toBe(true);
  });

  it('a duplicated Authorization header forwards only one value and never both', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, { success: true, data: { roleText: 'REVIEWER' } });
    const server: Server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `${base(project.id, snapshot.id)}/approve` }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
        req.on('error', reject);
        req.setHeader('content-type', 'application/json');
        req.setHeader('x-dev-user-id', alice);
        req.setHeader('authorization', ['Bearer first', 'Bearer second']);
        req.end(JSON.stringify({ version: 1 }));
      });
      expect(status).toBe(403);
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0].authorization).toBe('Bearer first');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  it('a user who owns the writing project but is REVIEWER on slr-be: 403', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, { success: true, data: { id: slrProjectId, roleText: 'REVIEWER', role: 3, isLeader: false } });
    expect((await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' })).status).toBe(403);
  });

  it('an SLR OWNER who does not own the writing project gets 404 and slr-be is never asked', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, { success: true, data: { id: slrProjectId, roleText: 'OWNER' } });
    for (const call of [() => approve(project.id, snapshot.id, { version: 1 }, bob, { Authorization: 'Bearer t' }), () => reject(project.id, snapshot.id, { version: 1, note: 'n' }, bob, { Authorization: 'Bearer t' })]) {
      expect((await call()).status).toBe(404);
    }
    expect(fake.requests).toHaveLength(0);
    expect(await approvals(snapshot.id)).toBe(0);
  });

  it('a redirect from slr-be is not followed (token never forwarded) and refuses', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    fake.json('/api/elsewhere', { success: true, data: { roleText: 'OWNER' } });
    fake.redirect(`/api/projects/${slrProjectId}`, `${fake.baseUrl}/api/elsewhere`);
    const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer secret-token' });
    expect(res.status).toBe(502);
    expect(fake.requests.map((r) => r.url)).not.toContain('/api/elsewhere');
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
  });

  it('HTML, oversized, reset, trickling and hung answers all refuse without writing and without leaking', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    const path = `/api/projects/${slrProjectId}`;
    const call = () => approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer secret-token' });

    fake.raw(path, '<html>OWNER</html>');
    let res = await call();
    expect([res.status, res.body.error.code]).toEqual([502, 'SLR_INVALID_RESPONSE']);

    env.SLR_API_MAX_RESPONSE_BYTES = 1000;
    fake.json(path, { success: true, data: { roleText: 'OWNER', pad: 'x'.repeat(5000) } });
    res = await call();
    expect([res.status, res.body.error.code]).toEqual([502, 'SLR_RESPONSE_TOO_LARGE']);
    env.SLR_API_MAX_RESPONSE_BYTES = originalMax;

    fake.on(path, (req) => { req.socket.destroy(); });
    res = await call();
    expect([res.status, res.body.error.code]).toEqual([502, 'SLR_UNREACHABLE']);

    env.SLR_API_TIMEOUT_MS = 300;
    fake.on(path, (_req, r) => {
      r.writeHead(200, { 'content-type': 'application/json' });
      r.write('{"success":true,"data":{"roleText":"OWNER"');
      const timer = setInterval(() => { if (!r.writableEnded) r.write(' '); }, 50);
      setTimeout(() => { clearInterval(timer); if (!r.writableEnded) r.end('}}'); }, 2000);
    });
    res = await call();
    expect([res.status, res.body.error.code]).toEqual([504, 'SLR_TIMEOUT']);

    fake.hang(path);
    res = await call();
    expect(res.status).toBe(504);

    expect(await approvals(snapshot.id)).toBe(0);
    for (const r of [res]) {
      const text = JSON.stringify(r.body);
      expect(text).not.toContain(fake.baseUrl);
      expect(text).not.toContain('secret-token');
      expect(text).not.toContain('stack');
    }
  });

  it('upstream error bodies, URLs and tokens never reach the client', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    for (const status of [400, 401, 403, 404, 418, 500, 503]) {
      roleAnswer(slrProjectId, { message: `internal ${fake.baseUrl} secret`, stack: 'at x' }, status);
      const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer secret-token' });
      const text = JSON.stringify(res.body);
      expect(res.status, String(status)).toBeGreaterThanOrEqual(400);
      for (const bad of [fake.baseUrl, '127.0.0.1', 'secret', 'stack', 'at x']) expect(text, `${status} ${bad}`).not.toContain(bad);
    }
    expect(await approvals(snapshot.id)).toBe(0);
  });

  it('with a token verifier registered, the dev header cannot pick another identity', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, { success: true, data: { id: slrProjectId, roleText: 'OWNER' } });
    setTokenVerifier(async (token) => (token === 'bob-token' ? { uid: bob, email: 'b@x' } : null));
    // Bob's valid token plus a header claiming to be alice: the token wins, bob does not own the project: 404.
    const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer bob-token' });
    expect(res.status).toBe(404);
    const bad = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer forged' });
    expect([bad.status, bad.body.error.code]).toEqual([401, 'INVALID_TOKEN']);
    expect(await approvals(snapshot.id)).toBe(0);
  });

  it('the decision is recorded with the role and the caller', async () => {
    const { project, snapshot, slrProjectId, revision } = await ready();
    roleAnswer(slrProjectId, { success: true, data: { id: slrProjectId, roleText: 'OWNER' } });
    const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' });
    expect(res.body.data.approval).toMatchObject({ slrRole: 'OWNER', decidedBy: alice, targetHash: revision.contentHash });
  });
});

describe('no path records a decision without the check', () => {
  beforeEach(() => { env.REQUIRE_SLR_OWNER_FOR_APPROVAL = true; });

  it('PUT with approval-looking fields is refused, and content cannot embed an approval', async () => {
    const { project, snapshot, content } = await ready();
    for (const body of [
      { baseVersion: 1, content, approved: true },
      { baseVersion: 1, content, approval: { decision: 'APPROVED' } },
      { baseVersion: 1, content: { ...content, approval: { status: 'APPROVED' } } },
      { baseVersion: 1, content: { ...content, sections: content.sections.map((s: any) => ({ ...s, approved: true })) } },
    ]) {
      const res = await put(project.id, snapshot.id, body);
      expect(res.status).toBe(400);
    }
    // A plain title saying APPROVED is just a title.
    content.sections[3].subsections[0].title = 'APPROVED';
    expect((await put(project.id, snapshot.id, { baseVersion: 1, content })).status).toBe(201);
    expect(await approvals(snapshot.id)).toBe(0);
    expect(fake.requests).toHaveLength(0);
    expect((await get(project.id, snapshot.id)).body.data.approval.status).toBe('PENDING');
  });

  it('POST create with approval fields is refused', async () => {
    const { project, snapshot } = await setup();
    expect((await create(project.id, snapshot.id, alice, { approved: true })).status).toBe(400);
    expect((await create(project.id, snapshot.id, alice, { decision: 'APPROVED' })).status).toBe(400);
  });

  it('approve body cannot choose the decision, decider, role or target', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    roleAnswer(slrProjectId, { success: true, data: { id: slrProjectId, roleText: 'OWNER' } });
    for (const extra of [{ decision: 'REJECTED' }, { slrRole: 'OWNER' }, { decidedBy: bob }, { targetId: 'x' }, { stage: 'H2' }]) {
      const res = await approve(project.id, snapshot.id, { version: 1, ...extra }, alice, { Authorization: 'Bearer t' });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await approvals(snapshot.id)).toBe(0);
  });

  it('the approval lands on content the owner named: version check and targetHash equals the revision hash', async () => {
    const { project, snapshot, slrProjectId, content } = await ready();
    roleAnswer(slrProjectId, { success: true, data: { id: slrProjectId, roleText: 'OWNER' } });
    // Race: an edit and an approval of version 1 at the same time. Either the approval is of v1 (and v2 is pending), or 409.
    const edit = structuredClone(content); edit.sections[3].subsections[0].title = 'Racing edit';
    const [p, a] = await Promise.all([put(project.id, snapshot.id, { baseVersion: 1, content: edit }), approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' })]);
    expect(p.status).toBe(201);
    expect([201, 409]).toContain(a.status);
    const rows = await prisma.approval.findMany({ where: { manuscript: { snapshotId: snapshot.id } } });
    for (const row of rows) {
      const rev = await prisma.blueprintRevision.findUniqueOrThrow({ where: { id: row.targetId } });
      expect(rev.contentHash).toBe(row.targetHash);
      expect(rev.version).toBe(1);
    }
    expect((await get(project.id, snapshot.id)).body.data.approval.status).toBe('PENDING');
    const manuscript = await prisma.manuscript.findUniqueOrThrow({ where: { snapshotId: snapshot.id } });
    expect(await getApprovedBlueprint(manuscript.id)).toBeNull();
  });

  it('the 422 for an unapprovable blueprint is answered only after the role check, and details hold only issues', async () => {
    const { project, snapshot, slrProjectId, content } = await ready();
    content.coverage[0].subsectionIds = [];
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    roleAnswer(slrProjectId, { success: true, data: { id: slrProjectId, roleText: 'OWNER' } });
    const res = await approve(project.id, snapshot.id, { version: 2 }, alice, { Authorization: 'Bearer t' });
    expect([res.status, res.body.error.code]).toEqual([422, 'BLUEPRINT_NOT_APPROVABLE']);
    expect(Object.keys(res.body.error.details)).toEqual(['issues']);
    for (const issue of res.body.error.details.issues) expect(Object.keys(issue).sort()).toEqual(expect.arrayContaining(['code', 'message', 'severity']));
    // A rejection of the same unapprovable blueprint is allowed.
    expect((await reject(project.id, snapshot.id, { version: 2, note: 'fix coverage' }, alice, { Authorization: 'Bearer t' })).status).toBe(201);
  });
});

describe('unstorable text never becomes a 500', () => {
  it.each([
    ['NUL in a subsection title', (c: any) => { c.sections[3].subsections[0].title = 'a\u0000b'; }],
    ['lone surrogate in a subsection title', (c: any) => { c.sections[3].subsections[0].title = 'a\ud800b'; }],
    ['NUL in purpose', (c: any) => { c.sections[3].subsections[0].purpose = 'p\u0000'; }],
    ['NUL in a subsection id', (c: any) => { c.sections[3].subsections[0].id = 'id\u0000'; }],
    ['NUL in a not-applicable reason', (c: any) => { c.coverage[0].notApplicableReason = 'r\u0000'; }],
    ['NUL in a section key', (c: any) => { c.sections[0].key = 'abs\u0000tract'; }],
    ['NUL in the profile id', (c: any) => { c.profile.id = 'generic\u0000'; }],
  ])('PUT with %s answers 400', async (_name, mutate) => {
    const { project, snapshot, content } = await ready();
    mutate(content);
    const res = await put(project.id, snapshot.id, { baseVersion: 1, content });
    expect([res.status, res.body.error?.code]).toEqual([400, 'INVALID_BLUEPRINT']);
  });

  it.each([['NUL', 'ok\u0000'], ['lone surrogate', 'ok\udc00']])('approve/reject with %s in the note answers 400', async (_n, note) => {
    const { project, snapshot } = await ready();
    const a = await approve(project.id, snapshot.id, { version: 1, note });
    const r = await reject(project.id, snapshot.id, { version: 1, note });
    const stored = await prisma.approval.findMany({ where: { manuscript: { snapshotId: snapshot.id } }, select: { note: true } });
    console.log(`[qa] note ${JSON.stringify(note)} -> statuses ${a.status}/${r.status}, stored ${JSON.stringify(stored)}`);
    expect([a.status, r.status]).toEqual([400, 400]);
    expect(await approvals(snapshot.id)).toBe(0);
  });

  it('POST create with NUL in profileId answers 4xx', async () => {
    const { project, snapshot } = await setup();
    const res = await create(project.id, snapshot.id, alice, { profileId: 'x\u0000' });
    expect(res.status).toBeLessThan(500);
  });
});

describe('a blueprint generated from a real-shaped snapshot can be edited and saved back', () => {
  it('a theme title over 300 characters does not lock the user out of saving other edits', async () => {
    const { project, snapshot, content } = await ready(alice, (raw) => { raw.corpus.claims[0].title = `Long theme ${'x'.repeat(400)}`; });
    // The user changes something unrelated (the Discussion title), keeping the generated theme subsection as is.
    content.sections.find((s: any) => s.key === 'discussion').subsections[1].title = 'Limitations of the evidence';
    const res = await put(project.id, snapshot.id, { baseVersion: 1, content });
    console.log(`[qa] roundtrip ${res.status} ${res.body.error?.message}`);
    expect(res.status).toBe(201);
  });

  it('an empty theme title does not lock the user out either', async () => {
    const { project, snapshot, content } = await ready(alice, (raw) => { raw.corpus.claims[0].title = ''; });
    content.sections.find((s: any) => s.key === 'discussion').subsections[1].title = 'Limitations of the evidence';
    const res = await put(project.id, snapshot.id, { baseVersion: 1, content });
    console.log(`[qa] roundtrip ${res.status} ${res.body.error?.message}`);
    expect(res.status).toBe(201);
  });
});

describe('HTTP layer edge cases', () => {
  it('JSON body shapes: array, null, string, number, empty, text/plain, duplicate keys, __proto__', async () => {
    const { project, snapshot, content } = await ready();
    const url = base(project.id, snapshot.id);
    const send = (method: 'put' | 'post', path: string, raw: string, type = 'application/json') =>
      request(app)[method](path).set(as(alice)).set('content-type', type).send(raw);
    for (const raw of ['[]', 'null', '"x"', '5', '', 'true', '{"baseVersion":1}']) {
      const res = await send('put', url, raw);
      expect([400], `put ${raw}`).toContain(res.status);
      const a = await send('post', `${url}/approve`, raw);
      expect([400], `approve ${raw}`).toContain(a.status);
    }
    // text/plain is not parsed: body is {} -> 400.
    expect((await send('put', url, JSON.stringify({ baseVersion: 1, content }), 'text/plain')).status).toBe(400);
    expect((await send('post', `${url}/approve`, '{"version":1}', 'text/plain')).status).toBe(400);
    // Duplicate keys: last wins, no crash.
    const dup = await send('post', `${url}/approve`, '{"version":7,"version":1}');
    expect(dup.status).toBe(201);
    // __proto__ inside content is an unknown key -> 400, no pollution.
    const proto = JSON.stringify({ baseVersion: 1, content }).replace('"content":{', '"content":{"__proto__":{"admin":true},');
    expect((await send('put', url, proto)).status).toBe(400);
    const protoTop = '{"__proto__":{"version":1}}';
    expect((await send('post', `${url}/reject`, protoTop)).status).toBe(400);
    expect(({} as any).admin).toBeUndefined();
    // Huge numbers.
    for (const v of ['1e21', '9007199254740993', '-0', '1.0000000000000002', '1000001']) {
      const r = await send('post', `${url}/approve`, `{"version":${v}}`);
      expect([400, 409], v).toContain(r.status);
    }
  });

  it('urlencoded bodies are not a way around the JSON checks', async () => {
    const { project, snapshot } = await ready();
    const res = await request(app).post(`${base(project.id, snapshot.id)}/approve`).set(as(alice)).type('form').send('version=1');
    expect(res.status).toBe(400);
  });

  it('version path parameter edge cases', async () => {
    const { project, snapshot } = await ready();
    const url = `${base(project.id, snapshot.id)}/revisions/`;
    for (const v of ['01', '+1', '%201', '1%20', '1%00', '%E2%91%A0', '0x1', '1,2', '999999999', '2147483648']) {
      const res = await request(app).get(url + v).set(as(alice));
      expect([400, 404], v).toContain(res.status);
    }
    expect((await request(app).get(`${url}%ZZ`).set(as(alice))).status).toBe(400);
    expect((await request(app).get(`${url}1`).set(as(alice))).status).toBe(200);
  });

  it('odd snapshot / project ids give 404 or 400, never 500', async () => {
    const { project } = await ready();
    for (const id of ['%00', 'x'.repeat(300), '%F0%9F%98%80', '%ED%A0%80', '..', '%2e%2e', "'; DROP TABLE x;--"]) {
      for (const res of [await get(project.id, id), await approve(project.id, id, { version: 1 }), await get(id, id)]) {
        expect([400, 404], id).toContain(res.status);
      }
    }
    expect((await get(project.id, '%ZZ')).status).toBe(400);
  });

  it('wrong methods and unknown paths answer 404 (no 500), trailing slash works', async () => {
    const { project, snapshot } = await ready();
    const url = base(project.id, snapshot.id);
    for (const [m, p] of [['delete', url], ['patch', url], ['get', `${url}/approve`], ['put', `${url}/approve`], ['delete', `${url}/revisions/1`], ['post', `${url}/revisions/1`], ['get', `${url}/reject`]] as const) {
      const res = await request(app)[m](p).set(as(alice));
      expect(res.status, `${m} ${p}`).toBe(404);
    }
    expect((await request(app).get(`${url}/`).set(as(alice))).status).toBe(200);
    expect((await request(app).get(url.replace('blueprint', 'BLUEPRINT')).set(as(alice))).status).toBe(200);
  });

  it('auth is required everywhere, including with a bogus bearer and no verifier', async () => {
    const { project, snapshot } = await ready();
    env.DEV_AUTH_ENABLED = false;
    const url = base(project.id, snapshot.id);
    for (const [m, p] of [['post', url], ['get', url], ['put', url], ['post', `${url}/approve`], ['post', `${url}/reject`], ['get', `${url}/revisions/1`]] as const) {
      expect((await request(app)[m](p).set('Authorization', 'Bearer x')).status, `${m} ${p}`).toBe(401);
      expect((await request(app)[m](p).set(as(alice))).status, `${m} ${p} dev`).toBe(401);
    }
  });

  it('a 400 does not echo a long unknown key or many unknown keys', async () => {
    const { project, snapshot, content } = await ready();
    const longKey = 'k'.repeat(100_000);
    const one = await put(project.id, snapshot.id, { baseVersion: 1, content, [longKey]: 1 });
    expect(one.status).toBe(400);
    console.log(`[qa] long-key 400 body bytes=${JSON.stringify(one.body).length}`);
    const many: Record<string, unknown> = { baseVersion: 1, content };
    for (let i = 0; i < 50_000; i += 1) many[`unknown_key_${i}`] = 1;
    const two = await put(project.id, snapshot.id, many);
    expect(two.status).toBe(400);
    console.log(`[qa] many-keys 400 body bytes=${JSON.stringify(two.body).length}`);
    expect(JSON.stringify(one.body).length).toBeLessThan(5000);
    expect(JSON.stringify(two.body).length).toBeLessThan(5000);
    const three = await approve(project.id, snapshot.id, { version: 1, [longKey]: 1 });
    expect(JSON.stringify(three.body).length).toBeLessThan(5000);
  });

  it('a body over the JSON limit answers 413', async () => {
    const { project, snapshot } = await ready();
    const original = env.JSON_BODY_LIMIT;
    // The limit is read when the app is built; use a fresh app with a small limit.
    env.JSON_BODY_LIMIT = '10kb';
    try {
      const small = createApp();
      const res = await request(small).put(base(project.id, snapshot.id)).set(as(alice)).send({ baseVersion: 1, content: { pad: 'x'.repeat(20_000) } });
      expect([res.status, res.body.error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    } finally { env.JSON_BODY_LIMIT = original; }
  });
});

describe('versions, decisions and provenance', () => {
  it('no-op calls write no provenance; each created version or decision writes exactly one', async () => {
    const { project, snapshot, content } = await ready();
    const after = async () => events(snapshot.id);
    expect(await after()).toBe(1);
    await create(project.id, snapshot.id); // no-op
    await put(project.id, snapshot.id, { baseVersion: 1, content }); // no-op
    await put(project.id, snapshot.id, { baseVersion: 5, content }); // 409
    expect(await after()).toBe(1);
    content.sections[3].subsections[0].title = 'v2';
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    expect(await after()).toBe(2);
    await approve(project.id, snapshot.id, { version: 1 }); // 409
    await approve(project.id, snapshot.id, { version: 2 });
    await approve(project.id, snapshot.id, { version: 2 }); // no-op
    await reject(project.id, snapshot.id, { version: 2, note: 'n' });
    await reject(project.id, snapshot.id, { version: 2, note: 'n' }); // same decision, same note: no-op
    await reject(project.id, snapshot.id, { version: 2, note: 'another note' }); // a different note is a new decision
    expect(await after()).toBe(5);
    const list = await prisma.provenanceEvent.findMany({ where: { snapshotId: snapshot.id, activity: { startsWith: 'approval.H1.' } }, orderBy: { createdAt: 'asc' } });
    const rows = await prisma.approval.findMany({ where: { manuscript: { snapshotId: snapshot.id } }, orderBy: { seq: 'asc' } });
    expect(list.map((e) => (e.outputRefs as any).approvalId)).toEqual(rows.map((r) => r.id));
    expect(list.map((e) => (e.inputRefs as any).version)).toEqual([2, 2, 2]);
    expect(list.every((e) => e.projectId === project.id && e.actor === alice)).toBe(true);
  });

  it('a second reject with a different note is recorded; the same note again is not', async () => {
    const { project, snapshot } = await ready();
    await reject(project.id, snapshot.id, { version: 1, note: 'first' });
    const second = await reject(project.id, snapshot.id, { version: 1, note: 'second, more detailed' });
    expect([second.status, second.body.data.created, second.body.data.approval.note]).toEqual([201, true, 'second, more detailed']);
    const again = await reject(project.id, snapshot.id, { version: 1, note: 'second, more detailed' });
    expect([again.status, again.body.data.created]).toEqual([200, false]);
  });

  it('GET versions are ordered and gap-free after a chain of edits', async () => {
    const { project, snapshot, content } = await ready();
    for (let v = 1; v <= 5; v += 1) {
      content.sections[3].subsections[0].title = `edit ${v}`;
      expect((await put(project.id, snapshot.id, { baseVersion: v, content })).status).toBe(201);
    }
    const view = await get(project.id, snapshot.id);
    expect(view.body.data.versions.map((x: any) => x.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(view.body.data.revision.version).toBe(6);
  });

  it('getApprovedBlueprint follows the latest decision by seq', async () => {
    const { project, snapshot } = await ready();
    const manuscript = await prisma.manuscript.findUniqueOrThrow({ where: { snapshotId: snapshot.id } });
    await approve(project.id, snapshot.id, { version: 1 });
    expect(await getApprovedBlueprint(manuscript.id)).not.toBeNull();
    await reject(project.id, snapshot.id, { version: 1, note: 'withdrawn' });
    expect(await getApprovedBlueprint(manuscript.id)).toBeNull();
    expect(await getApprovedBlueprint('no-such-manuscript')).toBeNull();
  });
});

describe('append-only and protected rows', () => {
  // Every probe runs in a transaction that is rolled back, so a missing trigger cannot damage the shared database.
  const probe = async (sql: string) => {
    let inner: unknown = null;
    await prisma.$transaction(async (tx) => {
      try { await tx.$executeRawUnsafe(sql); } catch (error) { inner = error; throw error; }
      throw new Error('ROLLBACK_PROBE_SUCCEEDED');
    }).catch((error: unknown) => { if (!inner) inner = error; });
    return String((inner as Error)?.message ?? inner);
  };

  it('raw UPDATE, DELETE, TRUNCATE are refused on BlueprintRevision and Approval', async () => {
    const { project, snapshot, revision } = await ready();
    await approve(project.id, snapshot.id, { version: 1 });
    const row = await prisma.approval.findFirstOrThrow({ where: { manuscript: { snapshotId: snapshot.id } } });
    for (const sql of [
      `UPDATE "BlueprintRevision" SET "contentHash"='x' WHERE id='${revision.id}'`,
      `UPDATE "BlueprintRevision" SET "content"='{}'::jsonb WHERE id='${revision.id}'`,
      `DELETE FROM "BlueprintRevision" WHERE id='${revision.id}'`,
      `UPDATE "Approval" SET decision='REJECTED' WHERE id='${row.id}'`,
      `UPDATE "Approval" SET seq=seq+100000 WHERE id='${row.id}'`,
      `DELETE FROM "Approval" WHERE id='${row.id}'`,
    ]) {
      expect(await probe(sql), sql).toMatch(/append-only/);
    }
    // TRUNCATE and CASCADE: statement triggers fire.
    expect(await probe('TRUNCATE "Approval"')).not.toContain('ROLLBACK_PROBE_SUCCEEDED');
    expect(await probe('TRUNCATE "BlueprintRevision"')).not.toContain('ROLLBACK_PROBE_SUCCEEDED');
    expect(await probe('TRUNCATE "Manuscript" CASCADE')).not.toContain('ROLLBACK_PROBE_SUCCEEDED');
    expect(await prisma.approval.count({ where: { id: row.id } })).toBe(1);
  });

  it('Prisma updateMany / deleteMany are refused', async () => {
    const { project, snapshot } = await ready();
    await approve(project.id, snapshot.id, { version: 1 });
    const manuscript = await prisma.manuscript.findUniqueOrThrow({ where: { snapshotId: snapshot.id } });
    await expect(prisma.approval.updateMany({ where: { manuscriptId: manuscript.id }, data: { decision: 'REJECTED' } })).rejects.toThrow();
    await expect(prisma.approval.deleteMany({ where: { manuscriptId: manuscript.id } })).rejects.toThrow();
    await expect(prisma.blueprintRevision.deleteMany({ where: { manuscriptId: manuscript.id } })).rejects.toThrow();
    await expect(prisma.blueprintRevision.updateMany({ where: { manuscriptId: manuscript.id }, data: { version: 99 } })).rejects.toThrow();
  });

  it('deleting the manuscript, snapshot or project while blueprint/approval rows exist is blocked', async () => {
    const { project, snapshot } = await ready();
    await approve(project.id, snapshot.id, { version: 1 });
    expect(await probe(`DELETE FROM "Manuscript" WHERE "snapshotId"='${snapshot.id}'`)).not.toContain('ROLLBACK_PROBE_SUCCEEDED');
    expect(await probe(`DELETE FROM "ReviewSnapshot" WHERE id='${snapshot.id}'`)).not.toContain('ROLLBACK_PROBE_SUCCEEDED');
    expect(await probe(`DELETE FROM "Project" WHERE id='${project.id}'`)).not.toContain('ROLLBACK_PROBE_SUCCEEDED');
    expect(await prisma.manuscript.count({ where: { snapshotId: snapshot.id } })).toBe(1);
  });

  it('an Approval cannot point at a revision of another manuscript (observed: no FK on targetId)', async () => {
    // Documents that targetId is a free string: a row with a dangling targetId can be inserted at DB level.
    const { snapshot } = await ready();
    const manuscript = await prisma.manuscript.findUniqueOrThrow({ where: { snapshotId: snapshot.id } });
    const msg = await probe(`INSERT INTO "Approval" (id, "manuscriptId", stage, "targetKind", "targetId", "targetHash", decision, "decidedBy", "slrRole") VALUES ('qa-${Date.now()}', '${manuscript.id}', 'H1', 'blueprint_revision', 'dangling', 'x', 'APPROVED', 'x', 'OWNER')`);
    expect(msg).toContain('ROLLBACK_PROBE_SUCCEEDED');
  });
});

describe('OpenAPI and docs accuracy', () => {
  const guide = readFileSync(new URL('../../docs/PROJECT_GUIDE.md', import.meta.url), 'utf8');
  const validatorSource = readFileSync(new URL('../../src/modules/blueprint/blueprint-validator.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../src/modules/blueprint/blueprint.service.ts', import.meta.url), 'utf8');

  it('every issue code the code can emit is listed in the M5 guide, and vice versa', () => {
    const emitted = new Set([...validatorSource.matchAll(/(?:block|warn)\('([A-Z_]+)'/g)].map((m) => m[1]));
    emitted.add('PROFILE_UNKNOWN');
    emitted.add('ISSUES_TRUNCATED'); // pushed directly after the per-code cap, not through block() or warn()
    const m5 = guide.slice(guide.indexOf('### M5'), guide.indexOf('### M6'));
    const listed = new Set([...m5.slice(m5.indexOf('Điều kiện duyệt'), m5.indexOf('H1 chỉ dành')).matchAll(/`([A-Z_]{4,})`/g)].map((m) => m[1]));
    expect([...emitted].sort()).toEqual([...listed].sort());
  });

  it('section 11 no longer says the OWNER check for H1 is missing', () => {
    const s11 = guide.slice(guide.indexOf('## 11.'), guide.indexOf('## 12.'));
    expect(s11).not.toMatch(/chưa có kiểm tra vai trò OWNER/);
  });

  it('the env table documents REQUIRE_SLR_OWNER_FOR_APPROVAL with default true, as in env.ts', () => {
    expect(guide).toMatch(/`REQUIRE_SLR_OWNER_FOR_APPROVAL` \| `true`/);
    expect(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')).toContain('REQUIRE_SLR_OWNER_FOR_APPROVAL');
  });

  it('OpenAPI documents the statuses the routes really return', () => {
    const paths = (openApiDocument as any).paths;
    const p = '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/blueprint';
    const has = (path: string, method: string, codes: string[]) => {
      const responses = Object.keys(paths[path][method].responses);
      for (const code of codes) expect(responses, `${method} ${path} ${code}`).toContain(code);
    };
    has(p, 'post', ['200', '201', '400', '401', '404']);
    has(p, 'get', ['200', '401', '404']);
    has(p, 'put', ['200', '201', '400', '401', '404', '409']);
    has(`${p}/approve`, 'post', ['200', '201', '400', '401', '403', '404', '409', '422', '502', '504']);
    has(`${p}/reject`, 'post', ['200', '201', '400', '401', '403', '404', '409', '502', '504']);
    has(`${p}/revisions/{version}`, 'get', ['200', '400', '401', '404']);
    for (const method of ['delete', 'patch']) expect(paths[p][method]).toBeUndefined();
  });

  it('the route list in section 8 names 400/404 for approve and reject', () => {
    const s8 = guide.slice(guide.indexOf('## 8.'), guide.indexOf('## 9.'));
    const line = s8.split('\n').find((l) => l.includes('/manuscript/blueprint/approve'))!;
    expect(line).toMatch(/404/);
    expect(line).toMatch(/400/);
  });
});
