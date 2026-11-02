import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GeminiProvider, type GeminiOptions } from '../../src/modules/llm/gemini.provider.js';
import { LlmError } from '../../src/modules/llm/llm.errors.js';
import type { LlmRequest } from '../../src/modules/llm/llm.types.js';
import { FakeGemini } from './fake-gemini.js';

const KEY = 'AQ.test-key-should-never-leak-0123456789';
const fake = new FakeGemini();
const sleeps: number[] = [];

beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => { fake.reset(); sleeps.length = 0; });

const schema = z.object({ summary: z.string(), count: z.number().int() }).strict();
const provider = (over: Partial<GeminiOptions> = {}) => new GeminiProvider({
  apiKey: KEY, model: 'gemini-test', baseUrl: fake.baseUrl, timeoutMs: 2_000, maxRetries: 2, maxOutputTokens: 1_000,
  sleep: async (ms) => { sleeps.push(ms); }, ...over,
});
const request = (over: Partial<LlmRequest<z.infer<typeof schema>>> = {}): LlmRequest<z.infer<typeof schema>> => ({
  promptTemplateId: 'test', promptTemplateVersion: 3, system: 'SYSTEM TEXT', prompt: 'PROMPT TEXT', schema, ...over,
});
const good = FakeGemini.answer('{"summary":"ok","count":2}');
const code = (promise: Promise<unknown>) => promise.then(() => 'no error', (e: LlmError) => `${e.statusCode}:${e.code}`);
const everything = (value: unknown) => JSON.stringify(value, Object.getOwnPropertyNames(value as object));

