import { Router, type Request } from 'express';
import { z } from 'zod';
import { BadRequestError } from '../../shared/errors/app-error.js';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import { findStorableProblem } from '../../shared/utils/storable.js';
import { paragraphPlanContentSchema } from './paragraph-plan.types.js';
import {
  createParagraphPlans,
  getParagraphPlansView,
  updateParagraphPlans,
} from './paragraph-plan.service.js';

/**
 * Mounted at `/projects/:projectId/snapshots/:snapshotId/manuscript/paragraph-plans`.
 * Parent router has already verified authentication and ownership of the project.
 */
const router = Router({ mergeParams: true });

type Params = { projectId: string; snapshotId: string; version?: string };

const MAX_BODY_NODES = 200_000;
const versionSchema = z.number().int().min(1).max(1_000_000);

const saveBody = z.object({
  baseVersion: versionSchema,
  content: paragraphPlanContentSchema,
}).strict();

function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown, code: string): T {
  const problem = findStorableProblem(body, { maxDepth: 64, maxNodes: MAX_BODY_NODES });
  if (problem === 'too_large') throw new BadRequestError('Invalid request: too many values', code);
  if (problem === 'too_deep') throw new BadRequestError('Invalid request: nested too deeply', code);
  if (problem === 'unstorable_text') throw new BadRequestError('Invalid request: contains a character that cannot be stored', code);

  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.code === 'unrecognized_keys' ? 'unknown field' : issue.message}`.slice(0, 160))
    .join('; ');
  throw new BadRequestError(`Invalid request: ${detail}`, code);
}

// Generate the initial ParagraphPlans from the approved Blueprint (H1) and Snapshot.
// 201 when created, 200 when already exists (never silently overwritten).
router.post('/', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const { revision, created } = await createParagraphPlans({
      projectId: req.params.projectId,
      snapshotId: req.params.snapshotId,
      actor: req.user!.uid,
    });
    return res.status(created ? 201 : 200).json({ success: true, data: { revision, created } });
  } catch (error) {
    return next(error);
  }
});

// Get the latest ParagraphPlans view (includes issues, stats, and version history).
router.get('/', async (req: Request<Params>, res, next) => {
  try {
    const view = await getParagraphPlansView({
      projectId: req.params.projectId,
      snapshotId: req.params.snapshotId,
    });
    return res.json({ success: true, data: view });
  } catch (error) {
    return next(error);
  }
});

// Update the ParagraphPlans by saving a new revision.
// 201 on new revision, 200 if identical, 409 if baseVersion is stale.
router.put('/', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const body = parseBody(saveBody, req.body, 'INVALID_PARAGRAPH_PLANS');
    const { revision, created } = await updateParagraphPlans({
      projectId: req.params.projectId,
      snapshotId: req.params.snapshotId,
      actor: req.user!.uid,
      baseVersion: body.baseVersion,
      content: body.content,
    });
    return res.status(created ? 201 : 200).json({ success: true, data: { revision, created } });
  } catch (error) {
    return next(error);
  }
});

// Get a specific version of ParagraphPlans.
router.get('/revisions/:version', async (req: Request<Params>, res, next) => {
  try {
    const versionParam = req.params.version;
    if (!versionParam || !/^[1-9]\d{0,8}$/.test(versionParam)) {
      throw new BadRequestError('The version must be a positive integer', 'INVALID_VERSION');
    }
    const view = await getParagraphPlansView({
      projectId: req.params.projectId,
      snapshotId: req.params.snapshotId,
      version: Number(versionParam),
    });
    return res.json({ success: true, data: view });
  } catch (error) {
    return next(error);
  }
});

export default router;

