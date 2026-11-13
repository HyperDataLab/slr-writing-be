import { Router, type Request } from 'express';
import { guardIdParam } from '../../middleware/param-guard.middleware.js';
import { validate } from '../../middleware/validation.middleware.js';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import { evidenceListQuerySchema } from './evidence.schemas.js';
import { listSnapshotEvidence, getSnapshotEvidenceById } from './evidence.service.js';

/**
 * Mounted at `/projects/:projectId/snapshots/:snapshotId/evidence`.
 * The parent snapshots router already verifies user authentication and project ownership.
 */
const router = Router({ mergeParams: true });
router.param('evidenceId', guardIdParam('Evidence not found', 'EVIDENCE_NOT_FOUND'));

type Params = { projectId: string; snapshotId: string; evidenceId?: string };

router.get(
  '/',
  validate(evidenceListQuerySchema),
  async (req: AuthenticatedRequest & Request<Params>, res, next) => {
    try {
      const { projectId, snapshotId } = req.params;
      const query = req.query as unknown as {
        search?: string;
        verified?: boolean;
        studyId?: string;
        claimId?: string;
        page: number;
        limit: number;
      };

      const result = await listSnapshotEvidence({
        projectId,
        snapshotId,
        query,
      });

      return res.json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/:evidenceId',
  async (req: AuthenticatedRequest & Request<Params>, res, next) => {
    try {
      const { projectId, snapshotId, evidenceId } = req.params;
      const result = await getSnapshotEvidenceById({
        projectId,
        snapshotId,
        evidenceId: evidenceId!,
      });

      return res.json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;

