import { z } from 'zod';

export const gateStatusSchema = z.enum([
  'PASS',
  'WARNING',
  'FAIL',
  'NEEDS_REVIEW',
  'NOT_APPLICABLE',
  'NOT_RUN',
]);

export const gateSeveritySchema = z.enum(['BLOCKING', 'WARNING']);

export const gateIdSchema = z.enum(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);

export const verificationOverallStatusSchema = z.enum([
  'PASSED',
  'PASSED_WITH_WARNINGS',
  'FAILED',
]);

export const reviewIssueSchema = z.object({
  id: z.string(),
  gateId: gateIdSchema,
  severity: gateSeveritySchema,
  sectionKey: z.string(),
  target: z.string(),
  message: z.string(),
  evidenceExcerpt: z.string().optional(),
  suggestedRemedy: z.string().optional(),
});

export const qualityGateResultSchema = z.object({
  gateId: gateIdSchema,
  name: z.string(),
  status: gateStatusSchema,
  severity: gateSeveritySchema,
  message: z.string(),
  issuesCount: z.number().int().nonnegative(),
  details: z.record(z.string(), z.unknown()).default({}),
  evaluatedAt: z.string(),
});

export const citationItemSchema = z.object({
  citationId: z.string(),
  sectionKey: z.string(),
  paragraphId: z.string(),
  evidenceId: z.string().optional(),
  findingId: z.string().optional(),
  studyId: z.string(),
  studyTitle: z.string(),
  studyYear: z.number().int().nullable(),
  quote: z.string().optional(),
  quoteHashVerified: z.boolean(),
  isResolved: z.boolean(),
});

export const unresolvedCitationSchema = z.object({
  marker: z.string(),
  location: z.string(),
  reason: z.string(),
});

export const citationManifestSchema = z.object({
  manuscriptId: z.string(),
  snapshotId: z.string(),
  items: z.array(citationItemSchema),
  unresolvedCitations: z.array(unresolvedCitationSchema),
  totalCitations: z.number().int().nonnegative(),
  resolvedCitations: z.number().int().nonnegative(),
});

export const verificationSummarySchema = z.object({
  totalGates: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  notApplicable: z.number().int().nonnegative(),
  notRun: z.number().int().nonnegative(),
  blockingIssues: z.number().int().nonnegative(),
  warningIssues: z.number().int().nonnegative(),
  /** Fingerprint of the section revisions this report checked (see fingerprintSections). Absent on older reports. */
  verifiedContentHash: z.string().optional(),
});

export const verificationReportSummaryRowSchema = z.object({
  version: z.number().int().positive(),
  status: verificationOverallStatusSchema,
  runAt: z.string(),
  runBy: z.string(),
});

export const verificationReportViewSchema = z.object({
  id: z.string(),
  manuscriptId: z.string(),
  version: z.number().int().positive(),
  status: verificationOverallStatusSchema,
  summary: verificationSummarySchema,
  manifest: citationManifestSchema,
  gates: z.record(gateIdSchema, qualityGateResultSchema),
  issues: z.array(reviewIssueSchema),
  runBy: z.string(),
  runAt: z.string(),
  versions: z.array(verificationReportSummaryRowSchema),
});

export type GateStatus = z.infer<typeof gateStatusSchema>;
export type GateSeverity = z.infer<typeof gateSeveritySchema>;
export type GateId = z.infer<typeof gateIdSchema>;
export type VerificationOverallStatus = z.infer<typeof verificationOverallStatusSchema>;
export type ReviewIssue = z.infer<typeof reviewIssueSchema>;
export type QualityGateResult = z.infer<typeof qualityGateResultSchema>;
export type CitationItem = z.infer<typeof citationItemSchema>;
export type UnresolvedCitation = z.infer<typeof unresolvedCitationSchema>;
export type CitationManifest = z.infer<typeof citationManifestSchema>;
export type VerificationSummary = z.infer<typeof verificationSummarySchema>;
export type VerificationReportSummaryRow = z.infer<typeof verificationReportSummaryRowSchema>;
export type VerificationReportView = z.infer<typeof verificationReportViewSchema>;

