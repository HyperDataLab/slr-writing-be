import { z } from 'zod';
import { gateIdSchema, gateStatusSchema } from '../verification/verification.types.js';

export const h3DecisionSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((data) => data.decision !== 'REJECTED' || (data.note && data.note.length >= 3), {
    message: 'A rejection reason (note) of at least 3 characters is mandatory when rejecting H3',
    path: ['note'],
  });

export type H3DecisionInput = z.infer<typeof h3DecisionSchema>;

export const h3StatusSchema = z
  .object({
    h3Status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    canApprove: z.boolean(),
    readiness: z.object({
      h1Approved: z.boolean(),
      requiredSectionsDrafted: z.boolean(),
      allH2Approved: z.boolean(),
      verificationCurrent: z.boolean(),
      qualityGates: z.array(z.object({
        gateId: gateIdSchema,
        status: gateStatusSchema,
      }).strict()),
    }).strict(),
    blockingReasons: z.array(z.string()),
    compositeTargetHash: z.string(),
    latestApproval: z
      .object({
        id: z.string(),
        seq: z.number().int(),
        stage: z.literal('H3'),
        decision: z.enum(['APPROVED', 'REJECTED']),
        note: z.string().nullable(),
        decidedBy: z.string(),
        slrRole: z.string(),
        decidedAt: z.string(),
        targetHash: z.string(),
      })
      .nullable(),
    requiredSections: z.array(z.string()),
    omittedSections: z.array(z.string()),
    verificationSummary: z
      .object({
        version: z.number().int(),
        status: z.string(),
        passed: z.number().int(),
        warnings: z.number().int(),
        failed: z.number().int(),
        needsReview: z.number().int(),
        blockingIssuesCount: z.number().int(),
      })
      .nullable(),
  })
  .strict();

export type H3StatusView = z.infer<typeof h3StatusSchema>;

export const lineageItemSchema = z
  .object({
    sectionKey: z.string(),
    paragraphIndex: z.number().int(),
    paragraphKey: z.string().optional(),
    text: z.string(),
    rhetoricalMove: z.string().optional(),
    claimSlot: z.string().optional(),
    claimStrength: z.string().optional(),
    usedFindingIds: z.array(z.string()),
    usedEvidenceIds: z.array(z.string()),
    findings: z.array(
      z.object({
        id: z.string(),
        externalId: z.string(),
        fieldName: z.string(),
        sectionName: z.string(),
        valueText: z.string(),
        consensusMatch: z.string().optional(),
      })
    ),
    evidence: z.array(
      z.object({
        id: z.string(),
        externalId: z.string(),
        studyId: z.string(),
        quote: z.string(),
        quoteHashVerified: z.boolean(),
        page: z.number().int().nullable(),
        section: z.string().nullable(),
        paragraph: z.number().int().nullable(),
        studyTitle: z.string().optional(),
        studyAuthors: z.array(z.string()).optional(),
        studyYear: z.number().int().nullable().optional(),
        studyDoi: z.string().nullable().optional(),
        sourceRevision: z.string().optional(),
      })
    ),
  })
  .strict();

export type LineageItem = z.infer<typeof lineageItemSchema>;

export const exportManifestItemSchema = z
  .object({
    filename: z.string(),
    sizeBytes: z.number().int(),
    sha256: z.string(),
    contentType: z.string(),
    description: z.string(),
  })
  .strict();

export type ExportManifestItem = z.infer<typeof exportManifestItemSchema>;

export const exportPackageViewSchema = z
  .object({
    id: z.string(),
    manuscriptId: z.string(),
    version: z.number().int(),
    packageHash: z.string(),
    h3ApprovalId: z.string(),
    verificationReportId: z.string(),
    manifest: z.array(exportManifestItemSchema),
    bundle: z.record(z.unknown()),
    exportedBy: z.string(),
    exportedAt: z.string(),
  })
  .strict();

export type ExportPackageView = z.infer<typeof exportPackageViewSchema>;

