import type { OpenAPIV3 } from 'openapi-types';

export const openApiDocument: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'SLR Writing API',
    version: '0.1.0',
    description: 'Evidence-grounded manuscript writing from validated SLR output.',
  },
  paths: {
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Service health check',
        responses: { '200': { description: 'Service is up' } },
      },
    },
    '/api/projects': {
      post: {
        tags: ['Projects'],
        summary: 'Create a writing project linked to an SLR project',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'slrProjectId'], properties: { name: { type: 'string' }, slrProjectId: { type: 'string' } } } } } },
        responses: { '201': { description: 'Created' }, '400': { description: 'Validation error' }, '401': { description: 'Not authenticated, or SLR_AUTH_REJECTED when slr-be rejected the token' }, '403': { description: 'SLR_PROJECT_ACCESS_DENIED: the caller cannot read the SLR project on slr-be (also when it does not exist)' }, '409': { description: 'PROJECT_EXISTS' }, '502': { description: 'slr-be failed (SLR_UPSTREAM_ERROR, SLR_UNREACHABLE, SLR_INVALID_RESPONSE)' }, '504': { description: 'SLR_TIMEOUT' } },
      },
      get: { tags: ['Projects'], summary: 'List the projects of the caller', responses: { '200': { description: 'Projects' }, '401': { description: 'Not authenticated' } } },
    },
    '/api/projects/{projectId}': {
      get: {
        tags: ['Projects'], summary: 'Get one project of the caller',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Project' }, '404': { description: 'PROJECT_NOT_FOUND (also for projects owned by someone else)' } },
      },
    },
    '/api/projects/{projectId}/snapshots/validate': {
      post: {
        tags: ['Snapshots'], summary: 'Check a slr-be run for readiness without storing it',
        description: 'Body: { run, corpus, artifacts } as returned by slr-be. Returns status READY or BLOCKED and the issue list.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Readiness report' }, '400': { description: 'INVALID_IMPORT_INPUT' }, '404': { description: 'PROJECT_NOT_FOUND' } },
      },
    },
    '/api/projects/{projectId}/snapshots/from-slr': {
      post: {
        tags: ['Snapshots'], summary: 'Fetch a run from slr-be with the caller token and import it as a snapshot',
        description: 'Limited per user per minute (429 RATE_LIMITED). Body: {runId}. The run is read from the SLR project linked to this project, using the same Authorization header. Same results as importing by hand (201, 200, 422). Upstream failures: 401 SLR_AUTH_REJECTED, 403 SLR_FORBIDDEN, 404 SLR_NOT_FOUND, 502 SLR_UNREACHABLE, SLR_UPSTREAM_ERROR or SLR_INVALID_RESPONSE, 504 SLR_TIMEOUT.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' } } } } } },
        responses: { '200': { description: 'Already imported' }, '201': { description: 'Imported' }, '400': { description: 'INVALID_RUN_ID or RUN_PROJECT_MISMATCH' }, '404': { description: 'PROJECT_NOT_FOUND or SLR_NOT_FOUND' }, '422': { description: 'SNAPSHOT_NOT_READY' }, '429': { description: 'RATE_LIMITED: too many calls by this user in a minute (Retry-After is set)' }, '502': { description: 'slr-be failed' }, '504': { description: 'slr-be timed out' } },
      },
    },
    '/api/projects/{projectId}/snapshots': {
      post: {
        tags: ['Snapshots'], summary: 'Import a slr-be run as an immutable snapshot',
        description: '201 for a new snapshot, 200 when the same run and corpus hash were imported before, 422 SNAPSHOT_NOT_READY (with the report in error.details) when the run has blocking issues. Nothing is stored for a blocked run.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Already imported' }, '201': { description: 'Imported' }, '400': { description: 'INVALID_IMPORT_INPUT or RUN_PROJECT_MISMATCH' }, '403': { description: 'MANUAL_IMPORT_DISABLED: importing a run posted by the client is switched off (default in production)' }, '404': { description: 'PROJECT_NOT_FOUND' }, '422': { description: 'SNAPSHOT_NOT_READY' } },
      },
      get: {
        tags: ['Snapshots'], summary: 'List the snapshots of the project',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Snapshots' }, '404': { description: 'PROJECT_NOT_FOUND' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/methods': {
      post: {
        tags: ['Manuscript'], summary: 'Write the Methods section from the snapshot (fixed template, no LLM)',
        description: 'Deterministic: the same snapshot gives the same text. 201 for a new version, 200 when the text is unchanged (nothing is stored). Every number in the text comes from a fact of the snapshot, and what the snapshot lacks is stated as not reported. The response holds the markdown, the facts with their source paths, and the warnings.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Unchanged, the latest version is returned' }, '201': { description: 'New version' }, '401': { description: 'Not authenticated' }, '404': { description: 'PROJECT_NOT_FOUND or SNAPSHOT_NOT_FOUND' }, '422': { description: 'METHODS_INPUT_MISSING: the snapshot has no A10' } },
      },
      get: {
        tags: ['Manuscript'], summary: 'Latest version of Methods with the list of versions',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Latest version and a list of versions without their text' }, '404': { description: 'PROJECT_NOT_FOUND, SNAPSHOT_NOT_FOUND or METHODS_NOT_GENERATED' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/methods/revisions/{version}': {
      get: {
        tags: ['Manuscript'], summary: 'One stored version of Methods',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, description: 'A positive integer', schema: { type: 'string' } }],
        responses: { '200': { description: 'The version' }, '400': { description: 'INVALID_VERSION' }, '404': { description: 'METHODS_REVISION_NOT_FOUND or the project or snapshot was not found' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}': {
      get: {
        tags: ['Snapshots'], summary: 'Get a snapshot with readiness issues, row counts and artifact statuses',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Snapshot' }, '404': { description: 'PROJECT_NOT_FOUND or SNAPSHOT_NOT_FOUND' } },
      },
    },
  },
};
