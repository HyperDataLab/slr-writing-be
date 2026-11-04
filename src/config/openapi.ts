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
    '/api/llm/status': {
      get: {
        tags: ['LLM'], summary: 'Whether a language model is ready, and which',
        description: 'Returns {configured, provider, model}. Never returns the key. There is no route that sends free text to the model: only the steps of the writing workflow call it.',
        responses: { '200': { description: 'The status' }, '401': { description: 'Not authenticated' } },
      },
    },
    '/api/journal-profiles': {
      get: {
        tags: ['Journal profiles'], summary: 'List the journal profiles',
        description: 'A profile fixes the sections, their order, suggested word budgets and the data each section is written from. The default profile is generic and always marked unverified: it is not any journal policy.',
        responses: { '200': { description: 'Profiles' }, '401': { description: 'Not authenticated' } },
      },
    },
    '/api/journal-profiles/{profileId}': {
      get: {
        tags: ['Journal profiles'], summary: 'Get one journal profile',
        parameters: [{ name: 'profileId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'The profile, including its verification status and notice' }, '401': { description: 'Not authenticated' }, '404': { description: 'JOURNAL_PROFILE_NOT_FOUND' } },
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
        description: 'Deterministic: the same snapshot gives the same text. 201 for a new version, 200 when the text is byte-identical to the latest version (nothing is stored). Every number in the text comes from a fact of the snapshot, and what the snapshot lacks is stated as not reported. The response holds the markdown, the facts with their source paths, and the warnings.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Unchanged, the latest version is returned' }, '201': { description: 'New version' }, '401': { description: 'Not authenticated' }, '404': { description: 'PROJECT_NOT_FOUND or SNAPSHOT_NOT_FOUND' }, '422': { description: 'METHODS_INPUT_MISSING: the snapshot has no A10' }, '500': { description: 'METHODS_UNGROUNDED_NUMBER: the text held a number that is not in the snapshot (a programming error; nothing is stored)' } },
      },
      get: {
        tags: ['Manuscript'], summary: 'Latest version of Methods with the list of versions',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Latest version and a list of versions without their text' }, '401': { description: 'Not authenticated' }, '404': { description: 'PROJECT_NOT_FOUND, SNAPSHOT_NOT_FOUND or METHODS_NOT_GENERATED' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/blueprint': {
      post: {
        tags: ['Blueprint'], summary: 'Make the first blueprint (dàn ý) from the journal profile and the snapshot',
        description: 'Fixed rules, no LLM: the sections of the profile, one Results subsection per theme, and the coverage of every research question. 201 when made, 200 when a blueprint already exists (it is never overwritten). Optional body: {profileId}.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'A blueprint already exists; the latest version is returned' }, '201': { description: 'Version 1 made' }, '400': { description: 'INVALID_REQUEST' }, '401': { description: 'Not authenticated' }, '404': { description: 'PROJECT_NOT_FOUND, SNAPSHOT_NOT_FOUND or JOURNAL_PROFILE_NOT_FOUND' } },
      },
      get: {
        tags: ['Blueprint'], summary: 'Latest version of the blueprint with its issues, approval state and list of versions',
        description: 'issues lists what blocks or warns; approvable is true when nothing blocks. approval.status is PENDING, APPROVED or REJECTED for this version.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'The blueprint view' }, '401': { description: 'Not authenticated' }, '404': { description: 'BLUEPRINT_NOT_FOUND, or the project or snapshot was not found' } },
      },
      put: {
        tags: ['Blueprint'], summary: 'Save an edited blueprint as the next version',
        description: 'Body: {baseVersion, content}. A draft with problems is saved; the problems only block the approval. 201 for a new version, 200 when nothing changed, 409 STALE_BLUEPRINT when baseVersion is not the latest version.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['baseVersion','content'], properties: { baseVersion: { type: 'integer' }, content: { type: 'object' } } } } } },
        responses: { '200': { description: 'Unchanged' }, '201': { description: 'New version' }, '400': { description: 'INVALID_BLUEPRINT: the body has the wrong shape or names an unknown profile' }, '401': { description: 'Not authenticated' }, '404': { description: 'BLUEPRINT_NOT_FOUND or the project or snapshot was not found' }, '409': { description: 'STALE_BLUEPRINT' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/blueprint/approve': {
      post: {
        tags: ['Blueprint'], summary: 'H1: approve the latest version of the blueprint',
        description: 'Only the OWNER of the SLR project on slr-be may decide; the role is asked of slr-be with the caller token (REQUIRE_SLR_OWNER_FOR_APPROVAL). Needs a blueprint with no blocking issue. Body: {version, note?}. 201 when recorded, 200 when the same decision was already recorded.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['version'], properties: { version: { type: 'integer' }, note: { type: 'string' } } } } } },
        responses: { '200': { description: 'Already approved' }, '201': { description: 'Approval recorded' }, '400': { description: 'INVALID_REQUEST' }, '401': { description: 'Not authenticated, or SLR_AUTH_REJECTED' }, '403': { description: 'APPROVAL_REQUIRES_OWNER or SLR_PROJECT_ACCESS_DENIED' }, '404': { description: 'BLUEPRINT_NOT_FOUND or the project or snapshot was not found' }, '409': { description: 'STALE_BLUEPRINT: only the latest version can be decided' }, '422': { description: 'BLUEPRINT_NOT_APPROVABLE, with the issues in error.details' }, '502': { description: 'slr-be failed' }, '504': { description: 'SLR_TIMEOUT' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/blueprint/reject': {
      post: {
        tags: ['Blueprint'], summary: 'H1: reject the latest version of the blueprint',
        description: 'Same rules as approve, and a note is required. A rejection also withdraws an earlier approval of the same version.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['version','note'], properties: { version: { type: 'integer' }, note: { type: 'string' } } } } } },
        responses: { '200': { description: 'Already rejected' }, '201': { description: 'Rejection recorded' }, '400': { description: 'INVALID_REQUEST' }, '401': { description: 'Not authenticated, or SLR_AUTH_REJECTED' }, '403': { description: 'APPROVAL_REQUIRES_OWNER or SLR_PROJECT_ACCESS_DENIED' }, '404': { description: 'BLUEPRINT_NOT_FOUND or the project or snapshot was not found' }, '409': { description: 'STALE_BLUEPRINT' }, '502': { description: 'slr-be failed' }, '504': { description: 'SLR_TIMEOUT' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/blueprint/revisions/{version}': {
      get: {
        tags: ['Blueprint'], summary: 'One stored version of the blueprint, with its own approval state',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, description: 'A positive integer', schema: { type: 'string' } }],
        responses: { '200': { description: 'The version' }, '400': { description: 'INVALID_VERSION' }, '401': { description: 'Not authenticated' }, '404': { description: 'BLUEPRINT_REVISION_NOT_FOUND or the project or snapshot was not found' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/methods/revisions/{version}': {
      get: {
        tags: ['Manuscript'], summary: 'One stored version of Methods',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, description: 'A positive integer', schema: { type: 'string' } }],
        responses: { '200': { description: 'The version' }, '400': { description: 'INVALID_VERSION' }, '401': { description: 'Not authenticated' }, '404': { description: 'METHODS_REVISION_NOT_FOUND or the project or snapshot was not found' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/paragraph-plans': {
      post: {
        tags: ['Paragraph plans'], summary: 'Generate initial paragraph plans from the approved blueprint',
        description: 'Requires an approved blueprint (H1). Generates structured plans for subsections mapping claims to snapshot findings and verbatim evidence. 201 when made, 200 when plans already exist.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Plans already exist; the latest version is returned' }, '201': { description: 'Version 1 made' }, '401': { description: 'Not authenticated' }, '404': { description: 'PROJECT_NOT_FOUND, SNAPSHOT_NOT_FOUND or MANUSCRIPT_NOT_FOUND' }, '422': { description: 'BLUEPRINT_NOT_APPROVED: the blueprint must be approved by the owner (H1) first' } },
      },
      get: {
        tags: ['Paragraph plans'], summary: 'Latest version of the paragraph plans with issues, stats and list of versions',
        description: 'Returns the plan items, readyToDraft flag, count of ready vs total paragraphs, and validation issues.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'The paragraph plans view' }, '401': { description: 'Not authenticated' }, '404': { description: 'PARAGRAPH_PLANS_NOT_FOUND or project/snapshot not found' } },
      },
      put: {
        tags: ['Paragraph plans'], summary: 'Save an edited set of paragraph plans as the next version',
        description: 'Body: {baseVersion, content}. 201 for a new version, 200 when nothing changed, 409 STALE_PLAN when baseVersion is not the latest version.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['baseVersion','content'], properties: { baseVersion: { type: 'integer' }, content: { type: 'object' } } } } } },
        responses: { '200': { description: 'Unchanged' }, '201': { description: 'New version' }, '400': { description: 'INVALID_PARAGRAPH_PLANS: body has wrong shape or contains unstorable text' }, '401': { description: 'Not authenticated' }, '404': { description: 'PARAGRAPH_PLANS_NOT_FOUND or project/snapshot not found' }, '409': { description: 'STALE_PLAN' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/paragraph-plans/revisions/{version}': {
      get: {
        tags: ['Paragraph plans'], summary: 'One stored version of the paragraph plans',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, description: 'A positive integer', schema: { type: 'string' } }],
        responses: { '200': { description: 'The version view' }, '400': { description: 'INVALID_VERSION' }, '401': { description: 'Not authenticated' }, '404': { description: 'PARAGRAPH_PLANS_NOT_FOUND or project/snapshot not found' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/sections/{sectionKey}/draft': {
      post: {
        tags: ['Drafting'], summary: 'Draft a section using LLM from READY_TO_DRAFT paragraph plans',
        description: 'Requires approved blueprint (H1) and paragraph plans (M6). LLM is called with minimal evidence packs. 201 for new revision, 200 when unchanged.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'sectionKey', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Unchanged, existing latest version returned' }, '201': { description: 'Draft generated' }, '401': { description: 'Not authenticated' }, '404': { description: 'PROJECT_NOT_FOUND, SNAPSHOT_NOT_FOUND or PARAGRAPH_PLANS_NOT_FOUND' }, '422': { description: 'BLUEPRINT_NOT_APPROVED, NO_PLANS_FOR_SECTION, NO_READY_PARAGRAPH_PLANS, or LLM_HALLUCINATED_REFERENCE' }, '503': { description: 'LLM_NOT_CONFIGURED' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/sections/{sectionKey}': {
      get: {
        tags: ['Drafting'], summary: 'Latest section draft with H2 approval state and version list',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'sectionKey', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'The section draft view' }, '401': { description: 'Not authenticated' }, '404': { description: 'SECTION_NOT_FOUND or SECTION_REVISION_NOT_FOUND' } },
      },
      put: {
        tags: ['Drafting'], summary: 'Save a manual edit of the section draft as a new version',
        description: 'Body: {baseVersion, markdown}. Creates next version and sets H2 approval back to PENDING. 201 for new version, 200 when unchanged, 409 STALE_REVISION.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'sectionKey', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['baseVersion','markdown'], properties: { baseVersion: { type: 'integer' }, markdown: { type: 'string' } } } } } },
        responses: { '200': { description: 'Unchanged' }, '201': { description: 'New version' }, '400': { description: 'INVALID_DRAFT_EDIT' }, '401': { description: 'Not authenticated' }, '404': { description: 'SECTION_NOT_FOUND or SECTION_REVISION_NOT_FOUND' }, '409': { description: 'STALE_REVISION' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/sections/{sectionKey}/approve': {
      post: {
        tags: ['Drafting'], summary: 'H2: OWNER approves the latest version of the section draft',
        description: 'Only the OWNER of the SLR project on slr-be may decide. Body: {version, note?}. 201 when recorded, 200 when identical decision already recorded.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'sectionKey', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['version'], properties: { version: { type: 'integer' }, note: { type: 'string' } } } } } },
        responses: { '200': { description: 'Already approved' }, '201': { description: 'Approval recorded' }, '400': { description: 'INVALID_REQUEST' }, '401': { description: 'Not authenticated' }, '403': { description: 'APPROVAL_REQUIRES_OWNER' }, '404': { description: 'SECTION_NOT_FOUND or SECTION_REVISION_NOT_FOUND' }, '409': { description: 'STALE_REVISION' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/sections/{sectionKey}/reject': {
      post: {
        tags: ['Drafting'], summary: 'H2: OWNER rejects the latest version of the section draft',
        description: 'Only the OWNER of the SLR project on slr-be may decide. Note is required. Body: {version, note}.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'sectionKey', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['version','note'], properties: { version: { type: 'integer' }, note: { type: 'string' } } } } } },
        responses: { '200': { description: 'Already rejected' }, '201': { description: 'Rejection recorded' }, '400': { description: 'INVALID_REQUEST' }, '401': { description: 'Not authenticated' }, '403': { description: 'APPROVAL_REQUIRES_OWNER' }, '404': { description: 'SECTION_NOT_FOUND or SECTION_REVISION_NOT_FOUND' }, '409': { description: 'STALE_REVISION' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/sections/{sectionKey}/revisions/{version}': {
      get: {
        tags: ['Drafting'], summary: 'One stored version of the section draft',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'sectionKey', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, description: 'A positive integer', schema: { type: 'string' } }],
        responses: { '200': { description: 'The section revision view' }, '400': { description: 'INVALID_VERSION' }, '401': { description: 'Not authenticated' }, '404': { description: 'SECTION_NOT_FOUND or SECTION_REVISION_NOT_FOUND' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/verification/run': {
      post: {
        tags: ['Verification'], summary: 'Execute Quality Gates G1-G7 and generate verification report revision',
        description: 'Runs deterministic and LLM-assisted gates (G1-G7) against drafted sections. Idempotent: 201 for new revision, 200 when unchanged.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Verification report unchanged' }, '201': { description: 'New verification report created' }, '401': { description: 'Not authenticated' }, '404': { description: 'SNAPSHOT_NOT_FOUND or MANUSCRIPT_NOT_FOUND' }, '422': { description: 'BLUEPRINT_NOT_APPROVED or NO_DRAFTED_SECTIONS' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/verification': {
      get: {
        tags: ['Verification'], summary: 'Get latest verification report with gates and review issues',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Latest verification report view' }, '401': { description: 'Not authenticated' }, '404': { description: 'VERIFICATION_REPORT_NOT_FOUND' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/verification/revisions/{version}': {
      get: {
        tags: ['Verification'], summary: 'Get a specific historical revision of the verification report',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Historical verification report view' }, '400': { description: 'INVALID_VERSION' }, '401': { description: 'Not authenticated' }, '404': { description: 'VERIFICATION_REPORT_NOT_FOUND' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/citation-manifest': {
      get: {
        tags: ['Verification'], summary: 'Get the extracted CitationManifest with resolved studies and anchors',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Citation manifest' }, '401': { description: 'Not authenticated' }, '404': { description: 'VERIFICATION_REPORT_NOT_FOUND' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/final/status': {
      get: {
        tags: ['Export & H3'], summary: 'Evaluate H3 approval status and export readiness',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'H3 readiness status view' }, '401': { description: 'Not authenticated' }, '404': { description: 'PROJECT_NOT_FOUND or SNAPSHOT_NOT_FOUND' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/final/approve': {
      post: {
        tags: ['Export & H3'], summary: 'Approve final manuscript (H3 checkpoint, OWNER only)',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { note: { type: 'string' } } } } } },
        responses: { '200': { description: 'H3 approved' }, '401': { description: 'Not authenticated' }, '403': { description: 'APPROVAL_REQUIRES_OWNER' }, '422': { description: 'QUALITY_GATES_BLOCKED' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/final/reject': {
      post: {
        tags: ['Export & H3'], summary: 'Reject final manuscript with note (H3 checkpoint, OWNER only)',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['note'], properties: { note: { type: 'string', minLength: 3 } } } } } },
        responses: { '200': { description: 'H3 rejected' }, '400': { description: 'INVALID_REQUEST' }, '401': { description: 'Not authenticated' }, '403': { description: 'APPROVAL_REQUIRES_OWNER' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/export': {
      post: {
        tags: ['Export & H3'], summary: 'Create an immutable submission package export (fail-closed)',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '201': { description: 'Submission package exported successfully' }, '401': { description: 'Not authenticated' }, '403': { description: 'APPROVAL_REQUIRES_OWNER' }, '422': { description: 'H3_APPROVAL_REQUIRED or MANUSCRIPT_MODIFIED_AFTER_H3_APPROVAL' } },
      },
      get: {
        tags: ['Export & H3'], summary: 'Get the latest submission package export metadata',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Latest export package view' }, '401': { description: 'Not authenticated' }, '404': { description: 'EXPORT_PACKAGE_NOT_FOUND' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/export/revisions/{version}': {
      get: {
        tags: ['Export & H3'], summary: 'Get a specific historical submission package export by version',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Historical export package view' }, '400': { description: 'INVALID_VERSION' }, '401': { description: 'Not authenticated' }, '404': { description: 'EXPORT_PACKAGE_NOT_FOUND' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/export/download': {
      get: {
        tags: ['Export & H3'], summary: 'Download submission package ZIP archive',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'version', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'PKZIP binary archive (application/zip)' }, '401': { description: 'Not authenticated' }, '404': { description: 'EXPORT_PACKAGE_NOT_FOUND' } },
      },
    },
    '/api/projects/{projectId}/snapshots/{snapshotId}/manuscript/lineage': {
      get: {
        tags: ['Export & H3'], summary: 'Reverse trace paragraph/sentence to source anchors',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sectionKey', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'evidenceId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'findingId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'sentence', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'List of matching lineage items' }, '401': { description: 'Not authenticated' }, '404': { description: 'PROJECT_NOT_FOUND or SNAPSHOT_NOT_FOUND' } },
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
