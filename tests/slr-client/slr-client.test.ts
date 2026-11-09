import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SlrClient, isValidRunId } from '../../src/modules/slr-client/slr-client.js';
import { buildSyntheticRun } from '../fixtures/synthetic-run.js';
import { FakeSlrBe } from './fake-slr-be.js';

const fake = new FakeSlrBe();
const PROJECT = 'slr-project-1';
const RUN = 'run-20260101000000-abc123';
const auth = { authorization: 'Bearer user-token' };
const client = (over: { timeoutMs?: number } = {}) => new SlrClient({ baseUrl: fake.baseUrl, ...over });
const fetchRun = (c = client(), runId = RUN, ctx = auth) => c.fetchRun(PROJECT, runId, ctx);

beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

const code = async (promise: Promise<unknown>) => promise.then(() => 'no error', (e) => `${e.statusCode}:${e.code}`);

describe('isValidRunId', () => {
  it.each(['run-20260101000000-abc123', 'a', 'A_b-1'])('accepts %s', (v) => expect(isValidRunId(v)).toBe(true));
  it.each(['', '../x', 'a/b', 'a b', 'a?b=1', '-lead', 'x'.repeat(129), 5, null, undefined, {}])('rejects %j', (v) => expect(isValidRunId(v)).toBe(false));
});