describe('a normal call', () => {
  it('sends the request the API expects, with the key only in a header', async () => {
    fake.enqueue(good);
    await provider({ thinkingBudget: 0 }).generateStructured(request({ temperature: 0.5, maxOutputTokens: 400 }));
    expect(fake.requests).toHaveLength(1);
    const seen = fake.requests[0];
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/v1beta/models/gemini-test:generateContent');
    expect(seen.headers['x-goog-api-key']).toBe(KEY);
    expect(seen.url).not.toContain(KEY);
    expect(seen.rawBody).not.toContain(KEY);
    expect(seen.body.systemInstruction.parts[0].text).toBe('SYSTEM TEXT');
    expect(seen.body.contents).toEqual([{ role: 'user', parts: [{ text: 'PROMPT TEXT' }] }]);
    expect(seen.body.generationConfig).toEqual({ temperature: 0.5, maxOutputTokens: 400, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } });
  });

  it('leaves thinking to the model when no budget is set', async () => {
    fake.enqueue(good);
    await provider().generateStructured(request());
    expect(fake.requests[0].body.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('returns the checked output with usage, timing and the record of what produced it', async () => {
    fake.enqueue(FakeGemini.answer('{"summary":"fine","count":3}', { usage: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 } }));
    const result = await provider().generateStructured(request());
    expect(result.output).toEqual({ summary: 'fine', count: 3 });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(result.attempts).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.modelInfo).toMatchObject({ provider: 'gemini', model: 'gemini-test', promptTemplateId: 'test', promptTemplateVersion: 3, temperature: 0.2, maxOutputTokens: 1_000 });
    expect(result.modelInfo.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('records a hash of the prompt, not the prompt', async () => {
    fake.enqueue(good);
    const result = await provider().generateStructured(request({ prompt: 'SECRET PAPER TEXT' }));
    expect(JSON.stringify(result)).not.toContain('SECRET PAPER TEXT');
  });

  it('adds usage across retries', async () => {
    fake.enqueue(FakeGemini.answer('not json', { usage: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }), FakeGemini.answer('{"summary":"x","count":1}', { usage: { promptTokenCount: 12, candidatesTokenCount: 6, totalTokenCount: 18 } }));
    const result = await provider().generateStructured(request());
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 11, totalTokens: 33 });
    expect(result.attempts).toBe(2);
  });

  it('reads an answer wrapped in a code fence, and joins several text parts but not the thoughts', async () => {
    fake.enqueue(FakeGemini.answer('', { parts: [{ text: 'the model thinks aloud', thought: true }, { text: '```json\n{"summary":"a",' }, { text: '"count":1}\n```' }] }));
    expect((await provider().generateStructured(request())).output).toEqual({ summary: 'a', count: 1 });
  });

  it('clamps the temperature and the output limit to what the server allows', async () => {
    fake.enqueue(good, good);
    await provider({ maxOutputTokens: 500 }).generateStructured(request({ temperature: 9, maxOutputTokens: 99_999 }));
    await provider({ maxOutputTokens: 500 }).generateStructured(request({ temperature: -3, maxOutputTokens: 0 }));
    expect(fake.requests[0].body.generationConfig).toMatchObject({ temperature: 2, maxOutputTokens: 500 });
    expect(fake.requests[1].body.generationConfig).toMatchObject({ temperature: 0, maxOutputTokens: 1 });
  });

  it('never shows the key when the provider or its result is printed', async () => {
    fake.enqueue(good);
    const p = provider();
    const result = await p.generateStructured(request());
    for (const value of [p, result, JSON.stringify(p), String(p), everything(p)]) {
      expect(typeof value === 'string' ? value : JSON.stringify(value)).not.toContain(KEY);
    }
  });
});

describe('answers of the wrong shape', () => {
  it.each([
    ['text that is not JSON', 'I think the answer is 2'],
    ['an array', '[1,2]'],
    ['the wrong field types', '{"summary":1,"count":"two"}'],
    ['an extra field', '{"summary":"a","count":1,"extra":true}'],
    ['a missing field', '{"summary":"a"}'],
    ['null', 'null'],
    ['empty text', ''],
  ])('a first answer that is %s gets one more try with the problems named, and then works', async (_name, text) => {
    fake.enqueue(FakeGemini.answer(text), good);
    const result = await provider().generateStructured(request());
    expect(result.output).toEqual({ summary: 'ok', count: 2 });
    expect(result.attempts).toBe(2);
    const second = fake.requests[1].body.contents[0].parts[0].text as string;
    expect(second).toContain('PROMPT TEXT');
    expect(second).toContain('previous answer was rejected');
    expect(second).not.toContain(text.length > 4 ? text : '\u0000never');
  });

  it('gives up after a second bad answer with LLM_INVALID_OUTPUT (502), not after many', async () => {
    fake.enqueue(FakeGemini.answer('nope'));
    expect(await code(provider().generateStructured(request()))).toBe('502:LLM_INVALID_OUTPUT');
    expect(fake.requests).toHaveLength(2);
  });

  it('does not retry a bad answer when no retries are allowed', async () => {
    fake.enqueue(FakeGemini.answer('nope'));
    expect(await code(provider({ maxRetries: 0 }).generateStructured(request()))).toBe('502:LLM_INVALID_OUTPUT');
    expect(fake.requests).toHaveLength(1);
  });

  it('does not put the model answer into the error', async () => {
    fake.enqueue(FakeGemini.answer('SECRET MODEL OUTPUT'));
    const error = await provider().generateStructured(request()).catch((e: LlmError) => e);
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain('SECRET MODEL OUTPUT');
  });
});

describe('answers that stop early or are refused', () => {
  it('reports an answer cut off by the output limit (MAX_TOKENS) as LLM_OUTPUT_TRUNCATED, without retrying', async () => {
    fake.enqueue(FakeGemini.answer('{"summary":"cut', { finishReason: 'MAX_TOKENS' }));
    expect(await code(provider().generateStructured(request()))).toBe('502:LLM_OUTPUT_TRUNCATED');
    expect(fake.requests).toHaveLength(1);
  });

  it.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'])('reports finish reason %s as LLM_BLOCKED (422), without retrying', async (reason) => {
    fake.enqueue(FakeGemini.answer('{"summary":"x","count":1}', { finishReason: reason }));
    expect(await code(provider().generateStructured(request()))).toBe('422:LLM_BLOCKED');
    expect(fake.requests).toHaveLength(1);
  });

  it('reports a prompt the service refused to read as LLM_BLOCKED', async () => {
    fake.enqueue(FakeGemini.json(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }));
    expect(await code(provider().generateStructured(request()))).toBe('422:LLM_BLOCKED');
  });

  it('treats an answer with no candidates and no reason as a failure of the service, and tries again', async () => {
    fake.enqueue(FakeGemini.json(200, {}), good);
    expect((await provider().generateStructured(request())).attempts).toBe(2);
  });

  it('accepts any other finish reason as an answer if it parses', async () => {
    fake.enqueue(FakeGemini.answer('{"summary":"x","count":1}', { finishReason: 'OTHER_UNKNOWN_REASON' }));
    expect((await provider().generateStructured(request())).output.count).toBe(1);
  });
});

