import type { z } from 'zod';

/**
 * The only way the rest of the system talks to a language model. A step that needs a model asks an `LlmProvider` for
 * structured output and gets back a value that has already been checked against the step's own zod schema, together with
 * a record of what produced it. Nothing else about the model (its name, its API, its key) is visible to the step.
 */

export interface LlmRequest<T> {
  /** Names the prompt, for the record. Change the version whenever the wording changes. */
  promptTemplateId: string;
  promptTemplateVersion: number;
  /** Standing instructions: what to do and what never to do. Written by this system, never by a user. */
  system: string;
  /**
   * The task and its data. Text that came from users or papers must be put in with `buildPrompt`, which marks it as data.
   */
  prompt: string;
  /** The shape of the answer. The model is asked for JSON, and anything that does not parse into this is rejected. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Lower than the server's ceiling only. Asking for more than LLM_MAX_OUTPUT_TOKENS is capped, not honoured. */
  maxOutputTokens?: number;
  /** 0 to 2. The default is low, because these steps want the same answer for the same question. */
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** What produced a result. Stored with whatever the result becomes, so a sentence can be traced back to a model and a prompt. */
export interface LlmModelInfo {
  provider: string;
  model: string;
  promptTemplateId: string;
  promptTemplateVersion: number;
  /** sha256 of the system text and the prompt. The text itself is not kept, since it can hold paper content. */
  promptHash: string;
  temperature: number;
  maxOutputTokens: number;
}

export interface LlmResult<T> {
  output: T;
  modelInfo: LlmModelInfo;
  usage: LlmUsage;
  latencyMs: number;
  /** Calls made to the model for this result, including retries. */
  attempts: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}

export interface LlmStatus {
  configured: boolean;
  provider: string;
  model: string | null;
}
