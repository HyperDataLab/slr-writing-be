import { Semaphore } from '../../shared/utils/semaphore.js';
import { LlmError } from './llm.errors.js';
import type { LlmProvider, LlmRequest, LlmResult } from './llm.types.js';

export interface GuardOptions {
  /** Most characters of system text and prompt together. Larger requests are refused before any call is made. */
  maxInputChars: number;
  /** Ceiling for the answer, whatever the step asks for. */
  maxOutputTokens: number;
  /** Most calls in flight at once; the others wait. */
  maxConcurrency: number;
  /** Most tokens per UTC day for this process. 0 = no limit. */
  dailyTokenBudget: number;
  /** Replaced in tests. */
  now?: () => Date;
}

/**
 * Limits placed around any provider, so no step can send a model more than the server allows, send too many calls at
 * once, or spend more than the daily budget. Spending is counted from the tokens the provider reports, in memory.
 */
export class GuardedLlmProvider implements LlmProvider {
  private readonly slots: Semaphore;
  private day = '';
  private spent = 0;

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
    if (request.system.length + request.prompt.length > this.options.maxInputChars) throw new LlmError('LLM_INPUT_TOO_LARGE');
    const maxOutputTokens = Math.min(request.maxOutputTokens ?? this.options.maxOutputTokens, this.options.maxOutputTokens);

    return this.slots.run(async () => {
      // Checked when it is this call's turn, so calls that waited see what the ones before them spent.
      this.rollDay();
      if (this.options.dailyTokenBudget > 0 && this.spent >= this.options.dailyTokenBudget) throw new LlmError('LLM_BUDGET_EXCEEDED');
      const result = await this.inner.generateStructured({ ...request, maxOutputTokens });
      this.rollDay();
      this.spent += result.usage.totalTokens;
      return result;
    });
  }
}
