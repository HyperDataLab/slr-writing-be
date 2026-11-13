import { Router, type Request } from 'express';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import { env } from '../../config/env.js';
import { guardIdParam } from '../../middleware/param-guard.middleware.js';
import { createUserRateLimiter } from '../../middleware/rate-limit.middleware.js';
import { BadRequestError, ForbiddenError } from '../../shared/errors/app-error.js';
import blueprintRoutes from '../blueprint/blueprint.routes.js';
import draftingRoutes from '../drafting/drafting.routes.js';
import evidenceRoutes from '../evidence/evidence.routes.js';
import exportRouter from '../export/export.routes.js';
import methodsRoutes from '../methods/methods.routes.js';
import paragraphPlanRoutes from '../paragraph-plans/paragraph-plan.routes.js';
import { verificationRouter } from '../verification/verification.routes.js';
import { getOwnedProject } from '../projects/projects.service.js';
import { SlrClient, isValidRunId } from '../slr-client/slr-client.js';
import { importSnapshot, validateImport } from './snapshot-import.service.js';
import { getSnapshot, listSnapshots } from './snapshots.service.js';

/** Mounted at `/projects/:projectId/snapshots`; the parent router already requires authentication. */
const router = Router({ mergeParams: true });
router.param('snapshotId', guardIdParam('Snapshot not found', 'SNAPSHOT_NOT_FOUND'));

// Express cannot infer params that come from the parent router's path, so name them here.
type Params = { projectId: string; snapshotId: string };

// Every route first proves the caller owns the project.
router.use(async (req: AuthenticatedRequest, _res, next) => {
  try {
    await getOwnedProject(req.user!.uid, req.params.projectId);
    return next();
  } catch (error) { return next(error); }
});

// Dry run: report readiness without storing anything.
router.post('/validate', (req, res, next) => {
  try {
    return res.json({ success: true, data: validateImport(req.body) });
  } catch (error) { return next(error); }
});

// Pull a run straight from slr-be with the caller's own token, then import it like any other run.
// Each call fans out to several requests on slr-be, so it is limited per user.
const fromSlrLimiter = createUserRateLimiter();

router.post('/from-slr', fromSlrLimiter, async (req: AuthenticatedRequest, res, next) => {
  try {
    const runId: unknown = req.body?.runId;
    if (!isValidRunId(runId)) throw new BadRequestError('runId is required and must be a valid slr-be run id', 'INVALID_RUN_ID');
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    const input = await new SlrClient().fetchRun(project.slrProjectId, runId, { authorization: req.header('authorization') });
    const result = await importSnapshot({ projectId: project.id, importedBy: req.user!.uid, input, source: 'slr-be' });
    return res.status(result.created ? 201 : 200).json({
      success: true,
      data: { snapshot: result.snapshot, created: result.created, warnings: result.readiness.issues },
    });
  } catch (error) { return next(error); }
});

// Import a client-posted bundle. 201 for a new snapshot, 200 when the same content was imported before.
router.post('/', async (req: AuthenticatedRequest, res, next) => {
  try {
    // The client-posted snapshot bundle is validated and recorded with manual provenance; deployments can disable this path.
    if (!env.ALLOW_MANUAL_SNAPSHOT_IMPORT) {
      throw new ForbiddenError('Importing a snapshot bundle by hand is disabled; use /snapshots/from-slr', 'MANUAL_IMPORT_DISABLED');
    }
    const result = await importSnapshot({ projectId: req.params.projectId, importedBy: req.user!.uid, input: req.body });
    return res.status(result.created ? 201 : 200).json({
      success: true,
      data: { snapshot: result.snapshot, created: result.created, warnings: result.readiness.issues },
    });
  } catch (error) { return next(error); }
});

router.get('/', async (req: Request<Params>, res, next) => {
  try {
    return res.json({ success: true, data: await listSnapshots(req.params.projectId) });
  } catch (error) { return next(error); }
});

router.get('/:snapshotId', async (req: Request<Params>, res, next) => {
  try {
    return res.json({ success: true, data: await getSnapshot(req.params.projectId, req.params.snapshotId) });
  } catch (error) { return next(error); }
});

// Snapshot Evidence Registry
router.use('/:snapshotId/evidence', evidenceRoutes);

// Sections of the manuscript written from one snapshot.
router.use('/:snapshotId/manuscript/methods', methodsRoutes);
router.use('/:snapshotId/manuscript/blueprint', blueprintRoutes);
router.use('/:snapshotId/manuscript/paragraph-plans', paragraphPlanRoutes);
router.use('/:snapshotId/manuscript/sections/:sectionKey', draftingRoutes);
router.use('/:snapshotId/manuscript', verificationRouter);
router.use('/:snapshotId/manuscript', exportRouter);

export default router;
