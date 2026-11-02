import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// QA for M4 GeminiProvider. Every call goes to a local FakeGemini or to an injected fetchImpl; a guard on the global fetch
// refuses any host but this machine, so the real API can never be reached from this file.
const logged = vi.hoisted(() => [] as Array<{ level: string; obj: unknown; msg: unknown }>);
vi.mock('../../src/config/logger.js', () => {
  const make = (): any => ({
    warn: (obj: unknown, msg: unknown) => logged.push({ level: 'warn', obj, msg }),
    info: (obj: unknown, msg: unknown) => logged.push({ level: 'info', obj, msg }),
    error: (obj: unknown, msg: unknown) => logged.push({ level: 'error', obj, msg }),
    debug: (obj: unknown, msg: unknown) => logged.push({ level: 'debug', obj, msg }),
    trace: () => undefined, fatal: () => undefined, child: () => make(),
  });
  return { logger: make(), createLogger: () => make() };
});

import { GeminiProvider, type GeminiOptions } from '../../src/modules/llm/gemini.provider.js';
import { GuardedLlmProvider } from '../../src/modules/llm/guarded.provider.js';
import { LlmError } from '../../src/modules/llm/llm.errors.js';
import type { LlmRequest } from '../../src/modules/llm/llm.types.js';
import { FakeGemini } from '../llm/fake-gemini.js';

const realFetch = globalThis.fetch;
vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
  const host = new URL(typeof input === 'string' ? input : String(input.url ?? input)).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('QA network guard: only local hosts');
  return realFetch(input, init);
});

const KEY = 'AQ.qa-secret-KEY-zz9-0123456789abcdef';
const fake = new FakeGemini();
const sleeps: number[] = [];
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => { fake.reset(); sleeps.length = 0; logged.length = 0; });

const schema = z.object({ summary: z.string(), count: z.number().int() }).strict();
type Out = z.infer<typeof schema>;
const provider = (over: Partial<GeminiOptions> = {}) => new GeminiProvider({
  apiKey: KEY, model: 'gemini-test', baseUrl: fake.baseUrl, timeoutMs: 2_000, maxRetries: 2, maxOutputTokens: 1_000,
  sleep: async (ms) => { sleeps.push(ms); }, ...over,
});
const req = <T = Out>(over: Partial<LlmRequest<T>> = {}): LlmRequest<T> => ({
  promptTemplateId: 'qa', promptTemplateVersion: 1, system: 'SYS', prompt: 'PROMPT', schema: schema as any, ...over,
} as LlmRequest<T>);
const good = FakeGemini.answer('{"summary":"ok","count":2}');
const code = (p: Promise<unknown>) => p.then(() => 'no error', (e: any) => (e instanceof LlmError ? `${e.statusCode}:${e.code}` : `raw:${e?.name}:${e?.message}`));
const catchErr = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e) => e);

/** Every way an object can be turned into text, joined. */
function dump(value: any): string {
  const parts: string[] = [];
  const tryPush = (f: () => unknown) => { try { parts.push(String(f())); } catch (e) { parts.push(`<${(e as Error).message}>`); } };
  tryPush(() => JSON.stringify(value));
  tryPush(() => String(value));
  tryPush(() => inspect(value, { showHidden: true, depth: 20, getters: true }));
  tryPush(() => JSON.stringify(value, Object.getOwnPropertyNames(value)));
  tryPush(() => JSON.stringify(Object.entries(value)));
  tryPush(() => inspect(structuredClone(value), { depth: 20 }));
  if (value instanceof Error) {
    tryPush(() => value.stack); tryPush(() => value.message);
    tryPush(() => inspect((value as any).cause, { depth: 20 }));
    tryPush(() => inspect(new AggregateError([value], 'agg'), { depth: 20, showHidden: true }));
  }
  return parts.join('\n');
}
const pieces = (key: string) => [key, key.slice(0, 12), key.slice(-12), Buffer.from(key).toString('base64'), encodeURIComponent(key)];
const expectNoKey = (text: string, key = KEY) => { for (const piece of pieces(key)) expect(text, piece).not.toContain(piece); };

