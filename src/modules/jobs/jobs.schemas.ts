import { z } from 'zod';
import { hasUnstorableText } from '../../shared/utils/storable.js';

export const jobStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);

export const jobListQuerySchema = z.object({
  query: z.object({
    status: jobStatusSchema.optional(),
    type: z
      .string()
      .trim()
      .max(100)
      .refine((v) => !hasUnstorableText(v), 'Contains unstorable characters')
      .optional(),
    projectId: z.string().trim().max(100).optional(),
    snapshotId: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});

