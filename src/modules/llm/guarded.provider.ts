import { Semaphore } from '../../shared/utils/semaphore.js';
import { LlmError } from './llm.errors.js';
import { clampInteger, worstCaseTokens } from './llm.limits.js';
import type { LlmProvider, LlmRequest, LlmResult, LlmUsage } from './llm.types.js';

export interface GuardOptions {
  /** Most characters of system text and prompt together. Larger requests are refused before any call is made. */
  maxInputChars: number;
  /** Ceiling for the answer, whatever the step asks for. */
  maxOutputTokens: number;
  /** Most calls in flight at once; the others wait. */
  maxConcurrency: number;
  /** Most tokens per UTC day for this process. 0 = no limit. */
  dailyTokenBudget: number;
  /** Longest a call may hold its place, whatever the provider does. 0 = no limit. */
  callTimeoutMs?: number;
  /** Replaced in tests. */
  now?: () => Date;
}

/** Tokens a result or a failed call really cost. A provider that reports nonsense (NaN, negative) is charged the worst case. */
function costOf(usage: LlmUsage | undefined, fallback: number): number {
  const total = usage?.totalTokens;
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? Math.floor(total) : fallback;
}

/**
 * Limits placed around any provider, so no step can send a model more than the server allows, send too many calls at
 * once, or spend more than the daily budget.
 *
 * Spending is counted in memory from the tokens the provider reports, failed calls included when they report any. Before a
 * call is allowed, the most it could cost (a quarter of the input characters plus the whole output ceiling) is reserved,
 * so calls running side by side cannot together go far past the budget. A budget smaller than one such call allows none.
 */
export class GuardedLlmProvider implements LlmProvider {
  private readonly slots: Semaphore;
  private day = '';
  private spent = 0;
  private reserved = 0;

  constructor(private readonly inner: LlmProvider, private readonly options: GuardOptions) {
    this.slots = new Semaphore(options.maxConcurrency);
  }

  get name() { return this.inner.name; }
  get model() { return this.inner.model; }

  /** Tokens spent today, for the status page and for tests. */
  get tokensSpentToday(): number { this.rollDay(); return this.spent; }

  private rollDay() {
    const today = (this.options.now?.() ?? new Date()).toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.spent = 0; }
  }

  async generateStructured<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    const inputChars = request.system.length + request.prompt.length;
    if (inputChars > this.options.maxInputChars) throw new LlmError('LLM_INPUT_TOO_LARGE');
    // NaN, Infinity and the like fall back to the ceiling: a step cannot lift the ceiling by asking for nonsense.
    const maxOutputTokens = clampInteger(request.maxOutputTokens, 1, this.options.maxOutputTokens, this.options.maxOutputTokens);
    const estimate = worstCaseTokens(inputChars, maxOutputTokens);

    return this.slots.run(async () => {
      // Checked when it is this call's turn, so calls that waited see what the ones before them spent.
      this.rollDay();
      if (this.options.dailyTokenBudget > 0 && this.spent + this.reserved + estimate > this.options.dailyTokenBudget) {
        throw new LlmError('LLM_BUDGET_EXCEEDED');
      }
      this.reserved += estimate;
      try {
        const result = await this.withTimeout(this.inner.generateStructured({ ...request, maxOutputTokens }));
        this.rollDay();
        this.spent += costOf(result.usage, estimate);
        return result;
      } catch (error) {
        if (error instanceof LlmError && error.usage) { this.rollDay(); this.spent += costOf(error.usage, estimate); }
        throw error;
      } finally {
        this.reserved -= estimate;
      }
    });
  }

  /** A provider that never answers would hold its place forever. Give up on it after the limit; its answer, if it comes, is dropped. */
  private withTimeout<T>(work: Promise<T>): Promise<T> {
    const limit = this.options.callTimeoutMs ?? 0;
    if (limit <= 0) return work;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new LlmError('LLM_TIMEOUT')), limit); });
    // If the work fails after we gave up, nobody is waiting for it: keep that from becoming an unhandled rejection.
    work.catch(() => undefined);
    return Promise.race([work, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }
}
