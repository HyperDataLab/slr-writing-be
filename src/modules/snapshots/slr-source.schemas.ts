import { z } from 'zod';

/**
 * Input contract for importing one SLR run from slr-be (docs/slr-be-survey.md, section 3).
 * Only the fields we persist are required. Unknown fields pass through so a newer slr-be does not break import.
 */

const reviewStatus = z.enum(['unreviewed', 'needs_human_review', 'approved', 'rejected']);
const validationStatus = z.enum(['valid', 'invalid', 'not_applicable']);
const artifactType = z.enum(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10']);

const sourceLocation = z.object({
  page: z.number().int().nullable(),
  section: z.string().nullable(),
  paragraph: z.number().int().nullable(),
  table_or_figure: z.string().nullable(),
  char_start: z.number().int().optional(),
  char_end: z.number().int().optional(),
}).passthrough();

export const corpusSchema = z.object({
  corpus_version: z.string().min(1),
  corpus_hash: z.string().min(1),
  project_id: z.string().min(1),
  research_questions: z.array(z.object({
    rq_id: z.string().min(1),
    code: z.string().nullable(),
    question: z.string(),
  }).passthrough()),
  studies: z.array(z.object({
    study_id: z.string().min(1),
    title: z.string(),
    authors: z.array(z.string()),
    year: z.number().int().nullable(),
    doi: z.string().nullable(),
    venue: z.string().nullable(),
    keywords: z.array(z.string()),
    extraction: z.object({ status: z.string() }).passthrough(),
    document_ids: z.array(z.string()),
  }).passthrough()),
  documents: z.array(z.object({
    document_id: z.string().min(1),
    study_id: z.string().min(1),
    kind: z.string(),
    source_revisions: z.array(z.string()),
    source_hashes: z.array(z.string()),
  }).passthrough()),
  findings: z.array(z.object({
    finding_id: z.string().min(1),
    study_id: z.string().min(1),
    field_id: z.string().min(1),
    field_name: z.string(),
    section_name: z.string(),
    role: z.string().nullable(),
    value_text: z.string(),
    is_not_reported: z.boolean(),
    evidence_ids: z.array(z.string()),
  }).passthrough()),
  evidence: z.array(z.object({
    evidence_id: z.string().min(1),
    study_id: z.string().min(1),
    field_id: z.string().min(1),
    finding_ids: z.array(z.string()),
    document_id: z.string().min(1),
    source_revision: z.string(),
    source_hash: z.string().nullable(),
    source_location: sourceLocation,
    quote: z.string(),
    quote_hash: z.string().nullable(),
    quote_hash_verified: z.boolean(),
    consensus_value_match: z.enum(['match', 'mismatch', 'unknown']),
  }).passthrough()),
  claims: z.array(z.object({
    claim_id: z.string().min(1),
    title: z.string(),
    description: z.string().nullable(),
    research_question_id: z.string().nullable(),
    items: z.array(z.object({
      item_id: z.string().min(1),
      finding_id: z.string().nullable(),
      study_id: z.string().nullable(),
      link_status: z.enum(['resolved', 'resolved_not_reported', 'unresolved']),
      value_drift: z.enum(['unchanged', 'changed', 'unknown']),
      notes: z.string().nullable(),
    }).passthrough()),
  }).passthrough()),
  issues: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()),
}).passthrough();

export const runSchema = z.object({
  run_id: z.string().min(1),
  project_id: z.string().min(1),
  corpus_hash: z.string().min(1),
  corpus_version: z.string().min(1),
  generator_version: z.string().min(1),
  artifacts: z.array(z.object({
    artifact_type: artifactType,
    artifact_id: z.string().min(1),
    content_hash: z.string().min(1),
    review_status: reviewStatus,
    validation_status: validationStatus,
  }).passthrough()),
}).passthrough();

/** One artifact payload as returned by slr-be. Only the identity fields are checked; the body is kept as is. */
export const artifactPayloadSchema = z.object({
  artifact_id: z.string().min(1),
  artifact_type: artifactType,
  schema_version: z.string().min(1),
}).passthrough();

/**
 * Data slr-be does not freeze per run: the PRISMA writing export (flow counts for Methods) and the researcher answers per RQ.
 * Both are read when importing, so the snapshot keeps its own copy.
 */
export const prismaWritingExportSchema = z.object({
  schemaVersion: z.string().min(1),
  /** Present in the real export. When it names a project, it must be the one the run belongs to. */
  project: z.object({ id: z.string().min(1) }).passthrough().optional(),
  flow: z.object({
    studiesIncluded: z.number().int().nonnegative().nullable(),
  }).passthrough(),
  includedStudies: z.array(z.object({ id: z.string().min(1) }).passthrough()),
}).passthrough();

export const rqFindingsSchema = z.array(z.object({}).passthrough());

export const supplementsSchema = z.object({
  prisma_writing_export: prismaWritingExportSchema.optional(),
  rq_findings: rqFindingsSchema.optional(),
}).default({});

export const importInputSchema = z.object({
  run: runSchema,
  corpus: corpusSchema,
  artifacts: z.record(artifactType, artifactPayloadSchema).default({}),
  supplements: supplementsSchema,
});

export type Corpus = z.infer<typeof corpusSchema>;
export type SlrRun = z.infer<typeof runSchema>;
export type ArtifactPayload = z.infer<typeof artifactPayloadSchema>;
export type ImportInput = z.infer<typeof importInputSchema>;
export type Supplements = z.infer<typeof supplementsSchema>;
export type ArtifactTypeName = z.infer<typeof artifactType>;

/**
 * slr-be wraps most responses as `{success, isSuccess, data, message}` but some modules return the data directly.
 * Accept both. A `{success: false}` body is an error, never data.
 */
export function unwrapEnvelope(body: unknown): unknown {
  if (body && typeof body === 'object' && 'success' in body) {
    const envelope = body as { success?: unknown; data?: unknown };
    // Only a boolean true is success. "false", 0 or null next to some data must not read as success.
    if (envelope.success !== true) throw new Error('slr-be returned an error envelope');
    if ('data' in envelope) return envelope.data;
  }
  return body;
}
