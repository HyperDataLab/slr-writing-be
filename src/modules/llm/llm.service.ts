import { env } from '../../config/env.js';
import { GeminiProvider } from './gemini.provider.js';
import { GuardedLlmProvider } from './guarded.provider.js';
import { LlmError } from './llm.errors.js';
import type { LlmProvider, LlmStatus } from './llm.types.js';

/**
 * The provider the steps use. It is made on first use from the settings (so a missing key only matters to a step that
 * needs a model), wrapped in the guard, and kept. Tests put their own in place with `setLlmProvider`.
 */
let current: GuardedLlmProvider | null = null;
let replaced = false;

const guard = (inner: LlmProvider) => new GuardedLlmProvider(inner, {
  maxInputChars: env.LLM_MAX_INPUT_CHARS,
  maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
  maxConcurrency: env.LLM_MAX_CONCURRENCY,
  dailyTokenBudget: env.LLM_DAILY_TOKEN_BUDGET,
});

function fromSettings(): GuardedLlmProvider | null {
  if (env.LLM_PROVIDER !== 'gemini' || !env.GEMINI_API_KEY) return null;
  return guard(new GeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    baseUrl: env.GEMINI_API_BASE_URL,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxRetries: env.LLM_MAX_RETRIES,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    thinkingBudget: env.GEMINI_THINKING_BUDGET,
  }));
}

/** For tests: use this provider instead of the one in the settings. Pass null to go back to the settings. */
export function setLlmProvider(provider: LlmProvider | null): void {
  replaced = provider !== null;
  current = provider ? guard(provider) : null;
}

/** The provider to use. Throws 503 LLM_NOT_CONFIGURED when there is none, which only steps that need a model ever see. */
export function getLlmProvider(): GuardedLlmProvider {
  if (!current && !replaced) current = fromSettings();
  if (!current) throw new LlmError('LLM_NOT_CONFIGURED');
  return current;
}

/** What may be told to a signed-in user: whether a model is ready and which one. Never the key. */
export function getLlmStatus(): LlmStatus {
  try {
    const provider = getLlmProvider();
    return { configured: true, provider: provider.name, model: provider.model };
  } catch {
    return { configured: false, provider: 'none', model: null };
  }
}
