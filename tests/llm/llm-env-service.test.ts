import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../src/app.js';
import { env, parseEnv } from '../../src/config/env.js';
import { LlmError } from '../../src/modules/llm/llm.errors.js';
import { getLlmProvider, getLlmStatus, setLlmProvider } from '../../src/modules/llm/llm.service.js';
import { MockLlmProvider } from '../../src/modules/llm/mock.provider.js';

const dev = { NODE_ENV: 'development' };
const app = createApp();

afterEach(() => { setLlmProvider(null); env.DEV_AUTH_ENABLED = true; });

describe('settings', () => {
  it('uses no model unless there is a key', () => {
    expect(parseEnv(dev).LLM_PROVIDER).toBe('none');
    expect(parseEnv({ ...dev, GEMINI_API_KEY: 'k' }).LLM_PROVIDER).toBe('gemini');
  });

  it('treats a blank key as no key', () => {
    expect(parseEnv({ ...dev, GEMINI_API_KEY: '' }).GEMINI_API_KEY).toBeUndefined();
    expect(parseEnv({ ...dev, GEMINI_API_KEY: '   ' }).GEMINI_API_KEY).toBeUndefined();
    expect(parseEnv({ ...dev, GEMINI_API_KEY: '' }).LLM_PROVIDER).toBe('none');
  });

  it('lets an explicit choice win, and refuses gemini without a key', () => {
    expect(parseEnv({ ...dev, GEMINI_API_KEY: 'k', LLM_PROVIDER: 'none' }).LLM_PROVIDER).toBe('none');
    expect(() => parseEnv({ ...dev, LLM_PROVIDER: 'gemini' })).toThrow(/GEMINI_API_KEY/);
    expect(() => parseEnv({ ...dev, LLM_PROVIDER: 'mock' })).toThrow();
    expect(() => parseEnv({ ...dev, LLM_PROVIDER: 'openai' })).toThrow();
  });

  it('does not need a model in production', () => {
    expect(parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'p' }).LLM_PROVIDER).toBe('none');
  });

  it('only sends the key to an https address, except a server on this machine outside production', () => {
    for (const url of ['http://example.com', 'ftp://example.com', 'ws://localhost:9', 'ftp://127.0.0.1:9', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com']) {
      expect(() => parseEnv({ ...dev, GEMINI_API_BASE_URL: url }), url).toThrow(/https/);
    }
    for (const url of ['https://user:pass@example.com', 'https://example.com/?x=1', 'https://example.com/#frag', 'http://evil.example@127.0.0.1:9']) {
      expect(() => parseEnv({ ...dev, GEMINI_API_BASE_URL: url }), url).toThrow(/GEMINI_API_BASE_URL/);
    }
    expect(parseEnv({ ...dev, GEMINI_API_BASE_URL: 'https://example.com' }).GEMINI_API_BASE_URL).toBe('https://example.com');
    expect(parseEnv({ ...dev, GEMINI_API_BASE_URL: 'http://127.0.0.1:9999' }).GEMINI_API_BASE_URL).toBe('http://127.0.0.1:9999');
    expect(parseEnv({ ...dev, GEMINI_API_BASE_URL: 'http://localhost:9999' }).GEMINI_API_BASE_URL).toBe('http://localhost:9999');
    expect(() => parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'p', GEMINI_API_BASE_URL: 'http://127.0.0.1:9999' })).toThrow(/https/);
    expect(() => parseEnv({ ...dev, GEMINI_API_BASE_URL: 'not a url' })).toThrow();
  });

  it('has safe defaults', () => {
    const parsed = parseEnv(dev);
    expect(parsed).toMatchObject({
      GEMINI_MODEL: 'gemini-3.5-flash', GEMINI_THINKING_BUDGET: 0, LLM_TIMEOUT_MS: 60_000, LLM_MAX_RETRIES: 2,
      LLM_MAX_OUTPUT_TOKENS: 4_096, LLM_MAX_INPUT_CHARS: 200_000, LLM_MAX_CONCURRENCY: 4, LLM_DAILY_TOKEN_BUDGET: 0,
    });
    expect(parseEnv({ ...dev, GEMINI_THINKING_BUDGET: '' }).GEMINI_THINKING_BUDGET).toBe(0);
    expect(parseEnv(dev).LLM_TOTAL_TIMEOUT_MS).toBe(120_000);
  });

  it('treats a blank number as its default, not as 0', () => {
    const blank = parseEnv({ ...dev, LLM_MAX_RETRIES: '', LLM_TIMEOUT_MS: ' ', LLM_TOTAL_TIMEOUT_MS: '', LLM_MAX_OUTPUT_TOKENS: '', LLM_MAX_INPUT_CHARS: '', LLM_MAX_CONCURRENCY: '', LLM_DAILY_TOKEN_BUDGET: '' });
    expect(blank).toMatchObject({ LLM_MAX_RETRIES: 2, LLM_TIMEOUT_MS: 60_000, LLM_TOTAL_TIMEOUT_MS: 120_000, LLM_MAX_OUTPUT_TOKENS: 4_096, LLM_MAX_INPUT_CHARS: 200_000, LLM_MAX_CONCURRENCY: 4, LLM_DAILY_TOKEN_BUDGET: 0 });
  });

  it('refuses a key that cannot be sent in a header', () => {
    for (const key of ['AQ.line1\nline2', 'AQ.with space inside', 'AQ.tab\there', 'AQ.\u043a\u043b\u044e\u0447', 'AQ.nul\u0000x']) {
      expect(() => parseEnv({ ...dev, GEMINI_API_KEY: key }), JSON.stringify(key)).toThrow(/GEMINI_API_KEY/);
    }
  });

  it.each([
    ['GEMINI_MODEL', 'Has Spaces'], ['GEMINI_MODEL', '../etc'], ['GEMINI_MODEL', 'a/b'], ['GEMINI_MODEL', 'x'.repeat(65)],
    ['LLM_TIMEOUT_MS', '0'], ['LLM_TIMEOUT_MS', '999'], ['LLM_TIMEOUT_MS', '300001'], ['LLM_TIMEOUT_MS', 'abc'],
    ['LLM_MAX_RETRIES', '-1'], ['LLM_MAX_RETRIES', '6'], ['LLM_MAX_RETRIES', '1.5'],
    ['LLM_MAX_OUTPUT_TOKENS', '0'], ['LLM_MAX_OUTPUT_TOKENS', '65537'],
    ['LLM_MAX_INPUT_CHARS', '0'], ['LLM_MAX_INPUT_CHARS', '2000001'],
    ['LLM_MAX_CONCURRENCY', '0'], ['LLM_MAX_CONCURRENCY', '33'],
    ['LLM_DAILY_TOKEN_BUDGET', '-1'], ['LLM_DAILY_TOKEN_BUDGET', 'lots'],
    ['GEMINI_THINKING_BUDGET', '-1'], ['GEMINI_THINKING_BUDGET', '24577'],
  ])('refuses %s = %j', (key, value) => {
    expect(() => parseEnv({ ...dev, [key]: value })).toThrow();
  });

  it('never has the key in the shape that is used to describe the settings in an error', () => {
    try { parseEnv({ ...dev, GEMINI_API_KEY: 'AQ.secret-value', LLM_TIMEOUT_MS: 'bad' }); } catch (error) {
      expect(String((error as Error).message)).not.toContain('AQ.secret-value');
    }
  });
});

