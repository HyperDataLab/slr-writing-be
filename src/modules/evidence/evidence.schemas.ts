import { z } from 'zod';
import { hasUnstorableText } from '../../shared/utils/storable.js';

export const evidenceListQuerySchema = z.object({
  query: z.object({
    search: z
      .string()
      .trim()
      .max(200)
      .refine((v) => !hasUnstorableText(v), 'Contains unstorable characters')
      .optional(),
    verified: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    studyId: z.string().trim().max(200).optional(),
    claimId: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
});

