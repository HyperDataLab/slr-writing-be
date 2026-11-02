import { Router, type Request } from 'express';
import { BadRequestError } from '../../shared/errors/app-error.js';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import { generateMethods, getLatestMethods, getMethodsRevision } from './methods.service.js';

/**
 * Mounted at `/projects/:projectId/snapshots/:snapshotId/manuscript/methods`. The snapshots router above it has
 * already required authentication and proved that the caller owns the project.
 */
const router = Router({ mergeParams: true });

type Params = { projectId: string; snapshotId: string; version: string };

// Write Methods from the snapshot. 201 for a new version, 200 when the text is unchanged.
router.post('/', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const { revision, created } = await generateMethods({
      projectId: req.params.projectId, snapshotId: req.params.snapshotId, actor: req.user!.uid,
    });
    return res.status(created ? 201 : 200).json({ success: true, data: { revision, created } });
  } catch (error) { return next(error); }
});

router.get('/', async (req: Request<Params>, res, next) => {
  try {
    return res.json({ success: true, data: await getLatestMethods(req.params.projectId, req.params.snapshotId) });
  } catch (error) { return next(error); }
});

router.get('/revisions/:version', async (req: Request<Params>, res, next) => {
  try {
    if (!/^[1-9]\d{0,8}$/.test(req.params.version)) throw new BadRequestError('The version must be a positive integer', 'INVALID_VERSION');
    return res.json({ success: true, data: await getMethodsRevision(req.params.projectId, req.params.snapshotId, Number(req.params.version)) });
  } catch (error) { return next(error); }
});

export default router;