describe('the provider the steps use', () => {
  it('under the test settings there is none, and asking for it is a 503 that only a step needing a model sees', () => {
    expect(env.LLM_PROVIDER).toBe('none');
    expect(() => getLlmProvider()).toThrow(expect.objectContaining({ statusCode: 503, code: 'LLM_NOT_CONFIGURED' }));
    expect(getLlmStatus()).toEqual({ configured: false, provider: 'none', model: null });
  });

  it('uses the stand-in a test puts in place, through the same guard', async () => {
    const mock = new MockLlmProvider(() => ({ ok: true }));
    setLlmProvider(mock);
    expect(getLlmStatus()).toEqual({ configured: true, provider: 'mock', model: 'mock-1' });
    const provider = getLlmProvider();
    await expect(provider.generateStructured({
      promptTemplateId: 't', promptTemplateVersion: 1, system: 'x'.repeat(env.LLM_MAX_INPUT_CHARS), prompt: 'y',
      schema: z.object({ ok: z.boolean() }),
    })).rejects.toBeInstanceOf(LlmError);
    expect(mock.calls).toHaveLength(0);
  });

  it('goes back to the settings when the stand-in is removed', () => {
    setLlmProvider(new MockLlmProvider(() => ({})));
    setLlmProvider(null);
    expect(() => getLlmProvider()).toThrow(expect.objectContaining({ code: 'LLM_NOT_CONFIGURED' }));
  });
});

describe('GET /api/llm/status', () => {
  it('tells a signed-in user whether a model is ready, and never the key', async () => {
    const off = await request(app).get('/api/llm/status').set('X-Dev-User-Id', 'alice');
    expect([off.status, off.body.data]).toEqual([200, { configured: false, provider: 'none', model: null }]);

    setLlmProvider(new MockLlmProvider(() => ({})));
    const on = await request(app).get('/api/llm/status').set('X-Dev-User-Id', 'alice');
    expect(on.body.data).toEqual({ configured: true, provider: 'mock', model: 'mock-1' });
    expect(JSON.stringify(on.body)).not.toMatch(/key|secret|AQ\./i);
  });

  it('requires authentication', async () => {
    env.DEV_AUTH_ENABLED = false;
    expect((await request(app).get('/api/llm/status')).status).toBe(401);
  });

  it('offers nothing that sends text to the model', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await request(app)[method]('/api/llm/status').set('X-Dev-User-Id', 'alice').send({ prompt: 'hi' })).status, method).toBe(404);
    }
    for (const path of ['/api/llm', '/api/llm/generate', '/api/llm/complete', '/api/llm/chat', '/api/llm/test']) {
      expect([404]).toContain((await request(app).post(path).set('X-Dev-User-Id', 'alice').send({ prompt: 'hi' })).status);
    }
  });

  it('is in the OpenAPI document', async () => {
    const res = await request(app).get('/api-docs.json');
    expect(Object.keys(res.body.paths)).toContain('/api/llm/status');
  });
});
