import { createLogger } from '../../config/logger.js';
import { problemWithSecretBearingUrl } from '../../shared/utils/safe-url.js';
import { LlmError } from './llm.errors.js';
import { clampInteger, clampNumber, parseRetryAfter, promptHashOf, redactKey } from './llm.limits.js';
import type { LlmModelInfo, LlmProvider, LlmRequest, LlmResult, LlmUsage } from './llm.types.js';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** Where the API lives. https, or http for a server on this machine (tests). No credentials, query or fragment. */
  baseUrl: string;
  /** Longest wait for one request to the service. */
  timeoutMs: number;
  /** Longest wait for the whole call, retries and waits between them included. Default 120 s. */
  totalTimeoutMs?: number;
  /** Extra tries after the first, for a busy or failing service and for an answer of the wrong shape. */
  maxRetries: number;
  maxOutputTokens: number;
  /** Thinking tokens count against the output limit. 0 turns thinking off where the model allows it. */
  thinkingBudget?: number;
  /** Largest reply read from the service. */
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  /** Replaced in tests so retries do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const logger = createLogger('LLM');

const DEFAULT_TEMPERATURE = 0.2;
const MAX_RETRY_AFTER_MS = 10_000;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
// Statuses that mean "try again later" rather than "your request is wrong".
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425]);
const BLOCKING_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

interface RawAnswer { text: string; finishReason: string | undefined; usage: LlmUsage }

const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Models sometimes wrap JSON in a code fence even when asked not to. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1] : trimmed;
}

/**
 * Talks to the Gemini API (generateContent) and returns answers that match the caller's schema.
 * The key lives in a private field, travels only in a request header to the configured address, is never put in a URL,
 * an error, a log line or the result, and a redirect is refused so it cannot be sent anywhere else.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly #apiKey: string;
  readonly #options: GeminiOptions;
  readonly #endpoint: string;
  readonly #retryAfterMs = new WeakMap<LlmError, number>();

  constructor(options: GeminiOptions) {
    if (!options.apiKey) throw new LlmError('LLM_NOT_CONFIGURED');
    // A header value cannot hold a line break or a character outside Latin-1; find that now, not on every call.
    if (!/^[\x21-\x7E]+$/.test(options.apiKey)) throw new Error('The Gemini key contains a character that cannot be sent in a header');
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(options.model)) throw new Error('The Gemini model name is not valid');
    const problem = problemWithSecretBearingUrl(options.baseUrl, { allowLocalHttp: true });
    if (problem) throw new Error(`The Gemini address is not acceptable: ${problem}`);

    this.#apiKey = options.apiKey;
    this.#options = options;
    this.model = options.model;
    const base = new URL(options.baseUrl);
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
    this.#endpoint = new URL(`v1beta/models/${options.model}:generateContent`, base).toString();
  }

  // Printing or serialising the provider must not show the key.
  toJSON() { return { name: this.name, model: this.model }; }

  async generateStructured<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    const maxOutputTokens = clampInteger(request.maxOutputTokens, 1, this.#options.maxOutputTokens, this.#options.maxOutputTokens);
    const temperature = clampNumber(request.temperature, 0, 2, DEFAULT_TEMPERATURE);
    const sleep = this.#options.sleep ?? defaultSleep;
    const started = Date.now();
    const deadline = started + (this.#options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
    const totals: LlmUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let correction: string | undefined;
    let invalidAnswers = 0;

    try {
      for (let attempt = 1; ; attempt += 1) {
        const attemptsLeft = attempt <= this.#options.maxRetries;
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new LlmError('LLM_TIMEOUT');
          const answer = await this.#call(request, { maxOutputTokens, temperature, correction, timeoutMs: Math.min(this.#options.timeoutMs, remaining) });
          totals.inputTokens += answer.usage.inputTokens;
          totals.outputTokens += answer.usage.outputTokens;
          totals.totalTokens += answer.usage.totalTokens;

          if (answer.finishReason === 'MAX_TOKENS') throw new LlmError('LLM_OUTPUT_TRUNCATED');
          if (answer.finishReason && BLOCKING_FINISH_REASONS.has(answer.finishReason)) throw new LlmError('LLM_BLOCKED');

          let parsed: unknown;
          try { parsed = JSON.parse(stripFence(answer.text)); } catch { parsed = undefined; }
          const checked = parsed === undefined ? undefined : request.schema.safeParse(parsed);
          if (checked?.success) {
            return {
              output: checked.data,
              modelInfo: this.#info(request, temperature, maxOutputTokens),
              usage: totals,
              latencyMs: Date.now() - started,
              attempts: attempt,
            };
          }

          // An answer of the wrong shape is worth one more try with the problems named, not many.
          invalidAnswers += 1;
          if (invalidAnswers > 1 || !attemptsLeft) throw new LlmError('LLM_INVALID_OUTPUT');
          const problems = checked && !checked.success
            ? checked.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || 'answer'}: ${issue.message}`.slice(0, 160)).join('; ')
            : 'the answer was not valid JSON';
          correction = `Your previous answer was rejected (${problems}). Answer again with JSON only, in exactly the shape that was asked for.`;
        } catch (error) {
          if (!(error instanceof LlmError) || !error.retryable || !attemptsLeft) throw error;
          const wait = this.#retryDelay(error, attempt);
          // Waiting would run past the deadline: stop now instead of sleeping and then failing.
          if (Date.now() + wait >= deadline) throw new LlmError('LLM_TIMEOUT');
          await sleep(wait);
        }
      }
    } catch (error) {
      // Tokens charged for calls that did not produce a usable answer still count against the budget.
      if (error instanceof LlmError && totals.totalTokens > 0) error.usage = { ...totals };
      throw error;
    }
  }

  #info<T>(request: LlmRequest<T>, temperature: number, maxOutputTokens: number): LlmModelInfo {
    return {
      provider: this.name,
      model: this.model,
      promptTemplateId: request.promptTemplateId,
      promptTemplateVersion: request.promptTemplateVersion,
      promptHash: promptHashOf(request.system, request.prompt),
      temperature,
      maxOutputTokens,
    };
  }

  #retryDelay(error: LlmError, attempt: number): number {
    const asked = this.#retryAfterMs.get(error);
    if (asked !== undefined) return Math.min(asked, MAX_RETRY_AFTER_MS);
    return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  }

  async #call<T>(request: LlmRequest<T>, params: { maxOutputTokens: number; temperature: number; correction: string | undefined; timeoutMs: number }): Promise<RawAnswer> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const generationConfig: Record<string, unknown> = {
      temperature: params.temperature,
      maxOutputTokens: params.maxOutputTokens,
      responseMimeType: 'application/json',
    };
    if (this.#options.thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: this.#options.thinkingBudget };

    const prompt = params.correction ? `${request.prompt}\n\n${params.correction}` : request.prompt;
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    });

    let response: Response;
    try {
      response = await fetchImpl(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-goog-api-key': this.#apiKey },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(params.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new LlmError('LLM_TIMEOUT', { retryable: true });
      // A refused redirect will be refused again; asking again cannot help.
      const reason = String((error as { cause?: { message?: unknown } })?.cause?.message ?? (error as Error)?.message ?? '');
      throw new LlmError('LLM_UNREACHABLE', { retryable: !/redirect/i.test(reason) });
    }

    if (response.status === 429) {
      const error = new LlmError('LLM_RATE_LIMITED', { retryable: true });
      const asked = parseRetryAfter(response.headers.get('retry-after'));
      if (asked !== undefined) this.#retryAfterMs.set(error, asked);
      await this.#logRefusal(response);
      throw error;
    }
    if (response.status >= 500 || RETRYABLE_CLIENT_STATUSES.has(response.status)) {
      await this.#logRefusal(response);
      throw new LlmError('LLM_UPSTREAM_ERROR', { retryable: true });
    }
    if (!response.ok) {
      // 400, 401, 403, 404...: the request, the model name or the key is wrong. Asking again will not help.
      await this.#logRefusal(response);
      throw new LlmError('LLM_UPSTREAM_ERROR');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await this.#readLimited(response));
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new LlmError('LLM_TIMEOUT', { retryable: true });
      throw new LlmError('LLM_UPSTREAM_ERROR', { retryable: true });
    }
    return this.#answerFrom(payload);
  }

  /**
   * The service says why it refused (an unknown model, a key that is not valid). That is for whoever runs the server,
   * so it goes to the log, cut short and with the key, or any long part of it, removed, and never into an answer to a user.
   */
  async #logRefusal(response: Response): Promise<void> {
    let reason = '';
    try {
      const text = (await this.#readLimited(response, 4_096)).slice(0, 2_000);
      const message = (JSON.parse(text) as { error?: { message?: unknown; status?: unknown } }).error;
      reason = [message?.status, message?.message].filter((part) => typeof part === 'string').join(': ');
    } catch {
      await response.body?.cancel().catch(() => undefined);
    }
    logger.warn({ status: response.status, model: this.model, reason: redactKey(reason, this.#apiKey).slice(0, 400) }, 'The language model service refused a request');
  }

  async #readLimited(response: Response, overrideLimit?: number): Promise<string> {
    const limit = overrideLimit ?? this.#options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new LlmError('LLM_UPSTREAM_ERROR');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) { await reader.cancel().catch(() => undefined); throw new LlmError('LLM_UPSTREAM_ERROR'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  #answerFrom(payload: unknown): RawAnswer {
    const root = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, any>;
    const blockReason = root.promptFeedback?.blockReason;
    const candidate = Array.isArray(root.candidates) ? root.candidates[0] : undefined;
    if (!candidate) {
      if (typeof blockReason === 'string' && blockReason !== '') throw new LlmError('LLM_BLOCKED');
      throw new LlmError('LLM_UPSTREAM_ERROR', { retryable: true });
    }
    const parts: unknown[] = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    // Parts marked as thoughts are the model's reasoning, not the answer.
    const text = parts
      .filter((part): part is { text: string; thought?: boolean } => typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' && (part as { thought?: unknown }).thought !== true)
      .map((part) => part.text)
      .join('');
    const meta = (typeof root.usageMetadata === 'object' && root.usageMetadata !== null ? root.usageMetadata : {}) as Record<string, unknown>;
    const inputTokens = asNumber(meta.promptTokenCount);
    const outputTokens = asNumber(meta.candidatesTokenCount) + asNumber(meta.thoughtsTokenCount);
    // A total that is smaller than its own parts cannot be right; never count less than the parts.
    const totalTokens = Math.max(asNumber(meta.totalTokenCount), inputTokens + outputTokens);
    return {
      text,
      finishReason: typeof candidate.finishReason === 'string' ? candidate.finishReason : undefined,
      usage: { inputTokens, outputTokens, totalTokens },
    };
  }
}
