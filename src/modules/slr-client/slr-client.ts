import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  artifactPayloadSchema, corpusSchema, prismaWritingExportSchema, rqFindingsSchema, runSchema, unwrapEnvelope,
  type ArtifactTypeName, type ImportInput, type Supplements,
} from '../snapshots/slr-source.schemas.js';

/** Artifacts the MVP writes from (docs/mvp-scope.md). Others are not fetched. */
export const MVP_ARTIFACT_TYPES: ArtifactTypeName[] = ['A1', 'A2', 'A7', 'A10'];

/** slr-be run ids look like `run-20260101120000-ab12cd`; reject anything else before it reaches a URL. */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const isValidRunId = (value: unknown): value is string => typeof value === 'string' && RUN_ID_PATTERN.test(value);

export interface SlrClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface SlrRequestContext {
  /** The user's `Authorization` header value, forwarded as is (ADR-001). Omitted when the caller has none. */
  authorization?: string;
}

const upstreamError = (status: number, code: string, message: string) => new AppError(message, status, code);

/**
 * Reads one run of a project from slr-be, with the caller's own token.
 * Upstream failures become our own errors; upstream bodies and URLs are never echoed to the client.
 */
export class SlrClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlrClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env.SLR_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? env.SLR_API_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? env.SLR_API_MAX_RESPONSE_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async get(path: string, ctx: SlrRequestContext): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (ctx.authorization) headers.Authorization = ctx.authorization;

    let response: Response;
    try {
      // `redirect: 'error'` so the user's token is never forwarded to a host we did not choose.
      response = await this.fetchImpl(`${this.baseUrl}/api${path}`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw upstreamError(504, 'SLR_TIMEOUT', 'slr-be did not answer in time');
      }
      throw upstreamError(502, 'SLR_UNREACHABLE', 'slr-be could not be reached');
    }

    if (response.status === 401) throw upstreamError(401, 'SLR_AUTH_REJECTED', 'slr-be rejected the token');
    if (response.status === 403) throw upstreamError(403, 'SLR_FORBIDDEN', 'You do not have access to this SLR project');
    if (response.status === 404) throw upstreamError(404, 'SLR_NOT_FOUND', 'The SLR project, run or artifact was not found');
    if (!response.ok) throw upstreamError(502, 'SLR_UPSTREAM_ERROR', `slr-be answered with status ${response.status}`);

    let body: unknown;
    try {
      body = JSON.parse(await this.readLimited(response));
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw upstreamError(504, 'SLR_TIMEOUT', 'slr-be did not answer in time');
      }
      throw upstreamError(502, 'SLR_INVALID_RESPONSE', 'slr-be returned a body that is not valid JSON');
    }
    try {
      return unwrapEnvelope(body);
    } catch {
      throw upstreamError(502, 'SLR_UPSTREAM_ERROR', 'slr-be reported an error');
    }
  }

  /** Reads the body as text but gives up once it passes the size limit, so a runaway upstream cannot exhaust memory. */
  private async readLimited(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) throw this.tooLarge();
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > this.maxResponseBytes) { await reader.cancel().catch(() => undefined); throw this.tooLarge(); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  private tooLarge() {
    return upstreamError(502, 'SLR_RESPONSE_TOO_LARGE', 'slr-be returned more data than allowed');
  }

  private async getParsed<T>(path: string, ctx: SlrRequestContext, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): Promise<T> {
    const parsed = schema.safeParse(await this.get(path, ctx));
    if (!parsed.success) throw upstreamError(502, 'SLR_INVALID_RESPONSE', `slr-be returned an unexpected shape for ${path.split('/').pop()}`);
    return parsed.data;
  }

  /** Like getParsed, but a project that has no such data (404) gives undefined. Every other failure still fails the import. */
  private async getOptional<T>(path: string, ctx: SlrRequestContext, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): Promise<T | undefined> {
    try {
      return await this.getParsed(path, ctx, schema);
    } catch (error) {
      if (error instanceof AppError && error.code === 'SLR_NOT_FOUND') return undefined;
      throw error;
    }
  }

  /**
   * Resolves only when slr-be lets the caller read this SLR project (any member). The answer for a project that
   * does not exist and for one the caller cannot see is the same, so this cannot be used to probe for project ids.
   */
  async assertProjectAccess(slrProjectId: string, ctx: SlrRequestContext = {}): Promise<void> {
    this.assertSafeProjectId(slrProjectId);
    try {
      await this.get(`/projects/${encodeURIComponent(slrProjectId)}`, ctx);
    } catch (error) {
      if (error instanceof AppError && (error.code === 'SLR_FORBIDDEN' || error.code === 'SLR_NOT_FOUND')) {
        throw new AppError('You do not have access to this SLR project', 403, 'SLR_PROJECT_ACCESS_DENIED');
      }
      throw error;
    }
  }

  /**
   * The caller's role in an SLR project on slr-be: 'OWNER', 'LECTURER' or 'REVIEWER'. Anything else, including a role
   * the answer does not name, gives null, and null never counts as OWNER. A project the caller cannot see is an error,
   * the same one as for a missing project.
   */
  async getProjectRole(slrProjectId: string, ctx: SlrRequestContext = {}): Promise<'OWNER' | 'LECTURER' | 'REVIEWER' | null> {
    this.assertSafeProjectId(slrProjectId);
    let data: unknown;
    try {
      data = await this.get(`/projects/${encodeURIComponent(slrProjectId)}`, ctx);
    } catch (error) {
      if (error instanceof AppError && (error.code === 'SLR_FORBIDDEN' || error.code === 'SLR_NOT_FOUND')) {
        throw new AppError('You do not have access to this SLR project', 403, 'SLR_PROJECT_ACCESS_DENIED');
      }
      throw error;
    }
    const answer = typeof data === 'object' && data !== null ? (data as { roleText?: unknown; id?: unknown }) : {};
    // The answer has to be about the project that was asked for. A role in the answer for another project proves nothing.
    if (answer.id !== slrProjectId) return null;
    const roleText = answer.roleText;
    return roleText === 'OWNER' || roleText === 'LECTURER' || roleText === 'REVIEWER' ? roleText : null;
  }

  // encodeURIComponent leaves dots alone and URL parsing resolves "." and ".." segments, which would leave the project path.
  private assertSafeProjectId(slrProjectId: string): void {
    if (/^\.+$/.test(slrProjectId)) throw new AppError('The linked SLR project id is not valid', 400, 'INVALID_SLR_PROJECT_ID');
  }

  /** Fetches the run, its own corpus and the MVP artifacts it contains, in the shape the importer expects. */
  async fetchRun(slrProjectId: string, runId: string, ctx: SlrRequestContext = {}): Promise<ImportInput> {
    if (!isValidRunId(runId)) throw new AppError('Invalid run id', 400, 'INVALID_RUN_ID');
    this.assertSafeProjectId(slrProjectId);
    const base = `/projects/${encodeURIComponent(slrProjectId)}/synthesis/artifacts/runs/${encodeURIComponent(runId)}`;

    const run = await this.getParsed(base, ctx, runSchema);
    if (run.run_id !== runId) throw upstreamError(502, 'SLR_INVALID_RESPONSE', 'slr-be returned a different run than requested');

    // The run's own corpus is the frozen one; the live `/artifacts/corpus` could already have moved on.
    const corpus = await this.getParsed(`${base}/artifacts/corpus`, ctx, corpusSchema);

    const wanted = MVP_ARTIFACT_TYPES.filter((type) => run.artifacts.some((artifact) => artifact.artifact_type === type));
    const fetched = await Promise.all(wanted.map(async (type) => [type, await this.getParsed(`${base}/artifacts/${type}`, ctx, artifactPayloadSchema)] as const));

    const artifacts: ImportInput['artifacts'] = {};
    for (const [type, payload] of fetched) {
      const listed = run.artifacts.find((artifact) => artifact.artifact_type === type);
      if (payload.artifact_id !== listed?.artifact_id) throw upstreamError(502, 'SLR_INVALID_RESPONSE', `slr-be returned a different ${type} than the run lists`);
      if (payload.artifact_type !== type) throw upstreamError(502, 'SLR_INVALID_RESPONSE', `slr-be returned ${payload.artifact_type} where ${type} was requested`);
      artifacts[type] = payload;
    }

    const supplements: Supplements = {};
    const prismaExport = await this.getOptional(`/projects/${encodeURIComponent(slrProjectId)}/prisma/writing-export.json`, ctx, prismaWritingExportSchema);
    if (prismaExport) supplements.prisma_writing_export = prismaExport;
    const findings = await this.getOptional(`/projects/${encodeURIComponent(slrProjectId)}/synthesis/findings`, ctx, rqFindingsSchema);
    if (findings) supplements.rq_findings = findings;
    return { run, corpus, artifacts, supplements };
  }
}
