import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { guardIdParam } from '../../middleware/param-guard.middleware.js';
import { validate } from '../../middleware/validation.middleware.js';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import { jobListQuerySchema } from './jobs.schemas.js';
import { jobsService } from './jobs.service.js';

const router = Router();
router.use(requireAuth);
router.param('jobId', guardIdParam('Job not found', 'JOB_NOT_FOUND'));

router.get('/', validate(jobListQuerySchema), (req: AuthenticatedRequest, res, next) => {
  try {
    const query = req.query as unknown as {
      status?: any;
      type?: string;
      projectId?: string;
      snapshotId?: string;
      page?: number;
      limit?: number;
    };
    const result = jobsService.listJobs(req.user!.uid, query);
    return res.json({ success: true, data: result });
  } catch (error) {
    return next(error);
  }
});

router.get('/:jobId', (req: AuthenticatedRequest, res, next) => {
  try {
    const job = jobsService.getJob(req.params.jobId, req.user!.uid);
    return res.json({ success: true, data: job });
  } catch (error) {
    return next(error);
  }
});

router.post('/:jobId/cancel', (req: AuthenticatedRequest, res, next) => {
  try {
    const job = jobsService.cancelJob(req.params.jobId, req.user!.uid);
    return res.json({ success: true, data: job });
  } catch (error) {
    return next(error);
  }
});

export default router;