// ---------------------------------------------------------------------------------------------------------------------
describe('key secrecy', () => {
  it('provider and guarded provider never show the key, by any way of printing', async () => {
    const p = provider();
    const g = new GuardedLlmProvider(p, { maxInputChars: 1_000, maxOutputTokens: 100, maxConcurrency: 1, dailyTokenBudget: 0 });
    expectNoKey(dump(p));
    expectNoKey(dump(g));
    expect(Object.getOwnPropertyNames(p).sort()).toEqual(['model', 'name']);
    fake.enqueue(good);
    const result = await g.generateStructured(req());
    expectNoKey(dump(result));
  });

  it('the key is only in the header: not in the URL, not in the body, on every attempt', async () => {
    fake.enqueue(FakeGemini.json(503, {}), FakeGemini.answer('nope'), good);
    await provider().generateStructured(req());
    expect(fake.requests).toHaveLength(3);
    for (const seen of fake.requests) {
      expect(seen.headers['x-goog-api-key']).toBe(KEY);
      expectNoKey(seen.url + seen.rawBody + JSON.stringify({ ...seen.headers, 'x-goog-api-key': undefined }));
    }
  });

  const echo = (status: number) => (res: any, seen: any) => {
    const k = String(seen.headers['x-goog-api-key']);
    res.statusCode = status;
    res.statusMessage = `bad key ${k}`;
    res.setHeader('x-echo-key', k);
    res.setHeader('content-type', 'application/json');
    if (status === 429) res.setHeader('retry-after', '0');
    res.end(JSON.stringify({ error: { status: `STATUS ${k}`, message: `API key ${k} is not valid`, details: [{ k }] } }));
  };

  it.each([400, 401, 403, 404, 408, 429, 500, 503])('an upstream %i that echoes the key everywhere leaks it nowhere (error or log)', async (status) => {
    fake.enqueue(echo(status));
    const error = await catchErr(provider({ maxRetries: 1 }).generateStructured(req()));
    expect(error).toBeInstanceOf(LlmError);
    expect((error as any).cause).toBeUndefined();
    expectNoKey(dump(error));
    expect(logged.length).toBeGreaterThan(0);
    expectNoKey(JSON.stringify(logged));
    // the redacted reason still tells the operator something
    expect(JSON.stringify(logged)).toContain('<key>');
  });

  it('a 200 with the key echoed in headers is fine; the result does not carry headers', async () => {
    fake.enqueue((res, seen) => { res.setHeader('x-echo', String(seen.headers['x-goog-api-key'])); good(res, seen); });
    expectNoKey(dump(await provider().generateStructured(req())));
  });

  it('a JSON-unicode-escaped echo of the key is still removed from the log', async () => {
    const escaped = KEY.split('').map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    fake.enqueue(FakeGemini.raw(400, `{"error":{"message":"key ${escaped} bad"}}`));
    await catchErr(provider({ maxRetries: 0 }).generateStructured(req()));
    expectNoKey(JSON.stringify(logged));
  });

  it('BUG (low): a fragment of the key echoed by the service (first half) is not removed from the log', async () => {
    fake.enqueue(FakeGemini.json(400, { error: { message: `key starting ${KEY.slice(0, 20)} is not valid` } }));
    await catchErr(provider({ maxRetries: 0 }).generateStructured(req()));
    expect(JSON.stringify(logged)).not.toContain(KEY.slice(0, 20));
  });

  it('a refusal body longer than the log window is not logged at all (no partial key)', async () => {
    fake.enqueue(FakeGemini.json(400, { error: { message: `${'x'.repeat(1_990)}${KEY}${'y'.repeat(1_000)}` } }));
    await catchErr(provider({ maxRetries: 0 }).generateStructured(req()));
    expectNoKey(JSON.stringify(logged));
  });

  it('redirects 301/302/303/307/308 (absolute and relative, also with the key in Location) are refused and never followed', async () => {
    let otherHits = 0;
    const other: Server = createServer((_q, s) => { otherHits += 1; s.end('{}'); });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      for (const status of [301, 302, 303, 307, 308]) {
        for (const where of ['abs', 'rel', 'key']) {
          fake.reset();
          fake.enqueue((res, seen) => {
            res.statusCode = status;
            res.setHeader('location', where === 'abs' ? `${otherUrl}/stolen` : where === 'rel' ? '/stolen' : `${otherUrl}/?k=${seen.headers['x-goog-api-key']}`);
            res.end();
          });
          const error = await catchErr(provider({ maxRetries: 0 }).generateStructured(req()));
          expect(fake.requests.map((r) => r.url), `${status} ${where}`).toEqual(['/v1beta/models/gemini-test:generateContent']);
          expectNoKey(dump(error));
        }
      }
      expect(otherHits).toBe(0);
    } finally {
      await new Promise<void>((r) => { other.closeAllConnections(); other.close(() => r()); });
    }
  });

  it('a 3xx without a Location header is refused too (fetch with redirect:error throws) - mapped to LLM_UNREACHABLE', async () => {
    fake.enqueue(FakeGemini.raw(302, ''));
    expect(await code(provider({ maxRetries: 0 }).generateStructured(req()))).toBe('502:LLM_UNREACHABLE');
    expect(fake.requests).toHaveLength(1);
  });

  it('BUG (low): a redirect is a permanent misconfiguration but is retried maxRetries times as LLM_UNREACHABLE', async () => {
    fake.enqueue(FakeGemini.redirect('/elsewhere'));
    await catchErr(provider({ maxRetries: 2 }).generateStructured(req()));
    expect(fake.requests).toHaveLength(1);
  });

  describe('odd keys', () => {
    it.each([
      ['quotes', 'AQ."quoted\'key'],
      ['very long', `AQ.${'k'.repeat(5_000)}`],
    ])('a key with %s is sent intact and never leaks', async (_n, key) => {
      fake.enqueue(good);
      const p = provider({ apiKey: key });
      await p.generateStructured(req());
      expect(fake.requests[0].headers['x-goog-api-key']).toBe(key);
      expectNoKey(dump(p), key);
    });

    it.each([
      ['a newline', 'AQ.line1\nline2-secret'],
      ['a CR', 'AQ.line1\rline2-secret'],
      ['a NUL', 'AQ.nul\u0000secret'],
      ['non latin-1 unicode', 'AQ.ключ-секрет-😀'],
      ['spaces inside', 'AQ.a key with spaces secret'],
    ])('a key with %s is refused when the provider is built, and the error carries no part of the key', (_n, key) => {
      let error: unknown;
      try { provider({ apiKey: key, maxRetries: 0 }); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(Error);
      expect(fake.requests).toHaveLength(0);
      expectNoKey(dump(error), key);
      expect(dump(error)).not.toContain('secret');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('model name and baseUrl', () => {
  it.each(['..', '.', 'a\n', 'a%2f', 'a#b', 'a:b', 'a b', 'ａ', 'gemini\u0000', 'a/..', '-a', 'a?x=1', 'a\\b', ' a', 'a '])('refuses model %j', (model) => {
    expect(() => provider({ model })).toThrow();
  });

  it('the refusal of a bad model does not echo the key', () => {
    try { provider({ model: 'BAD' }); } catch (e) { expectNoKey(dump(e)); }
  });

  it('trailing slashes on baseUrl are collapsed to one', async () => {
    fake.enqueue(good);
    await provider({ baseUrl: `${fake.baseUrl}///` }).generateStructured(req());
    expect(fake.requests[0].url).toBe('/v1beta/models/gemini-test:generateContent');
  });

  it('a path prefix in baseUrl is kept (proxies)', async () => {
    fake.enqueue(good);
    await provider({ baseUrl: `${fake.baseUrl}/proxy` }).generateStructured(req());
    expect(fake.requests[0].url).toBe('/proxy/v1beta/models/gemini-test:generateContent');
  });

  it('a query string or a fragment in baseUrl is refused when the provider is built', () => {
    expect(() => provider({ baseUrl: `${fake.baseUrl}/?x=1` })).toThrow(/query or a fragment/);
    expect(() => provider({ baseUrl: `${fake.baseUrl}#frag` })).toThrow(/query or a fragment/);
  });

  it('credentials in baseUrl are refused when the provider is built, and the password is not echoed', () => {
    const withCreds = fake.baseUrl.replace('http://', 'http://user:pa55word@');
    let error: unknown;
    try { provider({ baseUrl: withCreds }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect(fake.requests).toHaveLength(0);
    expectNoKey(dump(error));
    expect(dump(error)).not.toContain('pa55word');
  });

  it('only https, or http for this machine, is accepted as the address', () => {
    for (const url of ['ftp://127.0.0.1:9', 'ws://localhost:9', 'http://example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(() => provider({ baseUrl: url }), url).toThrow();
    }
  });

  it('uppercase scheme and host in baseUrl still work', async () => {
    fake.enqueue(good);
    await provider({ baseUrl: fake.baseUrl.replace('http://', 'HTTP://') }).generateStructured(req());
    expect(fake.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('retries: exact number of requests', () => {
  const kinds: Array<[string, () => any, boolean]> = [
    ['429', () => FakeGemini.json(429, {}, { 'retry-after': '0' }), true],
    ['500', () => FakeGemini.json(500, {}), true],
    ['502', () => FakeGemini.json(502, {}), true],
    ['503', () => FakeGemini.json(503, {}), true],
    ['504', () => FakeGemini.json(504, {}), true],
    ['200 without candidates', () => FakeGemini.json(200, {}), true],
    ['200 with {error:{}}', () => FakeGemini.json(200, { error: { code: 500 } }), true],
    ['200 non-JSON body', () => FakeGemini.raw(200, '<html>'), true],
    ['400', () => FakeGemini.json(400, {}), false],
    ['401', () => FakeGemini.json(401, {}), false],
    ['403', () => FakeGemini.json(403, {}), false],
    ['404', () => FakeGemini.json(404, {}), false],
    ['409', () => FakeGemini.json(409, {}), false],
    ['413', () => FakeGemini.json(413, {}), false],
    ['422', () => FakeGemini.json(422, {}), false],
    ['MAX_TOKENS', () => FakeGemini.answer('{"summary":"x","count":1}', { finishReason: 'MAX_TOKENS' }), false],
    ['SAFETY', () => FakeGemini.answer('{}', { finishReason: 'SAFETY' }), false],
    ['promptFeedback block', () => FakeGemini.json(200, { promptFeedback: { blockReason: 'OTHER' } }), false],
  ];
  for (const [name, reply, retryable] of kinds) {
    it.each([0, 1, 2, 3, 4, 5])(`${name}: maxRetries %i`, async (maxRetries) => {
      fake.enqueue(reply());
      await code(provider({ maxRetries }).generateStructured(req()));
      expect(fake.requests).toHaveLength(retryable ? maxRetries + 1 : 1);
      expect(sleeps).toHaveLength(retryable ? maxRetries : 0);
    });
  }

  it.each([0, 1, 2, 3, 4, 5])('invalid output: maxRetries %i -> at most 2 requests', async (maxRetries) => {
    fake.enqueue(FakeGemini.answer('nope'));
    expect(await code(provider({ maxRetries }).generateStructured(req()))).toBe('502:LLM_INVALID_OUTPUT');
    expect(fake.requests).toHaveLength(Math.min(2, maxRetries + 1));
    expect(sleeps).toEqual([]);
  });

  it.each([0, 1, 2, 3, 4, 5])('unreachable (fetch throws TypeError): maxRetries %i', async (maxRetries) => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await code(provider({ maxRetries, fetchImpl }).generateStructured(req()))).toBe('502:LLM_UNREACHABLE');
    expect(calls).toBe(maxRetries + 1);
  });

  it.each([0, 1, 2])('timeout: maxRetries %i', async (maxRetries) => {
    fake.enqueue(FakeGemini.hang());
    expect(await code(provider({ maxRetries, timeoutMs: 100 }).generateStructured(req()))).toBe('504:LLM_TIMEOUT');
    expect(fake.requests).toHaveLength(maxRetries + 1);
  });

  it('a real closed port is LLM_UNREACHABLE', async () => {
    expect(await code(provider({ baseUrl: 'http://127.0.0.1:1', maxRetries: 0 }).generateStructured(req()))).toBe('502:LLM_UNREACHABLE');
  });

  it('QUESTIONABLE: 408 Request Timeout and 425 Too Early are not retried (both are transient by definition)', async () => {
    for (const status of [408, 425]) {
      fake.reset();
      fake.enqueue(FakeGemini.json(status, {}), good);
      expect(await code(provider().generateStructured(req())), String(status)).toBe('no error');
    }
  });

  it('429 -> invalid answer -> good answer works with maxRetries 2, and the corrective retry counts as an attempt', async () => {
    fake.enqueue(FakeGemini.json(429, {}, { 'retry-after': '1' }), FakeGemini.answer('nope'), good);
    const result = await provider({ maxRetries: 2 }).generateStructured(req());
    expect(result.attempts).toBe(3);
    expect(fake.requests[2].body.contents[0].parts[0].text).toContain('previous answer was rejected');
  });

  it('429 -> invalid answer with maxRetries 1 gives LLM_INVALID_OUTPUT (no budget left for the repair)', async () => {
    fake.enqueue(FakeGemini.json(429, {}, { 'retry-after': '1' }), FakeGemini.answer('nope'), good);
    expect(await code(provider({ maxRetries: 1 }).generateStructured(req()))).toBe('502:LLM_INVALID_OUTPUT');
  });

  it('invalid -> 503 -> good keeps the correction on the third request', async () => {
    fake.enqueue(FakeGemini.answer('nope'), FakeGemini.json(503, {}), good);
    const result = await provider({ maxRetries: 2 }).generateStructured(req());
    expect(result.attempts).toBe(3);
    expect(fake.requests[2].body.contents[0].parts[0].text).toContain('previous answer was rejected');
  });

  it('invalid -> invalid after a 503 in between still stops at the second invalid answer', async () => {
    fake.enqueue(FakeGemini.answer('nope'), FakeGemini.json(503, {}), FakeGemini.answer('nope'), good);
    expect(await code(provider({ maxRetries: 5 }).generateStructured(req()))).toBe('502:LLM_INVALID_OUTPUT');
    expect(fake.requests).toHaveLength(3);
  });

  it('backoff without Retry-After for maxRetries 5 doubles and is capped at 8 s', async () => {
    fake.enqueue(FakeGemini.json(500, {}));
    await code(provider({ maxRetries: 5 }).generateStructured(req()));
    expect(sleeps).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Retry-After', () => {
  const after = async (value: string | string[] | undefined) => {
    fake.enqueue((res) => {
      res.statusCode = 429;
      if (value !== undefined) res.setHeader('retry-after', value);
      res.end('{}');
    }, good);
    await provider().generateStructured(req());
    return sleeps[0];
  };

  it('BUG (medium): a 429 without Retry-After retries immediately (0 ms) instead of backing off', async () => {
    expect(await after(undefined)).toBe(500);
  });

  it('BUG (low): an empty Retry-After is read as 0 s instead of being ignored', async () => {
    expect(await after('')).toBe(500);
  });

  it.each([
    ['3', 3_000], ['0', 0], ['1.5', 1_500], ['10', 10_000], ['11', 10_000], ['1e3', 500], [' 2 ', 2_000],
    ['-1', 500], ['abc', 500], ['Infinity', 500], ['NaN', 500], ['-Infinity', 500],
  ])('Retry-After %j -> sleep %i', async (value, expected) => {
    expect(await after(value)).toBe(expected);
  });

  it('multiple Retry-After values never sleep more than the cap', async () => {
    const ms = await after(['3', '5']);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it('a hex Retry-After is bounded anyway', async () => {
    expect(await after('0x10')).toBeLessThanOrEqual(10_000);
  });

  it('BUG (low): an HTTP-date Retry-After (allowed by RFC 9110) is ignored and the default backoff is used', async () => {
    const ms = await after(new Date(Date.now() + 6_000).toUTCString());
    expect(ms).toBeGreaterThanOrEqual(3_000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it('a Retry-After on a 503 is not honoured (only 429) - documents current behaviour', async () => {
    fake.enqueue(FakeGemini.json(503, {}, { 'retry-after': '7' }), good);
    await provider().generateStructured(req());
    expect(sleeps).toEqual([500]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('time', () => {
  it('DOC: there is no overall deadline: one call can take (maxRetries+1) x timeoutMs plus sleeps', async () => {
    fake.enqueue(FakeGemini.hang());
    const started = Date.now();
    await code(provider({ maxRetries: 3, timeoutMs: 150 }).generateStructured(req()));
    const elapsed = Date.now() - started;
    expect(fake.requests).toHaveLength(4);
    expect(elapsed).toBeGreaterThanOrEqual(4 * 150 - 20);
  });

  it('the real sleep of the default implementation is used when none is injected (bounded backoff)', async () => {
    fake.enqueue(FakeGemini.json(429, {}, { 'retry-after': '0.05' }), good);
    const p = new GeminiProvider({ apiKey: KEY, model: 'gemini-test', baseUrl: fake.baseUrl, timeoutMs: 2_000, maxRetries: 1, maxOutputTokens: 10 });
    const started = Date.now();
    await p.generateStructured(req());
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('response parsing', () => {
  const body = (payload: unknown) => FakeGemini.json(200, payload);
  const okText = '{"summary":"ok","count":2}';

  it.each([
    ['candidates null', { candidates: null }],
    ['candidates an object', { candidates: { 0: { content: { parts: [{ text: okText }] } } } }],
    ['candidates empty', { candidates: [] }],
    ['candidates [null]', { candidates: [null] }],
    ['candidates a string', { candidates: 'x' }],
  ])('%s is a retried upstream error, not a crash', async (_n, payload) => {
    fake.enqueue(body(payload));
    expect(await code(provider({ maxRetries: 1 }).generateStructured(req()))).toBe('502:LLM_UPSTREAM_ERROR');
    expect(fake.requests).toHaveLength(2);
  });

  it.each([
    ['parts missing', { content: {} }],
    ['content null', { content: null }],
    ['parts null', { content: { parts: null } }],
    ['parts an object', { content: { parts: { text: okText } } }],
    ['nested parts', { content: { parts: [[{ text: okText }]] } }],
    ['text a number', { content: { parts: [{ text: 5 }] } }],
    ['text an object', { content: { parts: [{ text: { a: 1 } }] } }],
    ['only thoughts', { content: { parts: [{ text: okText, thought: true }] } }],
    ['candidate is a number', 5],
  ])('%s gives an empty answer -> corrective retry -> LLM_INVALID_OUTPUT', async (_n, candidate) => {
    fake.enqueue(body({ candidates: [candidate] }));
    expect(await code(provider().generateStructured(req()))).toBe('502:LLM_INVALID_OUTPUT');
  });

  it('thought: "true" (a string) is not treated as a thought', async () => {
    fake.enqueue(body({ candidates: [{ content: { parts: [{ text: 'x', thought: 'true' }, { text: okText }] } }] }));
    // 'x' + json is not JSON, so the corrective path runs, then the repeated reply fails again
    expect(await code(provider().generateStructured(req()))).toBe('502:LLM_INVALID_OUTPUT');
  });

  it.each([5, null, {}, ['STOP'], true, 'max_tokens', 'STOP '])('finishReason %j is treated as a normal stop', async (finishReason) => {
    fake.enqueue(body({ candidates: [{ content: { parts: [{ text: okText }] }, finishReason }] }));
    expect((await provider().generateStructured(req())).output).toEqual({ summary: 'ok', count: 2 });
  });

  it('IMAGE_SAFETY and MAX_TOKENS with a valid answer are still refused', async () => {
    fake.enqueue(FakeGemini.answer(okText, { finishReason: 'IMAGE_SAFETY' }));
    expect(await code(provider().generateStructured(req()))).toBe('422:LLM_BLOCKED');
    fake.reset();
    fake.enqueue(FakeGemini.answer(okText, { finishReason: 'MAX_TOKENS' }));
    expect(await code(provider().generateStructured(req()))).toBe('502:LLM_OUTPUT_TRUNCATED');
  });

  it('multiple candidates: only the first is used', async () => {
    fake.enqueue(body({ candidates: [{ content: { parts: [{ text: '{"summary":"first","count":1}' }] } }, { content: { parts: [{ text: '{"summary":"second","count":2}' }] } }] }));
    expect((await provider().generateStructured(req())).output.summary).toBe('first');
  });

  const usage = async (usageMetadata: unknown) => {
    fake.enqueue(body({ candidates: [{ content: { parts: [{ text: okText }] } }], usageMetadata }));
    return (await provider().generateStructured(req())).usage;
  };

  it.each([
    ['strings', { promptTokenCount: '10', candidatesTokenCount: '5', totalTokenCount: '15' }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }],
    ['negative', { promptTokenCount: -10, candidatesTokenCount: -5, totalTokenCount: -15 }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }],
    ['floats', { promptTokenCount: 10.7, candidatesTokenCount: 5.2, totalTokenCount: 16.9 }, { inputTokens: 10, outputTokens: 5, totalTokens: 16 }],
    ['thoughts only', { thoughtsTokenCount: 30 }, { inputTokens: 0, outputTokens: 30, totalTokens: 30 }],
    ['prompt missing', { candidatesTokenCount: 5, totalTokenCount: 5 }, { inputTokens: 0, outputTokens: 5, totalTokens: 5 }],
    ['usageMetadata null', null, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }],
    ['usageMetadata array', [1, 2], { inputTokens: 0, outputTokens: 0, totalTokens: 0 }],
  ])('usage %s', async (_n, meta, expected) => {
    expect(await usage(meta)).toEqual(expected);
  });

  it('huge usage stays a finite number', async () => {
    const u = await usage({ promptTokenCount: 1e300, candidatesTokenCount: 1e300, totalTokenCount: 1e308 });
    expect(Number.isFinite(u.totalTokens)).toBe(true);
  });

  it('BUG (low): a totalTokenCount smaller than prompt+candidates is believed, so the budget under-counts', async () => {
    const u = await usage({ promptTokenCount: 1_000, candidatesTokenCount: 500, totalTokenCount: 1 });
    expect(u.totalTokens).toBeGreaterThanOrEqual(u.inputTokens + u.outputTokens);
  });

  it('a body with a UTF-8 BOM parses', async () => {
    fake.enqueue(FakeGemini.raw(200, `﻿${JSON.stringify({ candidates: [{ content: { parts: [{ text: okText }] } }] })}`));
    expect((await provider().generateStructured(req())).output.count).toBe(2);
  });

  it('a gzip body is decompressed', async () => {
    const zipped = gzipSync(Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ text: okText }] } }] })));
    fake.enqueue((res) => { res.statusCode = 200; res.setHeader('content-encoding', 'gzip'); res.setHeader('content-type', 'application/json'); res.end(zipped); });
    expect((await provider().generateStructured(req())).output.count).toBe(2);
  });

  it('a gzip bomb (small on the wire, huge decompressed) is refused fast by the size limit', async () => {
    const zipped = gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x20));
    fake.enqueue((res) => { res.statusCode = 200; res.setHeader('content-encoding', 'gzip'); res.setHeader('content-length', String(zipped.length)); res.end(zipped); });
    const started = Date.now();
    expect(await code(provider({ maxRetries: 0, maxResponseBytes: 1_000_000 }).generateStructured(req()))).toBe('502:LLM_UPSTREAM_ERROR');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('invalid UTF-8 inside the text becomes U+FFFD and does not crash', async () => {
    const json = Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"summary":"AB","count":1}' }] } }] }));
    const at = json.indexOf('AB');
    json[at] = 0xff; json[at + 1] = 0xfe;
    fake.enqueue((res) => { res.statusCode = 200; res.end(json); });
    const result = await provider().generateStructured(req());
    expect(result.output.summary).toContain('�');
  });

  it('content-type text/plain on a JSON body is still parsed', async () => {
    fake.enqueue(FakeGemini.raw(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: okText }] } }] }), { 'content-type': 'text/plain' }));
    expect((await provider().generateStructured(req())).output.count).toBe(2);
  });

  it('a streaming-style JSON array body is a retried upstream error', async () => {
    fake.enqueue(FakeGemini.raw(200, JSON.stringify([{ candidates: [{ content: { parts: [{ text: okText }] } }] }])));
    expect(await code(provider({ maxRetries: 0 }).generateStructured(req()))).toBe('502:LLM_UPSTREAM_ERROR');
  });

  it.each([
    ['fence with trailing text', '```json\n{"summary":"ok","count":2}\n``` hope this helps'],
    ['two JSON objects', '{"summary":"ok","count":2}{"summary":"ok","count":3}'],
    ['partial JSON in a fence', '```json\n{"summary":"ok",\n```'],
    ['JSON with leading prose', 'Here: {"summary":"ok","count":2}'],
  ])('%s -> corrective retry then LLM_INVALID_OUTPUT', async (_n, text) => {
    fake.enqueue(FakeGemini.answer(text));
    expect(await code(provider().generateStructured(req()))).toBe('502:LLM_INVALID_OUTPUT');
    expect(fake.requests).toHaveLength(2);
  });

  it.each([
    ['```JSON fence', '```JSON\n{"summary":"ok","count":2}\n```'],
    ['bare ``` fence', '```\n{"summary":"ok","count":2}\n```'],
    ['whitespace around', '  \n {"summary":"ok","count":2} \n '],
    ['fence on one line', '```json {"summary":"ok","count":2} ```'],
  ])('%s parses', async (_n, text) => {
    fake.enqueue(FakeGemini.answer(text));
    expect((await provider().generateStructured(req())).output.count).toBe(2);
  });

  it('__proto__ / constructor keys in model output cannot pollute prototypes (passthrough schema)', async () => {
    const loose = z.object({ summary: z.string(), count: z.number() }).passthrough();
    fake.enqueue(FakeGemini.answer('{"summary":"a","count":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}}}'));
    const result = await provider().generateStructured(req({ schema: loose as any }));
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).polluted2).toBeUndefined();
    expect(Object.getPrototypeOf(result.output)).toBe(Object.prototype);
    expect((result.output as any).polluted).toBeUndefined();
  });

  it('__proto__ key with a strict schema is rejected or dropped, never polluting', async () => {
    fake.enqueue(FakeGemini.answer('{"summary":"a","count":1,"__proto__":{"polluted":true}}'));
    const outcome = await code(provider().generateStructured(req()));
    expect(['no error', '502:LLM_INVALID_OUTPUT']).toContain(outcome);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('very deep nesting in the answer does not crash the process', async () => {
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    fake.enqueue(FakeGemini.answer(deep));
    const outcome = await code(provider({ maxRetries: 0 }).generateStructured(req({ schema: z.unknown() as any })));
    expect(outcome === 'no error' || outcome.startsWith('502:')).toBe(true);
  });

  it('a 9 MB answer under the 10 MB default limit is accepted', async () => {
    const big = 'a'.repeat(9 * 1024 * 1024);
    fake.enqueue(FakeGemini.answer(JSON.stringify({ summary: big, count: 1 })));
    const result = await provider().generateStructured(req());
    expect(result.output.summary.length).toBe(big.length);
  });

  it('an 11 MB body is refused without retry', async () => {
    fake.enqueue(FakeGemini.answer(JSON.stringify({ summary: 'a'.repeat(11 * 1024 * 1024), count: 1 })));
    expect(await code(provider().generateStructured(req()))).toBe('502:LLM_UPSTREAM_ERROR');
    expect(fake.requests).toHaveLength(1);
  });

  it('1e999 becomes Infinity and fails z.number().int(), triggering the repair', async () => {
    fake.enqueue(FakeGemini.answer('{"summary":"a","count":1e999}'), good);
    expect((await provider().generateStructured(req())).attempts).toBe(2);
  });

  it('DOC: 1e999 passes a bare z.number() as Infinity (zod 3 accepts Infinity unless .finite()); steps must use .finite()/.int()', async () => {
    fake.enqueue(FakeGemini.answer('{"n":1e999}'));
    const result = await provider({ maxRetries: 0 }).generateStructured(req({ schema: z.object({ n: z.number() }) as any }));
    expect((result.output as any).n).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('schema behaviour', () => {
  it('a schema with a default fills it in', async () => {
    fake.enqueue(FakeGemini.answer('{"summary":"a"}'));
    const s = z.object({ summary: z.string(), count: z.number().default(7) });
    expect((await provider().generateStructured(req({ schema: s as any }))).output).toEqual({ summary: 'a', count: 7 });
  });

  it('a transform returns the transformed value', async () => {
    fake.enqueue(FakeGemini.answer('{"n":"41"}'));
    const s = z.object({ n: z.string() }).transform((v) => Number(v.n) + 1);
    expect((await provider().generateStructured(req({ schema: s as any }))).output).toBe(42);
  });

  it('DOC: a refine that throws escapes as a raw error (not LlmError) after the model was paid', async () => {
    fake.enqueue(good);
    const s = schema.refine(() => { throw new Error('caller schema bug'); });
    expect(await code(provider().generateStructured(req({ schema: s as any })))).toBe('raw:Error:caller schema bug');
  });

  it('DOC: an async refine makes safeParse throw synchronously; it escapes as a raw error', async () => {
    fake.enqueue(good);
    const s = schema.refine(async () => true);
    expect(await code(provider().generateStructured(req({ schema: s as any })))).toMatch(/^raw:/);
  });

  it('a refine that fails is a normal invalid answer', async () => {
    fake.enqueue(good);
    const s = schema.refine(() => false, 'never');
    expect(await code(provider().generateStructured(req({ schema: s as any })))).toBe('502:LLM_INVALID_OUTPUT');
  });

  it('the correction names the problem but never repeats the model text', async () => {
    fake.enqueue(FakeGemini.answer('{"summary":"MODEL-SAID-THIS","count":"x"}'), good);
    await provider().generateStructured(req());
    const second = fake.requests[1].body.contents[0].parts[0].text as string;
    expect(second).toContain('count');
    expect(second).not.toContain('MODEL-SAID-THIS');
  });

  it('usage of the failed first attempt is still added to a later success', async () => {
    fake.enqueue(FakeGemini.answer('nope', { usage: { promptTokenCount: 100, candidatesTokenCount: 1, totalTokenCount: 101 } }), good);
    expect((await provider().generateStructured(req())).usage.totalTokens).toBe(116);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('request parameters', () => {
  it('BUG (medium): maxOutputTokens NaN from a step removes the output ceiling (sent as null)', async () => {
    fake.enqueue(good);
    await provider({ maxOutputTokens: 500 }).generateStructured(req({ maxOutputTokens: NaN }));
    const sent = fake.requests[0].body.generationConfig.maxOutputTokens;
    expect(typeof sent).toBe('number');
    expect(sent).toBeLessThanOrEqual(500);
  });

  it('BUG (low): temperature NaN is sent as null and recorded as NaN in modelInfo', async () => {
    fake.enqueue(good);
    const result = await provider().generateStructured(req({ temperature: NaN }));
    expect(typeof fake.requests[0].body.generationConfig.temperature).toBe('number');
    expect(Number.isFinite(result.modelInfo.temperature)).toBe(true);
  });

  it('BUG (low): a fractional maxOutputTokens is sent unchanged (the API expects an integer)', async () => {
    fake.enqueue(good);
    await provider().generateStructured(req({ maxOutputTokens: 10.5 }));
    expect(Number.isInteger(fake.requests[0].body.generationConfig.maxOutputTokens)).toBe(true);
  });

  it.each([[0, 1], [-5, 1], [Infinity, 1_000], [-Infinity, 1_000]])('maxOutputTokens %s is sent as %i', async (asked, sent) => {
    fake.enqueue(good);
    await provider().generateStructured(req({ maxOutputTokens: asked }));
    expect(fake.requests[0].body.generationConfig.maxOutputTokens).toBe(sent);
  });

  it('lone surrogates and NUL in the prompt reach the server as valid escaped JSON', async () => {
    fake.enqueue(good);
    await provider().generateStructured(req({ prompt: 'a\uD800b\u0000c d' }));
    const raw = fake.requests[0].rawBody;
    expect(raw).toContain('\\ud800');
    expect(raw).toContain('\\u0000');
    expect(fake.requests[0].body.contents[0].parts[0].text).toBe('a\uD800b\u0000c d');
  });

  it('the prompt hash differs when system/prompt boundary moves', async () => {
    fake.enqueue(good, good);
    const a = await provider().generateStructured(req({ system: 'a', prompt: 'b\n---\nc' }));
    const b = await provider().generateStructured(req({ system: 'a\n---\nb', prompt: 'c' }));
    // The pair is hashed as a JSON array, so moving the boundary changes the hash.
    expect(a.modelInfo.promptHash === b.modelInfo.promptHash).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('no unhandled rejections or stuck timers', () => {
  it('many calls with mixed failures leave no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      fake.enqueue(FakeGemini.json(500, {}), FakeGemini.raw(200, 'x'), FakeGemini.answer('nope'), (res) => { res.destroy(); }, good);
      await Promise.all(Array.from({ length: 20 }, () => code(provider({ maxRetries: 1, timeoutMs: 500 }).generateStructured(req()))));
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
