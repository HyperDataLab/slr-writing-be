import { Router, type Request } from 'express';
import { z } from 'zod';
import { BadRequestError } from '../../shared/errors/app-error.js';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import { getOwnedProject } from '../projects/projects.service.js';
import { blueprintContentSchema } from './blueprint.types.js';
import {
  createBlueprint, decideBlueprint, getBlueprint, getBlueprintRevision, saveBlueprint,
} from './blueprint.service.js';

/**
 * Mounted at `/projects/:projectId/snapshots/:snapshotId/manuscript/blueprint`. The snapshots router above it has
 * already required authentication and proved that the caller owns the writing project.
 */
const router = Router({ mergeParams: true });

type Params = { projectId: string; snapshotId: string; version: string };

const version = z.number().int().min(1).max(1_000_000);
const note = z.string().max(2000).refine((value) => value.replace(/[\s​-‍⁠﻿]/g, '') !== '', 'The note must contain visible text');

const createBody = z.object({ profileId: z.string().min(1).max(64).optional() }).strict();
const saveBody = z.object({ baseVersion: version, content: blueprintContentSchema }).strict();
const approveBody = z.object({ version, note: note.optional() }).strict();
const rejectBody = z.object({ version, note }).strict();

/** Parses a request body; on failure reports the first few problems, never the whole (possibly huge) input. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown, code: string): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
  throw new BadRequestError(`Invalid request: ${detail}`, code);
}

// Make the first blueprint from the profile and the snapshot. 201 when made, 200 when one already exists (it is never overwritten).
router.post('/', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const body = parseBody(createBody, req.body, 'INVALID_REQUEST');
    const { revision, created } = await createBlueprint({
      projectId: req.params.projectId, snapshotId: req.params.snapshotId, actor: req.user!.uid, profileId: body.profileId,
    });
    return res.status(created ? 201 : 200).json({ success: true, data: { revision, created } });
  } catch (error) { return next(error); }
});

router.get('/', async (req: Request<Params>, res, next) => {
  try {
    return res.json({ success: true, data: await getBlueprint(req.params.projectId, req.params.snapshotId) });
  } catch (error) { return next(error); }
});

// Save an edit as the next version. 201 for a new version, 200 when nothing changed, 409 when the base version is not the latest.
router.put('/', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const body = parseBody(saveBody, req.body, 'INVALID_BLUEPRINT');
    const { revision, created } = await saveBlueprint({
      projectId: req.params.projectId, snapshotId: req.params.snapshotId, actor: req.user!.uid, baseVersion: body.baseVersion, content: body.content,
    });
    return res.status(created ? 201 : 200).json({ success: true, data: { revision, created } });
  } catch (error) { return next(error); }
});

router.get('/revisions/:version', async (req: Request<Params>, res, next) => {
  try {
    if (!/^[1-9]\d{0,8}$/.test(req.params.version)) throw new BadRequestError('The version must be a positive integer', 'INVALID_VERSION');
    return res.json({ success: true, data: await getBlueprintRevision(req.params.projectId, req.params.snapshotId, Number(req.params.version)) });
  } catch (error) { return next(error); }
});

// H1. Only the OWNER of the SLR project may decide; the role is asked of slr-be with the caller's own token.
const decide = (decision: 'APPROVED' | 'REJECTED', schema: z.ZodType<{ version: number; note?: string }>) =>
  async (req: AuthenticatedRequest & Request<Params>, res: import('express').Response, next: import('express').NextFunction) => {
    try {
      const body = parseBody(schema, req.body, 'INVALID_REQUEST');
      const project = await getOwnedProject(req.user!.uid, req.params.projectId);
      const { approval, created } = await decideBlueprint({
        projectId: project.id, snapshotId: req.params.snapshotId, slrProjectId: project.slrProjectId, authorization: req.header('authorization'),
        actor: req.user!.uid, version: body.version, decision, note: body.note ?? null,
      });
      return res.status(created ? 201 : 200).json({ success: true, data: { approval, created } });
    } catch (error) { return next(error); }
  };

router.post('/approve', decide('APPROVED', approveBody));
router.post('/reject', decide('REJECTED', rejectBody));

export default router;
