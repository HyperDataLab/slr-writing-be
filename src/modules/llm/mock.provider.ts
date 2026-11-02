import { createHash } from 'node:crypto';
import { LlmError } from './llm.errors.js';
import type { LlmProvider, LlmRequest, LlmResult } from './llm.types.js';

/**
 * A stand-in for a model, for tests of the steps that use one. `respond` plays the model: it gets the request and returns
 * what the model would have said (a JSON value), or throws. The answer goes through the request's schema exactly as a real
 * one does, so a test cannot pass with an answer a real model's output would be refused for.
 * It is never chosen by the settings: a test puts it in place with `setLlmProvider`.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-1';
  /** Every request received, in order. */
  readonly calls: Array<LlmRequest<unknown>> = [];

  constructor(private readonly respond: (request: LlmRequest<unknown>, callNumber: number) => unknown | Promise<unknown>) {}

  async generateStructured<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push(request as LlmRequest<unknown>);
    const started = Date.now();
    const answer = await this.respond(request as LlmRequest<unknown>, this.calls.length);
    const checked = request.schema.safeParse(answer);
    if (!checked.success) throw new LlmError('LLM_INVALID_OUTPUT');
    const inputTokens = Math.ceil((request.system.length + request.prompt.length) / 4);
    const outputTokens = Math.ceil(JSON.stringify(answer ?? null).length / 4);
    return {
      output: checked.data,
      modelInfo: {
        provider: this.name,
        model: this.model,
        promptTemplateId: request.promptTemplateId,
        promptTemplateVersion: request.promptTemplateVersion,
        promptHash: `sha256:${createHash('sha256').update(`${request.system}\n---\n${request.prompt}`).digest('hex')}`,
        temperature: request.temperature ?? 0.2,
        maxOutputTokens: request.maxOutputTokens ?? 0,
      },
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      latencyMs: Date.now() - started,
      attempts: 1,
    };
  }
}