describe('SlrClient.fetchRun', () => {
  it('assembles run, run corpus and the MVP artifacts, and forwards the token', async () => {
    fake.serveRun(PROJECT, buildSyntheticRun());
    const input = await fetchRun();
    expect(input.run.run_id).toBe(RUN);
    expect(input.corpus.studies).toHaveLength(2);
    expect(Object.keys(input.artifacts).sort()).toEqual(['A1', 'A10', 'A2', 'A7']);
    expect(fake.requests).toHaveLength(8); // run + corpus + 4 artifacts + 2 optional supplements (404 here)
    expect(fake.requests.every((r) => r.authorization === 'Bearer user-token')).toBe(true);
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('reads the run corpus, never the live corpus', async () => {
    fake.serveRun(PROJECT, buildSyntheticRun());
    await fetchRun();
    expect(fake.requests.some((r) => r.url.endsWith('/synthesis/artifacts/corpus'))).toBe(false);
    expect(fake.requests.some((r) => r.url.endsWith(`/runs/${RUN}/artifacts/corpus`))).toBe(true);
  });

  it('accepts data returned without an envelope', async () => {
    fake.serveRun(PROJECT, buildSyntheticRun(), (data) => data);
    expect((await fetchRun()).run.run_id).toBe(RUN);
  });

  it('accepts the short {success, data} envelope', async () => {
    fake.serveRun(PROJECT, buildSyntheticRun(), (data) => ({ success: true, data }));
    expect((await fetchRun()).corpus.corpus_hash).toBe('corpus-hash-synthetic-1');
  });

  it('only fetches MVP artifacts that the run lists', async () => {
    const input = buildSyntheticRun() as any;
    input.run.artifacts = input.run.artifacts.filter((a: any) => ['A1', 'A10'].includes(a.artifact_type));
    fake.serveRun(PROJECT, input);
    const result = await fetchRun();
    expect(Object.keys(result.artifacts).sort()).toEqual(['A1', 'A10']);
    expect(fake.requests.some((r) => r.url.endsWith('/artifacts/A2'))).toBe(false);
  });

  it('does not fetch artifacts outside the MVP set', async () => {
    const input = buildSyntheticRun() as any;
    input.run.artifacts.push({ artifact_type: 'A4', artifact_id: 'A4-x', content_hash: 'c', review_status: 'approved', validation_status: 'valid' });
    fake.serveRun(PROJECT, input);
    await fetchRun();
    expect(fake.requests.some((r) => r.url.endsWith('/artifacts/A4'))).toBe(false);
  });

  it('sends no Authorization header when the caller has none', async () => {
    fake.serveRun(PROJECT, buildSyntheticRun());
    await fetchRun(client(), RUN, {});
    expect(fake.requests.every((r) => r.authorization === undefined)).toBe(true);
  });

  it('url-encodes the SLR project id', async () => {
    const weird = 'a b/c';
    fake.serveRun(encodeURIComponent(weird), buildSyntheticRun());
    await expect(client().fetchRun(weird, RUN, auth)).resolves.toBeTruthy();
  });

  it('rejects a bad run id without calling slr-be', async () => {
    expect(await code(fetchRun(client(), '../etc/passwd'))).toBe('400:INVALID_RUN_ID');
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    [401, '401:SLR_AUTH_REJECTED'],
    [403, '403:SLR_FORBIDDEN'],
    [404, '404:SLR_NOT_FOUND'],
    [500, '502:SLR_UPSTREAM_ERROR'],
    [503, '502:SLR_UPSTREAM_ERROR'],
    [418, '502:SLR_UPSTREAM_ERROR'],
  ])('maps a %i answer for the run to %s', async (status, expected) => {
    fake.json(`/api/projects/${PROJECT}/synthesis/artifacts/runs/${RUN}`, { message: 'secret internal detail' }, status);
    expect(await code(fetchRun())).toBe(expected);
  });

  it('does not leak upstream bodies or URLs in error messages', async () => {
    fake.json(`/api/projects/${PROJECT}/synthesis/artifacts/runs/${RUN}`, { message: 'secret internal detail' }, 500);
    const error: any = await fetchRun().catch((e) => e);
    expect(error.message).not.toContain('secret');
    expect(error.message).not.toContain(fake.baseUrl);
  });

  it('maps an error envelope on a 200 to an upstream error', async () => {
    fake.json(`/api/projects/${PROJECT}/synthesis/artifacts/runs/${RUN}`, { success: false, message: 'boom' });
    expect(await code(fetchRun())).toBe('502:SLR_UPSTREAM_ERROR');
  });

  it('maps a non-JSON body to SLR_INVALID_RESPONSE', async () => {
    fake.raw(`/api/projects/${PROJECT}/synthesis/artifacts/runs/${RUN}`, '<html>oops</html>');
    expect(await code(fetchRun())).toBe('502:SLR_INVALID_RESPONSE');
  });

  it('maps an empty body to SLR_INVALID_RESPONSE', async () => {
    fake.raw(`/api/projects/${PROJECT}/synthesis/artifacts/runs/${RUN}`, '');
    expect(await code(fetchRun())).toBe('502:SLR_INVALID_RESPONSE');
  });

  it('maps a run with the wrong shape to SLR_INVALID_RESPONSE', async () => {
    fake.json(`/api/projects/${PROJECT}/synthesis/artifacts/runs/${RUN}`, { success: true, data: { run_id: RUN } });
    expect(await code(fetchRun())).toBe('502:SLR_INVALID_RESPONSE');
  });

  it('rejects a response for a different run id', async () => {
    const input = buildSyntheticRun('run-20260101000000-other') as any;
    fake.serveRun(PROJECT, input);
    fake.json(`/api/projects/${PROJECT}/synthesis/artifacts/runs/${RUN}`, { success: true, data: input.run });
    fake.json(`/api/projects/${PROJECT}/synthesis/artifacts/runs/${RUN}/artifacts/corpus`, { success: true, data: input.corpus });
    expect(await code(fetchRun())).toBe('502:SLR_INVALID_RESPONSE');
  });

  it('fails when the corpus is missing (404)', async () => {
    const input = buildSyntheticRun();
    const base = fake.serveRun(PROJECT, input);
    fake.reset();
    fake.json(base, { success: true, data: input.run });
    expect(await code(fetchRun())).toBe('404:SLR_NOT_FOUND');
  });

  it('fails when the corpus has the wrong shape', async () => {
    const input = buildSyntheticRun();
    const base = fake.serveRun(PROJECT, input);
    fake.json(`${base}/artifacts/corpus`, { success: true, data: { corpus_hash: 'x' } });
    expect(await code(fetchRun())).toBe('502:SLR_INVALID_RESPONSE');
  });

  it('fails when a listed artifact cannot be fetched', async () => {
    const input = buildSyntheticRun();
    const base = fake.serveRun(PROJECT, input);
    fake.json(`${base}/artifacts/A1`, {}, 500);
    expect(await code(fetchRun())).toBe('502:SLR_UPSTREAM_ERROR');
  });

  it('fails with 404 when required artifact A1 is not found', async () => {
    const input = buildSyntheticRun();
    const base = fake.serveRun(PROJECT, input);
    fake.json(`${base}/artifacts/A1`, { message: 'Not found' }, 404);
    expect(await code(fetchRun())).toBe('404:SLR_NOT_FOUND');
  });

  it('succeeds and omits optional artifacts (A2, A7) when slr-be answers 404 for them', async () => {
    const input = buildSyntheticRun();
    const base = fake.serveRun(PROJECT, input);
    fake.json(`${base}/artifacts/A2`, { message: 'Not found' }, 404);
    fake.json(`${base}/artifacts/A7`, { message: 'Not found' }, 404);
    const result = await fetchRun();
    expect(result.artifacts.A1).toBeDefined();
    expect(result.artifacts.A10).toBeDefined();
    expect(result.artifacts.A2).toBeUndefined();
    expect(result.artifacts.A7).toBeUndefined();
  });

  it('rejects an artifact of a different type than requested', async () => {
    const input = buildSyntheticRun() as any;
    const base = fake.serveRun(PROJECT, input);
    fake.json(`${base}/artifacts/A1`, { success: true, data: { ...input.artifacts.A2 } });
    expect(await code(fetchRun())).toBe('502:SLR_INVALID_RESPONSE');
  });

  it('times out when slr-be does not answer', async () => {
    fake.hang(`/api/projects/${PROJECT}/synthesis/artifacts/runs/${RUN}`);
    expect(await code(fetchRun(client({ timeoutMs: 150 })))).toBe('504:SLR_TIMEOUT');
  });

  it('reports an unreachable slr-be as 502', async () => {
    const dead = new SlrClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 });
    expect(await code(dead.fetchRun(PROJECT, RUN, auth))).toBe('502:SLR_UNREACHABLE');
  });

  it('refuses to follow a redirect, so the token is never sent elsewhere', async () => {
    const other = new FakeSlrBe();
    await other.start();
    try {
      other.json('/stolen', { success: true });
      fake.redirect(`/api/projects/${PROJECT}/synthesis/artifacts/runs/${RUN}`, `${other.baseUrl}/stolen`);
      expect(await code(fetchRun())).toBe('502:SLR_UNREACHABLE');
      expect(other.requests).toHaveLength(0);
    } finally { await other.stop(); }
  });

  it('tolerates a trailing slash in the base URL', async () => {
    fake.serveRun(PROJECT, buildSyntheticRun());
    await expect(new SlrClient({ baseUrl: `${fake.baseUrl}///` }).fetchRun(PROJECT, RUN, auth)).resolves.toBeTruthy();
  });
});

describe('SlrClient.checkHealth', () => {
  it('reports reachable when slr-be answers /api/health', async () => {
    fake.json('/api/health', { status: 'ok' });
    const status = await client().checkHealth();
    expect(status.reachable).toBe(true);
    expect(status.baseUrl).toBe(fake.baseUrl);
    expect(typeof status.latencyMs).toBe('number');
  });

  it('reports reachable even when /api/health is 404 but server responds', async () => {
    // FakeSlrBe default is 404 for unregistered paths
    const status = await client().checkHealth();
    expect(status.reachable).toBe(true);
  });

  it('reports unreachable when slr-be host is down', async () => {
    const dead = new SlrClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
    const status = await dead.checkHealth(500);
    expect(status.reachable).toBe(false);
    expect(status.error).toBeTruthy();
  });
});
