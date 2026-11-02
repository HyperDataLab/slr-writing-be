import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/config/prisma.js';
import { getApprovedBlueprint } from '../../src/modules/blueprint/blueprint.service.js';
import { importSnapshot } from '../../src/modules/snapshots/snapshot-import.service.js';
import { FakeSlrBe } from '../slr-client/fake-slr-be.js';

// Integration test: needs PostgreSQL. Uses the run exported from a real slr-be and a fake slr-be for the role check.
const app = createApp();
const fake = new FakeSlrBe();
const tag = `bp-${Date.now()}`;
const alice = `${tag}-alice`;
const bob = `${tag}-bob`;
let counter = 0;
const as = (uid: string) => ({ 'X-Dev-User-Id': uid });
const real = () => JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));
const originalBase = env.SLR_API_BASE_URL;

beforeAll(async () => { await fake.start(); env.SLR_API_BASE_URL = fake.baseUrl; });
afterAll(async () => { env.SLR_API_BASE_URL = originalBase; env.REQUIRE_SLR_OWNER_FOR_APPROVAL = false; await fake.stop(); await prisma.$disconnect(); });
beforeEach(() => fake.reset());
afterEach(() => { env.DEV_AUTH_ENABLED = true; env.REQUIRE_SLR_OWNER_FOR_APPROVAL = false; });

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
const base = (projectId: string, snapshotId: string) => `/api/projects/${projectId}/snapshots/${snapshotId}/manuscript/blueprint`;
const create = (p: string, s: string, uid = alice, body: object = {}) => request(app).post(base(p, s)).set(as(uid)).send(body);
const get = (p: string, s: string, uid = alice) => request(app).get(base(p, s)).set(as(uid));
const put = (p: string, s: string, body: object, uid = alice) => request(app).put(base(p, s)).set(as(uid)).send(body);
const approve = (p: string, s: string, body: object, uid = alice, headers: Record<string, string> = {}) => request(app).post(`${base(p, s)}/approve`).set({ ...as(uid), ...headers }).send(body);
const reject = (p: string, s: string, body: object, uid = alice) => request(app).post(`${base(p, s)}/reject`).set(as(uid)).send(body);
const slrRole = (slrProjectId: string, roleText: unknown, status = 200) => fake.json(`/api/projects/${slrProjectId}`, { success: true, data: { id: slrProjectId, roleText } }, status);

/** A ready project with a first blueprint, and its content for edits. */
async function ready() {
  const s = await setup();
  const first = await create(s.project.id, s.snapshot.id);
  return { ...s, revision: first.body.data.revision, content: structuredClone(first.body.data.revision.content) };
}

