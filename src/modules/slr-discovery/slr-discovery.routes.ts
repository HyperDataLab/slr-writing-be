import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { guardIdParam } from '../../middleware/param-guard.middleware.js';
import { validate } from '../../middleware/validation.middleware.js';
import { createUserRateLimiter } from '../../middleware/rate-limit.middleware.js';
import { hasUnstorableText } from '../../shared/utils/storable.js';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import { SlrClient } from '../slr-client/slr-client.js';

const router = Router();
router.use(requireAuth);
router.param('projectId', guardIdParam('SLR project not found', 'SLR_NOT_FOUND'));

const slrDiscoveryLimiter = createUserRateLimiter({ max: 60 });

const projectListQuerySchema = z.object({
  query: z.object({
    search: z.string().trim().max(200).refine((value) => !hasUnstorableText(value), 'Contains a character that cannot be stored').optional(),
    pageNumber: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  }),
});

router.get('/projects', slrDiscoveryLimiter, validate(projectListQuerySchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { search = '', pageNumber, pageSize } = req.query as unknown as {
      search?: string;
      pageNumber: number;
      pageSize: number;
    };
    const data = await new SlrClient().listProjects(search, pageNumber, pageSize, {
      authorization: req.header('authorization'),
    });
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
});

router.get('/projects/:projectId/runs', slrDiscoveryLimiter, async (req: AuthenticatedRequest, res, next) => {
  try {
    const data = await new SlrClient().listRuns(req.params.projectId, {
      authorization: req.header('authorization'),
    });
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
});

export default router;
