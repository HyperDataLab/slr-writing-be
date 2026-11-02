import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { openApiDocument } from '../../src/config/openapi.js';
import { env } from '../../src/config/env.js';
import { GeminiProvider } from '../../src/modules/llm/gemini.provider.js';
import { setLlmProvider } from '../../src/modules/llm/llm.service.js';
import { MockLlmProvider } from '../../src/modules/llm/mock.provider.js';

// QA for GET /api/llm/status and the absence of any route that sends text to a model. No network.
vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('QA: no network from this file'); });

const app = createApp();
const KEY = 'AQ.http-secret-key-5150';
const as = (r: request.Test) => r.set('X-Dev-User-Id', 'alice');
afterEach(() => { setLlmProvider(null); env.DEV_AUTH_ENABLED = true; });

describe('GET /api/llm/status', () => {
  it('with a real Gemini provider in place the answer has name and model, never the key', async () => {
    setLlmProvider(new GeminiProvider({ apiKey: KEY, model: 'gemini-qa', baseUrl: 'http://127.0.0.1:9', timeoutMs: 1_000, maxRetries: 0, maxOutputTokens: 10 }));
    const res = await as(request(app).get('/api/llm/status'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { configured: true, provider: 'gemini', model: 'gemini-qa' } });
    expect(JSON.stringify(res.headers) + res.text).not.toContain(KEY);
    expect(res.text).not.toContain('http-secret');
  });

  it.each(['/api/llm/status/', '/api/llm/status?x=1', '/api/llm/status?key=1&apiKey=2', '/API/LLM/STATUS', '/api/LLM/Status'])('%s answers like the status route (Express defaults)', async (path) => {
    const res = await as(request(app).get(path));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ configured: false, provider: 'none', model: null });
  });

  it('HEAD is served by GET and has no body', async () => {
    const res = await as(request(app).head('/api/llm/status'));
    expect(res.status).toBe(200);
    expect(res.text ?? '').toBe('');
  });

  it.each(['/api/llm/status', '/api/llm/status/', '/API/LLM/STATUS', '/api/llm', '/api/llm/generate', '/api/llm/anything'])('without auth %s is 401', async (path) => {
    env.DEV_AUTH_ENABLED = false;
    for (const method of ['get', 'post', 'put', 'delete'] as const) {
      expect((await request(app)[method](path)).status, `${method} ${path}`).toBe(401);
    }
  });

  it('an empty X-Dev-User-Id falls back to the dev uid (dev auth only); still never the key', async () => {
    const res = await request(app).get('/api/llm/status').set('X-Dev-User-Id', '   ');
    expect(res.status).toBe(200);
  });

  it('a Bearer token that is garbage does not change anything in dev', async () => {
    const res = await as(request(app).get('/api/llm/status').set('Authorization', 'Bearer x'));
    expect(res.status).toBe(200);
  });
});

describe('no route sends text to the model', () => {
  it('probing many plausible paths and methods never reaches the provider', async () => {
    const mock = new MockLlmProvider(() => ({ ok: true }));
    setLlmProvider(mock);
    const paths = [
      '/api/llm', '/api/llm/', '/api/llm/generate', '/api/llm/generateStructured', '/api/llm/generate-structured', '/api/llm/complete',
      '/api/llm/completions', '/api/llm/chat', '/api/llm/chat/completions', '/api/llm/prompt', '/api/llm/ask', '/api/llm/query',
      '/api/llm/test', '/api/llm/proxy', '/api/llm/run', '/api/llm/invoke', '/api/llm/status/generate', '/api/llm/status/x',
      '/api/llm/v1beta/models/gemini-3.5-flash:generateContent', '/api/v1beta/models/gemini-3.5-flash:generateContent',
      '/v1beta/models/gemini-3.5-flash:generateContent', '/api/gemini', '/api/gemini/generate', '/api/ai', '/api/ai/generate',
      '/api/openai/v1/chat/completions', '/api/llm/%2e%2e/status', '/api/llm/..%2fstatus', '/api/llm//status', '/api/llm/status;x',
      '/api/llm/status%00', '/api/llm/status.json', '/api/projects/p/llm', '/api/projects/p/snapshots/s/llm/generate',
    ];
    const seen: string[] = [];
    for (const path of paths) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const res = await as(request(app)[method](path)).send({ prompt: 'hi', system: 'x', schema: {} });
        seen.push(`${method} ${path} ${res.status}`);
        if (!(method === 'get' && /^\/api\/llm\/+status\/?$/i.test(path))) {
          expect([400, 401, 404], `${method} ${path}`).toContain(res.status);
        }
      }
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('OPTIONS on the status path does not reach the provider', async () => {
    const mock = new MockLlmProvider(() => ({ ok: true }));
    setLlmProvider(mock);
    const res = await as(request(app).options('/api/llm/status'));
    expect(res.status).toBeLessThan(500);
    expect(mock.calls).toHaveLength(0);
  });

  it('a JSON body on GET status is ignored', async () => {
    const res = await as(request(app).get('/api/llm/status')).send({ prompt: 'x'.repeat(10_000) });
    expect(res.status).toBe(200);
  });
});

describe('OpenAPI', () => {
  it('documents exactly GET /api/llm/status under /api/llm, with 200 and 401', () => {
    const llmPaths = Object.keys(openApiDocument.paths).filter((p) => p.toLowerCase().includes('llm'));
    expect(llmPaths).toEqual(['/api/llm/status']);
    const entry = openApiDocument.paths['/api/llm/status']!;
    expect(Object.keys(entry)).toEqual(['get']);
    expect(Object.keys(entry.get!.responses).sort()).toEqual(['200', '401']);
  });

  it('the description says it never returns the key', () => {
    expect(openApiDocument.paths['/api/llm/status']!.get!.description).toMatch(/never returns the key/i);
  });
});
