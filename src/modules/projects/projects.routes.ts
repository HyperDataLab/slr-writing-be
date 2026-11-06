import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { guardIdParam } from '../../middleware/param-guard.middleware.js';
import { hasUnstorableText } from '../../shared/utils/storable.js';
import { SlrClient } from '../slr-client/slr-client.js';
import { validate } from '../../middleware/validation.middleware.js';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import snapshotRoutes from '../snapshots/snapshots.routes.js';
import { createProject, getOwnedProject, listProjects } from './projects.service.js';
import { listSlrRuns } from './slr-runs.service.js';

const router = Router();
router.use(requireAuth);
router.param('projectId', guardIdParam('Project not found', 'PROJECT_NOT_FOUND'));

const createSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(200).refine((value) => !hasUnstorableText(value), 'Contains a character that cannot be stored'),
    slrProjectId: z.string().trim().min(1).max(200)
      // "." and ".." would be resolved as path segments when used in a URL.
      .refine((value) => !/^\.+$/.test(value), 'Invalid SLR project id')
      .refine((value) => !hasUnstorableText(value), 'Contains a character that cannot be stored'),
  }),
});

router.post('/', validate(createSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    // Linking is only allowed to an SLR project the caller can read on slr-be, using the caller's own token.
    if (env.SLR_VERIFY_PROJECT_ACCESS) {
      await new SlrClient().assertProjectAccess(req.body.slrProjectId, { authorization: req.header('authorization') });
    }
    const project = await createProject(req.user!.uid, req.body);
    return res.status(201).json({ success: true, data: project });
  } catch (error) { return next(error); }
});

router.get('/', async (req: AuthenticatedRequest, res, next) => {
  try {
    return res.json({ success: true, data: await listProjects(req.user!.uid) });
  } catch (error) { return next(error); }
});

router.get('/:projectId', async (req: AuthenticatedRequest, res, next) => {
  try {
    return res.json({ success: true, data: await getOwnedProject(req.user!.uid, req.params.projectId) });
  } catch (error) { return next(error); }
});

// Runs of the linked SLR project (read from slr-be with the caller's token), for the import picker.
router.get('/:projectId/slr-runs', async (req: AuthenticatedRequest, res, next) => {
  try {
    const runs = await listSlrRuns(
      { ownerId: req.user!.uid, projectId: req.params.projectId },
      { authorization: req.header('authorization') },
    );
    return res.json({ success: true, data: runs });
  } catch (error) { return next(error); }
});

router.use('/:projectId/snapshots', snapshotRoutes);

export default router;