describe('creating the blueprint', () => {
  it('makes version 1 from the profile and the snapshot (201)', async () => {
    const { project, snapshot } = await setup();
    const res = await create(project.id, snapshot.id);
    expect(res.status).toBe(201);
    const { revision, created } = res.body.data;
    expect(created).toBe(true);
    expect(revision).toMatchObject({ version: 1, origin: 'generated', createdBy: alice, profileId: 'generic-imrad', profileVersion: 1 });
    expect(revision.content.sections.map((s: any) => s.key)).toEqual(['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusion']);
    expect(revision.content.sections.find((s: any) => s.key === 'results').subsections).toHaveLength(3);
    expect(revision.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('never overwrites: a second call returns the latest version untouched (200)', async () => {
    const { project, snapshot, content } = await ready();
    content.sections[3].subsections[0].title = 'My own title';
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    const again = await create(project.id, snapshot.id);
    expect(again.status).toBe(200);
    expect(again.body.data.created).toBe(false);
    expect(again.body.data.revision.version).toBe(2);
    expect(again.body.data.revision.content.sections[3].subsections[0].title).toBe('My own title');
  });

  it('refuses a profile that does not exist, and unknown body fields, and stores nothing', async () => {
    const { project, snapshot } = await setup();
    expect((await create(project.id, snapshot.id, alice, { profileId: 'no-such-profile' })).status).toBe(404);
    const extra = await create(project.id, snapshot.id, alice, { profileId: 'generic-imrad', approved: true });
    expect([extra.status, extra.body.error.code]).toEqual([400, 'INVALID_REQUEST']);
    expect(await prisma.blueprintRevision.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(0);
  });

  it('writes a provenance event for the new version only', async () => {
    const { project, snapshot } = await setup();
    await create(project.id, snapshot.id); await create(project.id, snapshot.id);
    const events = await prisma.provenanceEvent.findMany({ where: { snapshotId: snapshot.id, activity: 'manuscript.blueprint.generate' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: alice, method: 'blueprint-rules@1' });
  });

  it('six calls at once make one version and no error', async () => {
    const { project, snapshot } = await setup();
    const results = await Promise.all(Array.from({ length: 6 }, () => create(project.id, snapshot.id)));
    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.blueprintRevision.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(1);
  });

  it('shares the manuscript with Methods: one manuscript per snapshot', async () => {
    const { project, snapshot } = await setup();
    await request(app).post(`/api/projects/${project.id}/snapshots/${snapshot.id}/manuscript/methods`).set(as(alice));
    await create(project.id, snapshot.id);
    expect(await prisma.manuscript.count({ where: { snapshotId: snapshot.id } })).toBe(1);
  });
});

describe('reading the blueprint', () => {
  it('returns the latest version, its issues, whether it can be approved, its approval state and the list of versions', async () => {
    const { project, snapshot } = await ready();
    const res = await get(project.id, snapshot.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ approvable: true, issues: [], approval: { status: 'PENDING', decision: null } });
    expect(res.body.data.revision.version).toBe(1);
    expect(res.body.data.versions).toHaveLength(1);
    expect(res.body.data.versions[0]).not.toHaveProperty('content');
  });

  it('answers 404 BLUEPRINT_NOT_FOUND before one is made', async () => {
    const { project, snapshot } = await setup();
    const res = await get(project.id, snapshot.id);
    expect([res.status, res.body.error.code]).toEqual([404, 'BLUEPRINT_NOT_FOUND']);
  });

  it('returns an older version with its own approval state, and refuses bad version numbers', async () => {
    const { project, snapshot, content } = await ready();
    content.sections[3].subsections[0].title = 'Changed';
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    const old = await request(app).get(`${base(project.id, snapshot.id)}/revisions/1`).set(as(alice));
    expect(old.status).toBe(200);
    expect(old.body.data.revision.version).toBe(1);
    expect((await request(app).get(`${base(project.id, snapshot.id)}/revisions/3`).set(as(alice))).body.error.code).toBe('BLUEPRINT_REVISION_NOT_FOUND');
    for (const bad of ['0', '-1', 'abc', '1.5', '1e3', '99999999999']) {
      const res = await request(app).get(`${base(project.id, snapshot.id)}/revisions/${bad}`).set(as(alice));
      expect([res.status, res.body.error.code], bad).toEqual([400, 'INVALID_VERSION']);
    }
  });
});

describe('editing the blueprint', () => {
  it('saves a change as the next version (201) and keeps the earlier one', async () => {
    const { project, snapshot, content, revision } = await ready();
    content.sections[3].subsections[0].title = 'Renamed theme';
    const res = await put(project.id, snapshot.id, { baseVersion: 1, content });
    expect(res.status).toBe(201);
    expect(res.body.data.revision).toMatchObject({ version: 2, origin: 'edited', createdBy: alice });
    const first = await request(app).get(`${base(project.id, snapshot.id)}/revisions/1`).set(as(alice));
    expect(first.body.data.revision.contentHash).toBe(revision.contentHash);
  });

  it('answers 200 and stores nothing when the content did not change, even with the keys in another order', async () => {
    const { project, snapshot, content } = await ready();
    const reordered = { profile: content.profile, coverage: content.coverage, sections: content.sections };
    const res = await put(project.id, snapshot.id, { baseVersion: 1, content: reordered });
    expect([res.status, res.body.data.created, res.body.data.revision.version]).toEqual([200, false, 1]);
  });

  it('refuses a save made from an old version (409) instead of overwriting', async () => {
    const { project, snapshot, content } = await ready();
    content.sections[3].subsections[0].title = 'First change';
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    content.sections[3].subsections[0].title = 'Second change from the same base';
    const res = await put(project.id, snapshot.id, { baseVersion: 1, content });
    expect([res.status, res.body.error.code]).toEqual([409, 'STALE_BLUEPRINT']);
    expect(await prisma.blueprintRevision.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(2);
  });

  it('with several saves from the same base at once, exactly one wins', async () => {
    const { project, snapshot, content } = await ready();
    const attempts = await Promise.all(Array.from({ length: 5 }, (_, i) => {
      const copy = structuredClone(content); copy.sections[3].subsections[0].title = `Writer ${i}`;
      return put(project.id, snapshot.id, { baseVersion: 1, content: copy });
    }));
    expect(attempts.filter((r) => r.status >= 500)).toEqual([]);
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('refuses a body of the wrong shape with 400 INVALID_BLUEPRINT and stores nothing', async () => {
    const { project, snapshot, content } = await ready();
    const bad: Array<[string, object]> = [
      ['no content', { baseVersion: 1 }],
      ['no base version', { content }],
      ['base version 0', { baseVersion: 0, content }],
      ['base version as text', { baseVersion: '1', content }],
      ['an unknown top-level field', { baseVersion: 1, content, approved: true }],
      ['an unknown content field', { baseVersion: 1, content: { ...content, approved: true } }],
      ['a blank title', { baseVersion: 1, content: { ...content, sections: content.sections.map((s: any, i: number) => (i === 3 ? { ...s, subsections: [{ ...s.subsections[0], title: '  ' }] } : s)) } }],
      ['sections as an object', { baseVersion: 1, content: { ...content, sections: {} } }],
    ];
    for (const [name, body] of bad) {
      const res = await put(project.id, snapshot.id, body);
      expect([res.status, res.body.error.code], name).toEqual([400, 'INVALID_BLUEPRINT']);
    }
    expect(await prisma.blueprintRevision.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(1);
  });

  it('does not echo the submitted content in an error', async () => {
    const { project, snapshot, content } = await ready();
    content.sections[3].subsections[0].title = 'x'.repeat(5000);
    const res = await put(project.id, snapshot.id, { baseVersion: 1, content });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body).length).toBeLessThan(1000);
  });

  it('refuses a profile that does not exist with 400', async () => {
    const { project, snapshot, content } = await ready();
    content.profile.id = 'no-such-profile';
    const res = await put(project.id, snapshot.id, { baseVersion: 1, content });
    expect([res.status, res.body.error.code]).toEqual([400, 'INVALID_BLUEPRINT']);
  });

  it('answers 404 when there is no blueprint to edit', async () => {
    const { project, snapshot } = await setup();
    const res = await put(project.id, snapshot.id, { baseVersion: 1, content: { profile: { id: 'generic-imrad', version: 1 }, sections: [{ key: 'abstract', include: true, wordBudget: { min: 1, max: 2 }, subsections: [] }], coverage: [] } });
    expect([res.status, res.body.error.code]).toEqual([404, 'BLUEPRINT_NOT_FOUND']);
  });

  it('saves a draft that has problems, and reports them instead of refusing it', async () => {
    const { project, snapshot, content } = await ready();
    content.sections.find((s: any) => s.key === 'methods').include = false;
    content.coverage[0].subsectionIds = [];
    expect((await put(project.id, snapshot.id, { baseVersion: 1, content })).status).toBe(201);
    const res = await get(project.id, snapshot.id);
    expect(res.body.data.approvable).toBe(false);
    expect(res.body.data.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(['REQUIRED_SECTION_EXCLUDED', 'COVERAGE_UNRESOLVED']));
  });

  it('writes a provenance event for each saved version', async () => {
    const { project, snapshot, content } = await ready();
    content.sections[3].subsections[0].title = 'Renamed';
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    expect(await prisma.provenanceEvent.count({ where: { snapshotId: snapshot.id, activity: 'manuscript.blueprint.edit' } })).toBe(1);
  });
});

describe('H1: approving the blueprint', () => {
  it('records an approval of the latest version (201) and shows it', async () => {
    const { project, snapshot, revision } = await ready();
    const res = await approve(project.id, snapshot.id, { version: 1, note: 'Looks right' });
    expect(res.status).toBe(201);
    expect(res.body.data.approval).toMatchObject({ stage: 'H1', targetKind: 'blueprint_revision', targetId: revision.id, targetHash: revision.contentHash, decision: 'APPROVED', note: 'Looks right', decidedBy: alice, slrRole: 'NOT_CHECKED' });
    const view = await get(project.id, snapshot.id);
    expect(view.body.data.approval.status).toBe('APPROVED');
  });

  it('answers 200 and records nothing new when it is approved again', async () => {
    const { project, snapshot } = await ready();
    await approve(project.id, snapshot.id, { version: 1 });
    const again = await approve(project.id, snapshot.id, { version: 1 });
    expect([again.status, again.body.data.created]).toEqual([200, false]);
    expect(await prisma.approval.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(1);
  });

  it('blocks the approval of a blueprint with a blocking issue (422) and lists the issues', async () => {
    const { project, snapshot, content } = await ready();
    content.coverage[0].subsectionIds = [];
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    const res = await approve(project.id, snapshot.id, { version: 2 });
    expect([res.status, res.body.error.code]).toEqual([422, 'BLUEPRINT_NOT_APPROVABLE']);
    expect(res.body.error.details.issues.map((i: any) => i.code)).toContain('COVERAGE_UNRESOLVED');
    expect(await prisma.approval.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(0);
  });

  it('approves a blueprint where an uncovered question is given a reason', async () => {
    const { project, snapshot, content } = await ready();
    content.coverage[0].subsectionIds = [];
    content.coverage[0].notApplicableReason = 'No theme addresses this question.';
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    expect((await approve(project.id, snapshot.id, { version: 2 })).status).toBe(201);
  });

  it('only the latest version can be decided (409)', async () => {
    const { project, snapshot, content } = await ready();
    content.sections[3].subsections[0].title = 'Edited';
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    const res = await approve(project.id, snapshot.id, { version: 1 });
    expect([res.status, res.body.error.code]).toEqual([409, 'STALE_BLUEPRINT']);
  });

  it('an edit after the approval leaves the new version pending and the old approval on the old version', async () => {
    const { project, snapshot, content } = await ready();
    await approve(project.id, snapshot.id, { version: 1 });
    const manuscript = await prisma.manuscript.findUniqueOrThrow({ where: { snapshotId: snapshot.id } });
    expect(await getApprovedBlueprint(manuscript.id)).not.toBeNull();

    content.sections[3].subsections[0].title = 'Edited after approval';
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    expect((await get(project.id, snapshot.id)).body.data.approval.status).toBe('PENDING');
    expect((await request(app).get(`${base(project.id, snapshot.id)}/revisions/1`).set(as(alice))).body.data.approval.status).toBe('APPROVED');
    expect(await getApprovedBlueprint(manuscript.id)).toBeNull();
  });

  it('getApprovedBlueprint gives nothing for a manuscript with no blueprint or no decision', async () => {
    const { project, snapshot } = await ready();
    const manuscript = await prisma.manuscript.findUniqueOrThrow({ where: { snapshotId: snapshot.id } });
    expect(await getApprovedBlueprint(manuscript.id)).toBeNull();
    const other = await setup();
    await request(app).post(`/api/projects/${other.project.id}/snapshots/${other.snapshot.id}/manuscript/methods`).set(as(alice));
    const bare = await prisma.manuscript.findUniqueOrThrow({ where: { snapshotId: other.snapshot.id } });
    expect(await getApprovedBlueprint(bare.id)).toBeNull();
    void project;
  });

  it('rejecting needs a note; a rejection is recorded and can be followed by an approval', async () => {
    const { project, snapshot } = await ready();
    for (const body of [{ version: 1 }, { version: 1, note: '' }, { version: 1, note: '   ' }, { version: 1, note: 'x'.repeat(2001) }]) {
      expect((await reject(project.id, snapshot.id, body)).status).toBe(400);
    }
    const rejected = await reject(project.id, snapshot.id, { version: 1, note: 'Add a section on limitations' });
    expect([rejected.status, rejected.body.data.approval.decision]).toEqual([201, 'REJECTED']);
    expect((await get(project.id, snapshot.id)).body.data.approval.status).toBe('REJECTED');
    expect((await approve(project.id, snapshot.id, { version: 1 })).status).toBe(201);
    expect((await get(project.id, snapshot.id)).body.data.approval.status).toBe('APPROVED');
    const withdrawn = await reject(project.id, snapshot.id, { version: 1, note: 'Changed my mind' });
    expect(withdrawn.status).toBe(201);
    expect((await get(project.id, snapshot.id)).body.data.approval.status).toBe('REJECTED');
    expect(await prisma.approval.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(3);
  });

  it('refuses bad bodies', async () => {
    const { project, snapshot } = await ready();
    for (const body of [{}, { version: 0 }, { version: '1' }, { version: 1.5 }, { version: 1, note: 5 }, { version: 1, extra: true }, { version: 1, note: '' }]) {
      const res = await approve(project.id, snapshot.id, body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, 'INVALID_REQUEST']);
    }
  });

  it('writes a provenance event for each decision', async () => {
    const { project, snapshot } = await ready();
    await approve(project.id, snapshot.id, { version: 1 });
    await reject(project.id, snapshot.id, { version: 1, note: 'No' });
    const events = await prisma.provenanceEvent.findMany({ where: { snapshotId: snapshot.id, activity: { startsWith: 'approval.H1.' } }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.activity)).toEqual(['approval.H1.approved', 'approval.H1.rejected']);
  });

  it('with several approvals at once, one is recorded', async () => {
    const { project, snapshot } = await ready();
    const results = await Promise.all(Array.from({ length: 6 }, () => approve(project.id, snapshot.id, { version: 1 })));
    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.approval.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(1);
  });
});

describe('H1 needs the OWNER role on slr-be', () => {
  beforeEach(() => { env.REQUIRE_SLR_OWNER_FOR_APPROVAL = true; });

  it('approves for an OWNER, records the role, and forwards the caller token to slr-be', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    slrRole(slrProjectId, 'OWNER');
    const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer owner-token' });
    expect(res.status).toBe(201);
    expect(res.body.data.approval.slrRole).toBe('OWNER');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', url: `/api/projects/${slrProjectId}`, authorization: 'Bearer owner-token' });
  });

  it.each(['LECTURER', 'REVIEWER', 'UNKNOWN', 'owner', 'Owner', 'ADMIN', '', null, 1, true])('refuses a caller whose role is %j (403) and records nothing', async (roleText) => {
    const { project, snapshot, slrProjectId } = await ready();
    slrRole(slrProjectId, roleText);
    const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' });
    expect([res.status, res.body.error.code]).toEqual([403, 'APPROVAL_REQUIRES_OWNER']);
    expect(await prisma.approval.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(0);
  });

  it('refuses when the answer has no role at all, or is not an object', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    for (const data of [{}, null, 'OWNER', ['OWNER'], 7]) {
      fake.json(`/api/projects/${slrProjectId}`, { success: true, data });
      const res = await approve(project.id, snapshot.id, { version: 1 }, alice, { Authorization: 'Bearer t' });
      expect([res.status, res.body.error.code], JSON.stringify(data)).toEqual([403, 'APPROVAL_REQUIRES_OWNER']);
    }
  });

  it('refuses rejecting too, for a caller who is not the OWNER', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    slrRole(slrProjectId, 'REVIEWER');
    const res = await reject(project.id, snapshot.id, { version: 1, note: 'No' });
    expect(res.status).toBe(403);
  });

  it('does not let a non-OWNER touch the decision even for a blueprint that cannot be approved', async () => {
    const { project, snapshot, slrProjectId, content } = await ready();
    content.coverage[0].subsectionIds = [];
    await put(project.id, snapshot.id, { baseVersion: 1, content });
    slrRole(slrProjectId, 'LECTURER');
    const res = await approve(project.id, snapshot.id, { version: 2 });
    expect([res.status, res.body.error.code]).toEqual([403, 'APPROVAL_REQUIRES_OWNER']);
  });

  it('asks slr-be first: a project the caller cannot see, or a failing slr-be, stops the decision', async () => {
    const { project, snapshot, slrProjectId } = await ready();
    const path = `/api/projects/${slrProjectId}`;
    fake.json(path, {}, 403);
    expect((await approve(project.id, snapshot.id, { version: 1 })).body.error.code).toBe('SLR_PROJECT_ACCESS_DENIED');
    fake.json(path, {}, 404);
    expect((await approve(project.id, snapshot.id, { version: 1 })).body.error.code).toBe('SLR_PROJECT_ACCESS_DENIED');
    fake.json(path, {}, 401);
    expect((await approve(project.id, snapshot.id, { version: 1 })).body.error.code).toBe('SLR_AUTH_REJECTED');
    fake.json(path, { message: 'secret internal detail' }, 500);
    const failing = await approve(project.id, snapshot.id, { version: 1 });
    expect([failing.status, failing.body.error.code]).toEqual([502, 'SLR_UPSTREAM_ERROR']);
    expect(JSON.stringify(failing.body)).not.toContain('secret');
    fake.hang(path);
    const original = env.SLR_API_TIMEOUT_MS; env.SLR_API_TIMEOUT_MS = 200;
    try { expect((await approve(project.id, snapshot.id, { version: 1 })).status).toBe(504); } finally { env.SLR_API_TIMEOUT_MS = original; }
    expect(await prisma.approval.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(0);
  });

  it('the check does not apply to creating or editing the blueprint, only to the decision', async () => {
    const { project, snapshot, content } = await ready();
    content.sections[3].subsections[0].title = 'Edited by a non-owner';
    expect((await put(project.id, snapshot.id, { baseVersion: 1, content })).status).toBe(201);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('access', () => {
  it('hides another user snapshot as 404 on every route, and writes nothing', async () => {
    const { project, snapshot, content } = await ready();
    const paths = [
      () => create(project.id, snapshot.id, bob), () => get(project.id, snapshot.id, bob),
      () => put(project.id, snapshot.id, { baseVersion: 1, content }, bob),
      () => approve(project.id, snapshot.id, { version: 1 }, bob), () => reject(project.id, snapshot.id, { version: 1, note: 'x' }, bob),
      () => request(app).get(`${base(project.id, snapshot.id)}/revisions/1`).set(as(bob)),
    ];
    for (const call of paths) expect((await call()).status).toBe(404);
    expect(await prisma.approval.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(0);
    expect(await prisma.blueprintRevision.count({ where: { manuscript: { snapshotId: snapshot.id } } })).toBe(1);
  });

  it('does not find a snapshot through another project of the same owner', async () => {
    const a = await setup(); const b = await setup();
    const res = await create(b.project.id, a.snapshot.id);
    expect([res.status, res.body.error.code]).toEqual([404, 'SNAPSHOT_NOT_FOUND']);
  });

  it('requires authentication on every route', async () => {
    const { project, snapshot } = await ready();
    env.DEV_AUTH_ENABLED = false;
    const url = base(project.id, snapshot.id);
    for (const [method, path] of [['post', url], ['get', url], ['put', url], ['post', `${url}/approve`], ['post', `${url}/reject`], ['get', `${url}/revisions/1`]] as const) {
      expect((await request(app)[method](path)).status, `${method} ${path}`).toBe(401);
    }
  });

  it('answers 404 for ids that cannot match a row', async () => {
    const { project } = await ready();
    for (const id of ['00000000-0000-0000-0000-000000000000', 'nope', '%00', 'x'.repeat(201)]) {
      expect([400, 404]).toContain((await get(project.id, id)).status);
    }
  });
});

describe('append-only tables', () => {
  it('rejects UPDATE, DELETE and TRUNCATE of blueprint versions and approvals', async () => {
    const { project, snapshot, revision } = await ready();
    await approve(project.id, snapshot.id, { version: 1 });
    const approvalRow = await prisma.approval.findFirstOrThrow({ where: { manuscript: { snapshotId: snapshot.id } } });
    await expect(prisma.blueprintRevision.update({ where: { id: revision.id }, data: { origin: 'edited' } })).rejects.toThrow();
    await expect(prisma.blueprintRevision.delete({ where: { id: revision.id } })).rejects.toThrow();
    await expect(prisma.approval.update({ where: { id: approvalRow.id }, data: { decision: 'REJECTED' } })).rejects.toThrow();
    await expect(prisma.approval.delete({ where: { id: approvalRow.id } })).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('TRUNCATE "Approval"')).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('TRUNCATE "BlueprintRevision"')).rejects.toThrow();
    const stored = await prisma.approval.findUniqueOrThrow({ where: { id: approvalRow.id } });
    expect(stored.decision).toBe('APPROVED');
  });

  it('the manuscript and its blueprint cannot be deleted while versions exist', async () => {
    const { snapshot } = await ready();
    await expect(prisma.manuscript.delete({ where: { snapshotId: snapshot.id } })).rejects.toThrow();
  });
});

describe('documentation', () => {
  it('lists the blueprint routes in the OpenAPI document', async () => {
    const res = await request(app).get('/api-docs.json');
    const paths = Object.keys(res.body.paths);
    for (const suffix of ['', '/approve', '/reject', '/revisions/{version}']) {
      expect(paths).toContain(`/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/blueprint${suffix}`);
    }
  });
});
