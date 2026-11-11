import { Router, type Request } from 'express';
import { BadRequestError } from '../../shared/errors/app-error.js';
import type { AuthenticatedRequest } from '../../shared/types/common.types.js';
import {
  getLatestVerificationReport,
  getVerificationReportByVersion,
  runVerification,
} from './verification.service.js';

export const verificationRouter = Router({ mergeParams: true });

type Params = { projectId: string; snapshotId: string; version?: string };

function writeSseEvent(res: import('express').Response, event: string, data: unknown) {
  if (!res.destroyed && !res.writableEnded) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

/**
 * POST /api/projects/:projectId/snapshots/:snapshotId/manuscript/verification/run/stream
 * Streams the real start/completion state of each sequential quality gate, then returns the final report.
 */
verificationRouter.post('/verification/run/stream', async (req: AuthenticatedRequest & Request<Params>, res) => {
  const { projectId, snapshotId } = req.params;
  const actor = req.user!.uid;

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const keepAlive = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, 15_000);
  keepAlive.unref();

  try {
    const result = await runVerification({
      projectId,
      snapshotId,
      actor,
      onGateProgress: (progress) => writeSseEvent(res, 'progress', progress),
    });
    writeSseEvent(res, 'complete', { created: result.created, report: result.view });
  } catch (error) {
    const details = error as { message?: string; code?: string; statusCode?: number; requestId?: string };
    writeSseEvent(res, 'error', {
      message: details?.message ?? 'Verification failed.',
      code: details?.code ?? 'VERIFICATION_FAILED',
      status: details?.statusCode ?? 500,
      requestId: details?.requestId,
    });
  } finally {
    clearInterval(keepAlive);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
});

/**
 * POST /api/projects/:projectId/snapshots/:snapshotId/manuscript/verification/run
 * Executes Quality Gates G1-G7 and generates an immutable VerificationReport revision.
 */
verificationRouter.post('/verification/run', async (req: AuthenticatedRequest & Request<Params>, res, next) => {
  try {
    const { projectId, snapshotId } = req.params;
    const actor = req.user!.uid;

    const result = await runVerification({ projectId, snapshotId, actor });
    res.status(result.created ? 201 : 200).json({
      success: true,
      data: {
        created: result.created,
        report: result.view,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/projects/:projectId/snapshots/:snapshotId/manuscript/verification
 * Retrieves the latest VerificationReportView.
 */
verificationRouter.get('/verification', async (req: Request<Params>, res, next) => {
  try {
    const { projectId, snapshotId } = req.params;
    const view = await getLatestVerificationReport(projectId, snapshotId);
    res.status(200).json({
      success: true,
      data: view,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/projects/:projectId/snapshots/:snapshotId/manuscript/verification/revisions/:version
 * Retrieves a specific historical VerificationReport revision.
 */
verificationRouter.get('/verification/revisions/:version', async (req: Request<Params>, res, next) => {
  try {
    const { projectId, snapshotId, version: versionStr } = req.params;
    const version = Number.parseInt(versionStr ?? '', 10);
    if (!Number.isInteger(version) || version <= 0) {
      throw new BadRequestError('Version must be a positive integer', 'INVALID_VERSION');
    }

    const view = await getVerificationReportByVersion(projectId, snapshotId, version);
    res.status(200).json({
      success: true,
      data: view,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/projects/:projectId/snapshots/:snapshotId/manuscript/citation-manifest
 * Retrieves the CitationManifest from the latest VerificationReport.
 */
verificationRouter.get('/citation-manifest', async (req: Request<Params>, res, next) => {
  try {
    const { projectId, snapshotId } = req.params;
    const view = await getLatestVerificationReport(projectId, snapshotId);
    res.status(200).json({
      success: true,
      data: view.manifest,
    });
  } catch (error) {
    next(error);
  }
});
