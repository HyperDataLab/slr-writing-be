import { Router, type Request } from 'express';
import { BadRequestError } from '../../shared/errors/app-error.js';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import { getOwnedProject } from '../projects/projects.service.js';
import {
  createExportPackage,
  decideH3,
  downloadExportPdf,
  downloadExportZip,
  getExportPackageByVersion,
  getH3Status,
  getLatestExportPackage,
  queryLineage,
} from './export.service.js';
import { h3DecisionSchema } from './export.types.js';

export const exportRouter = Router({ mergeParams: true });

type Params = { projectId: string; snapshotId: string; version?: string };

/**
 * GET /api/projects/:projectId/snapshots/:snapshotId/manuscript/final/status
 * Evaluates H3 readiness and prerequisites for final approval.
 */
exportRouter.get('/final/status', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    const status = await getH3Status({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
    });
    return res.status(200).json({ success: true, data: status });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/projects/:projectId/snapshots/:snapshotId/manuscript/final/approve
 * Human-in-the-loop checkpoint H3: Final manuscript approval by SLR project Owner.
 */
exportRouter.post('/final/approve', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const parsed = h3DecisionSchema.safeParse({ decision: 'APPROVED', note: req.body?.note });
    if (!parsed.success) {
      throw new BadRequestError('Invalid H3 approval payload', 'INVALID_REQUEST');
    }
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    const approval = await decideH3({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
      slrProjectId: project.slrProjectId,
      authorization: req.header('authorization'),
      actor: req.user!.uid,
      decision: 'APPROVED',
      note: parsed.data.note,
    });
    return res.status(200).json({ success: true, data: approval });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/projects/:projectId/snapshots/:snapshotId/manuscript/final/reject
 * Final rejection of manuscript with mandatory explanatory note.
 */
exportRouter.post('/final/reject', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const parsed = h3DecisionSchema.safeParse({ decision: 'REJECTED', note: req.body?.note });
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || 'Invalid H3 rejection payload';
      throw new BadRequestError(msg, 'INVALID_REQUEST');
    }
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    const approval = await decideH3({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
      slrProjectId: project.slrProjectId,
      authorization: req.header('authorization'),
      actor: req.user!.uid,
      decision: 'REJECTED',
      note: parsed.data.note,
    });
    return res.status(200).json({ success: true, data: approval });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/projects/:projectId/snapshots/:snapshotId/manuscript/export
 * Creates an immutable SubmissionPackage (fail-closed if H3 unapproved or gates failed).
 */
exportRouter.post('/export', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    const pkg = await createExportPackage({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
      slrProjectId: project.slrProjectId,
      authorization: req.header('authorization'),
      actor: req.user!.uid,
    });
    return res.status(201).json({ success: true, data: pkg });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/projects/:projectId/snapshots/:snapshotId/manuscript/export
 * Retrieves metadata for the latest exported package.
 */
exportRouter.get('/export', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    const pkg = await getLatestExportPackage({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
    });
    return res.status(200).json({ success: true, data: pkg });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/projects/:projectId/snapshots/:snapshotId/manuscript/export/revisions/:version
 * Retrieves an exported package by version number.
 */
exportRouter.get('/export/revisions/:version', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    if (!/^[1-9]\d{0,8}$/.test(req.params.version || '')) {
      throw new BadRequestError('Version must be a positive integer', 'INVALID_VERSION');
    }
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    const pkg = await getExportPackageByVersion({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
      version: Number(req.params.version),
    });
    return res.status(200).json({ success: true, data: pkg });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/projects/:projectId/snapshots/:snapshotId/manuscript/export/download
 * Downloads the full submission-package.zip archive.
 */
exportRouter.get('/export/download', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    let versionNum: number | undefined;
    if (req.query.version) {
      if (!/^[1-9]\d{0,8}$/.test(String(req.query.version))) {
        throw new BadRequestError('Version query parameter must be a positive integer', 'INVALID_VERSION');
      }
      versionNum = Number(req.query.version);
    }

    const { filename, zipBuffer, packageHash } = await downloadExportZip({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
      version: versionNum,
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.setHeader('ETag', `"${packageHash}"`);
    return res.status(200).send(zipBuffer);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/projects/:projectId/snapshots/:snapshotId/manuscript/export/download-pdf
 * Downloads or views the compiled publication PDF in IEEE Two-Column or Standard IMRaD format.
 */
exportRouter.get('/export/download-pdf', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    let versionNum: number | undefined;
    if (req.query.version) {
      if (!/^[1-9]\d{0,8}$/.test(String(req.query.version))) {
        throw new BadRequestError('Version query parameter must be a positive integer', 'INVALID_VERSION');
      }
      versionNum = Number(req.query.version);
    }

    const rawFormat = String(req.query.format || 'ieee').toLowerCase();
    if (rawFormat !== 'ieee' && rawFormat !== 'imrad') {
      throw new BadRequestError('Format must be either "ieee" or "imrad"', 'INVALID_FORMAT');
    }
    const format = rawFormat as 'ieee' | 'imrad';

    const isInline = req.query.inline === 'true' || req.query.inline === '1';

    const { filename, pdfBuffer, packageHash } = await downloadExportPdf({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
      version: versionNum,
      format,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${isInline ? 'inline' : 'attachment'}; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('ETag', `"${packageHash}"`);
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/projects/:projectId/snapshots/:snapshotId/manuscript/lineage
 * Query reverse evidence lineage: trace paragraph/sentence -> ParagraphPlan -> Finding -> Study -> SourceAnchor.
 */
exportRouter.get('/lineage', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const project = await getOwnedProject(req.user!.uid, req.params.projectId);
    const items = await queryLineage({
      projectId: project.id,
      snapshotId: req.params.snapshotId,
      sectionKey: req.query.sectionKey ? String(req.query.sectionKey) : undefined,
      evidenceId: req.query.evidenceId ? String(req.query.evidenceId) : undefined,
      findingId: req.query.findingId ? String(req.query.findingId) : undefined,
      sentence: req.query.sentence ? String(req.query.sentence) : undefined,
    });

    return res.status(200).json({
      success: true,
      data: {
        lineage: items,
        count: items.length,
      },
    });
  } catch (error) {
    return next(error);
  }
});

export default exportRouter;