describe('a busy or failing service', () => {
  it('waits as long as Retry-After says (up to 10 s) on 429, then succeeds', async () => {
    fake.enqueue(FakeGemini.json(429, { error: { message: 'slow down' } }, { 'retry-after': '3' }), good);
    const result = await provider().generateStructured(request());
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([3_000]);
  });

  it('never waits longer than 10 s, whatever Retry-After says', async () => {
    fake.enqueue(FakeGemini.json(429, {}, { 'retry-after': '86400' }), good);
    await provider().generateStructured(request());
    expect(sleeps).toEqual([10_000]);
  });

  it('backs off when there is no Retry-After: 500 ms, then 1 s', async () => {
    fake.enqueue(FakeGemini.json(503, {}), FakeGemini.json(503, {}), good);
    expect((await provider().generateStructured(request())).attempts).toBe(3);
    expect(sleeps).toEqual([500, 1_000]);
  });

  it('reports a service that keeps answering 429 as LLM_RATE_LIMITED (503) after the retries, and makes at most 3 requests', async () => {
    fake.enqueue(FakeGemini.json(429, {}));
    expect(await code(provider().generateStructured(request()))).toBe('503:LLM_RATE_LIMITED');
    expect(fake.requests).toHaveLength(3);
  });

  it('reports a service that keeps answering 5xx as LLM_UPSTREAM_ERROR (502)', async () => {
    fake.enqueue(FakeGemini.json(500, { error: { message: 'internal detail' } }));
    expect(await code(provider().generateStructured(request()))).toBe('502:LLM_UPSTREAM_ERROR');
    expect(fake.requests).toHaveLength(3);
  });

  it.each([400, 401, 403, 404, 418])('does not retry a %i: asking again would not help', async (status) => {
    fake.enqueue(FakeGemini.json(status, { error: { message: 'bad request detail' } }));
    expect(await code(provider().generateStructured(request()))).toBe('502:LLM_UPSTREAM_ERROR');
    expect(fake.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('with maxRetries 0 makes exactly one request even for a busy service', async () => {
    fake.enqueue(FakeGemini.json(503, {}));
    expect(await code(provider({ maxRetries: 0 }).generateStructured(request()))).toBe('502:LLM_UPSTREAM_ERROR');
    expect(fake.requests).toHaveLength(1);
  });

  it('never repeats what the service said, or its address, or the key, in the error', async () => {
    fake.enqueue(FakeGemini.json(400, { error: { status: 'INVALID_ARGUMENT', message: `API key ${KEY} is not valid; secret upstream detail` } }));
    const error = await provider().generateStructured(request()).catch((e: LlmError) => e);
    const text = JSON.stringify(error) + (error as Error).message + (error as Error).stack;
    for (const leaked of ['secret upstream detail', KEY, fake.baseUrl, '127.0.0.1']) expect(text).not.toContain(leaked);
  });
});

describe('time, reach and size', () => {
  it('reports a service that does not answer as LLM_TIMEOUT (504)', async () => {
    fake.enqueue(FakeGemini.hang());
    const started = Date.now();
    expect(await code(provider({ timeoutMs: 150, maxRetries: 0 }).generateStructured(request()))).toBe('504:LLM_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('tries a timed-out call again when retries are allowed', async () => {
    fake.enqueue(FakeGemini.hang(), good);
    const result = await provider({ timeoutMs: 150 }).generateStructured(request());
    expect(result.attempts).toBe(2);
  });

  it('reports a body that stalls after the headers as LLM_TIMEOUT', async () => {
    fake.enqueue((res) => { res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.write('{"candidates":'); /* never finishes */ });
    expect(await code(provider({ timeoutMs: 200, maxRetries: 0 }).generateStructured(request()))).toBe('504:LLM_TIMEOUT');
  });

  it('reports an address nobody listens on as LLM_UNREACHABLE (502)', async () => {
    expect(await code(provider({ baseUrl: 'http://127.0.0.1:1', maxRetries: 0 }).generateStructured(request()))).toBe('502:LLM_UNREACHABLE');
  });

  it('reports a connection cut in the middle of the answer as a failure, not a crash', async () => {
    fake.enqueue((res) => { res.statusCode = 200; res.write('{"cand'); res.destroy(); });
    expect(await code(provider({ maxRetries: 0 }).generateStructured(request()))).toMatch(/^50[24]:LLM_(UPSTREAM_ERROR|UNREACHABLE|TIMEOUT)$/);
  });

  describe('a redirect', () => {
    let other: Server; let otherUrl = ''; let otherHits = 0; let otherHeaders: Record<string, unknown> = {};
    beforeAll(async () => {
      other = createServer((req, res) => { otherHits += 1; otherHeaders = req.headers; res.end('{}'); });
      await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
      otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/stolen`;
    });
    afterAll(() => new Promise<void>((resolve) => { other.closeAllConnections(); other.close(() => resolve()); }));

    it('is refused, so the key is never sent anywhere else', async () => {
      fake.enqueue(FakeGemini.redirect(otherUrl));
      expect(await code(provider({ maxRetries: 0 }).generateStructured(request()))).toBe('502:LLM_UNREACHABLE');
      expect(otherHits).toBe(0);
      expect(otherHeaders['x-goog-api-key']).toBeUndefined();
    });
  });

  it.each([
    ['an empty body', ''],
    ['text that is not JSON', '<html>oops</html>'],
    ['a JSON array', '[]'],
    ['null', 'null'],
  ])('treats %s on a 200 as a failure of the service', async (_name, text) => {
    fake.enqueue(FakeGemini.raw(200, text));
    expect(await code(provider({ maxRetries: 0 }).generateStructured(request()))).toBe('502:LLM_UPSTREAM_ERROR');
  });

  it('refuses a reply bigger than the limit, by its stated length and by what actually arrives', async () => {
    fake.enqueue(FakeGemini.raw(200, 'x'.repeat(5_000), { 'content-length': '5000' }));
    expect(await code(provider({ maxResponseBytes: 1_000, maxRetries: 0 }).generateStructured(request()))).toBe('502:LLM_UPSTREAM_ERROR');
    fake.reset();
    fake.enqueue((res) => { res.statusCode = 200; res.setHeader('transfer-encoding', 'chunked'); res.write('x'.repeat(2_000)); res.write('x'.repeat(2_000)); res.end(); });
    expect(await code(provider({ maxResponseBytes: 1_000, maxRetries: 0 }).generateStructured(request()))).toBe('502:LLM_UPSTREAM_ERROR');
  });
});

describe('construction', () => {
  it('refuses to be built without a key', () => {
    expect(() => provider({ apiKey: '' })).toThrow(expect.objectContaining({ code: 'LLM_NOT_CONFIGURED' }));
  });

  it.each(['', 'Has Spaces', '../x', 'a/b', 'a?b', 'UPPER', 'x'.repeat(65)])('refuses the model name %j, which would change the address', (model) => {
    expect(() => provider({ model })).toThrow();
  });

  it('keeps the model name inside the path', async () => {
    fake.enqueue(good);
    await provider({ model: 'gemini-3.5-flash' }).generateStructured(request());
    expect(fake.requests[0].url).toBe('/v1beta/models/gemini-3.5-flash:generateContent');
  });
});
