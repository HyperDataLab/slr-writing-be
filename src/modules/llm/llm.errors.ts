import { AppError } from '../../shared/errors/app-error.js';
import type { LlmUsage } from './llm.types.js';

/**
 * Failures of the model, as errors this API can answer with. The messages are fixed text: nothing the model or its
 * service said, no address, no key and no part of the prompt is ever put in them.
 */
export type LlmErrorCode =
  | 'LLM_NOT_CONFIGURED'
  | 'LLM_INPUT_TOO_LARGE'
  | 'LLM_BUDGET_EXCEEDED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_UNREACHABLE'
  | 'LLM_UPSTREAM_ERROR'
  | 'LLM_BLOCKED'
  | 'LLM_OUTPUT_TRUNCATED'
  | 'LLM_INVALID_OUTPUT';

const STATUS: Record<LlmErrorCode, number> = {
  LLM_NOT_CONFIGURED: 503,
  LLM_INPUT_TOO_LARGE: 413,
  LLM_BUDGET_EXCEEDED: 429,
  LLM_RATE_LIMITED: 503,
  LLM_TIMEOUT: 504,
  LLM_UNREACHABLE: 502,
  LLM_UPSTREAM_ERROR: 502,
  LLM_BLOCKED: 422,
  LLM_OUTPUT_TRUNCATED: 502,
  LLM_INVALID_OUTPUT: 502,
};

const MESSAGE: Record<LlmErrorCode, string> = {
  LLM_NOT_CONFIGURED: 'No language model is configured',
  LLM_INPUT_TOO_LARGE: 'The text to send to the language model is too large',
  LLM_BUDGET_EXCEEDED: 'The daily language model budget is used up',
  LLM_RATE_LIMITED: 'The language model service is limiting requests, try again later',
  LLM_TIMEOUT: 'The language model did not answer in time',
  LLM_UNREACHABLE: 'The language model service could not be reached',
  LLM_UPSTREAM_ERROR: 'The language model service failed',
  LLM_BLOCKED: 'The language model refused the request',
  LLM_OUTPUT_TRUNCATED: 'The language model answer was cut off',
  LLM_INVALID_OUTPUT: 'The language model answer did not have the expected shape',
};

export class LlmError extends AppError {
  /** True when the same request could succeed if sent again (a busy service, a timeout). */
  readonly retryable: boolean;
  /**
   * Tokens the service charged for calls that ended in this error (an answer cut off, refused or of the wrong shape).
   * Set by the provider, read by the guard so that failed calls still count against the budget.
   */
  usage?: LlmUsage;

  constructor(public readonly llmCode: LlmErrorCode, options: { retryable?: boolean } = {}) {
    super(MESSAGE[llmCode], STATUS[llmCode], llmCode);
    this.retryable = options.retryable ?? false;
  }
}
