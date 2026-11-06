import { Router, type Request } from 'express';
import { z } from 'zod';
import { BadRequestError } from '../../shared/errors/app-error.js';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import { findStorableProblem } from '../../shared/utils/storable.js';
import { getOwnedProject } from '../projects/projects.service.js';
import { generateSynthesisSection } from '../summary-sections/summary-sections.service.js';
import { isSynthesisSection } from '../summary-sections/summary-sections.js';
import { manualDraftEditSchema } from './drafting.types.js';
import {
  decideSectionRevision,
  generateSectionDraft,
  getSectionDraftView,
  saveSectionDraft,
} from './drafting.service.js';

/**
 * Mounted at `/projects/:projectId/snapshots/:snapshotId/manuscript/sections/:sectionKey`.
 * Parent router has already verified authentication and verified project ownership.
 */
const router = Router({ mergeParams: true });

type Params = { projectId: string; snapshotId: string; sectionKey: string; version?: string };

const MAX_BODY_NODES = 200_000;
const versionSchema = z.number().int().min(1).max(1_000_000);
const noteSchema = z
  .string()
  .max(2000)
  .refine((v) => v.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '') !== '', 'The note must contain visible text');

const approveBody = z.object({ version: versionSchema, note: noteSchema.optional() }).strict();
const rejectBody = z.object({ version: versionSchema, note: noteSchema }).strict();

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

// Generate section draft using LLM from READY_TO_DRAFT paragraph plans.
// 201 when new revision created, 200 when identical text is already the latest.
router.post('/draft', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const target = {
      projectId: req.params.projectId,
      snapshotId: req.params.snapshotId,
      actor: req.user!.uid,
    };
    // Abstract and Conclusion are written from the approved sections, not from paragraph plans.
    const { revision, created } = isSynthesisSection(req.params.sectionKey)
      ? await generateSynthesisSection({ ...target, sectionKey: req.params.sectionKey })
      : await generateSectionDraft({ ...target, sectionKey: req.params.sectionKey });
    return res.status(created ? 201 : 200).json({ success: true, data: { revision, created } });
  } catch (error) {
    return next(error);
  }
});

// Get the latest view of the section draft (including markdown, facts, H2 approval, versions).
router.get('/', async (req: Request<Params>, res, next) => {
  try {
    const view = await getSectionDraftView({
      projectId: req.params.projectId,
      snapshotId: req.params.snapshotId,
      sectionKey: req.params.sectionKey,
    });
    return res.json({ success: true, data: view });
  } catch (error) {
    return next(error);
  }
});

// Save a manual edit of the section draft as a new revision (version = baseVersion + 1).
router.put('/', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const body = parseBody(manualDraftEditSchema, req.body, 'INVALID_DRAFT_EDIT');
    const { revision, created } = await saveSectionDraft({
      projectId: req.params.projectId,
      snapshotId: req.params.snapshotId,
      actor: req.user!.uid,
      sectionKey: req.params.sectionKey,
      baseVersion: body.baseVersion,
      markdown: body.markdown,
    });
    return res.status(created ? 201 : 200).json({ success: true, data: { revision, created } });
  } catch (error) {
    return next(error);
  }
});

// View a specific version of the section draft.
router.get('/revisions/:version', async (req: Request<Params>, res, next) => {
  try {
    const versionParam = req.params.version;
    if (!versionParam || !/^[1-9]\d{0,8}$/.test(versionParam)) {
      throw new BadRequestError('The version must be a positive integer', 'INVALID_VERSION');
    }
    const view = await getSectionDraftView({
      projectId: req.params.projectId,
      snapshotId: req.params.snapshotId,
      sectionKey: req.params.sectionKey,
      version: Number(versionParam),
    });
    return res.json({ success: true, data: view });
  } catch (error) {
    return next(error);
  }
});

// H2: OWNER approves the latest section revision.
router.post('/approve', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const body = parseBody(approveBody, req.body, 'INVALID_REQUEST');
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    const { approval, created } = await decideSectionRevision({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
      slrProjectId: project.slrProjectId,
      authorization: req.header('authorization'),
      actor: req.user!.uid,
      sectionKey: req.params.sectionKey,
      version: body.version,
      decision: 'APPROVED',
      note: body.note ?? null,
    });
    return res.status(created ? 201 : 200).json({ success: true, data: { approval, created } });
  } catch (error) {
    return next(error);
  }
});

// H2: OWNER rejects the latest section revision.
router.post('/reject', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const body = parseBody(rejectBody, req.body, 'INVALID_REQUEST');
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    const { approval, created } = await decideSectionRevision({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
      slrProjectId: project.slrProjectId,
      authorization: req.header('authorization'),
      actor: req.user!.uid,
      sectionKey: req.params.sectionKey,
      version: body.version,
      decision: 'REJECTED',
      note: body.note,
    });
    return res.status(created ? 201 : 200).json({ success: true, data: { approval, created } });
  } catch (error) {
    return next(error);
  }
});

export default router;

