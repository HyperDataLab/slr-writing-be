import { describe, expect, it, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/config/prisma.js';
import { downloadExportPdf } from '../../src/modules/export/export.service.js';

const app = createApp();
const as = (uid: string) => ({ 'X-Dev-User-Id': uid });

describe('Export PDF Service & Download Route', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('fails-closed if no export package exists for the manuscript', async () => {
    const user = `test-user-${Date.now()}`;
    const project = await prisma.project.create({
      data: { name: 'Test PDF Project', ownerId: user, slrProjectId: `slr-${Date.now()}` },
    });
    const snapshot = await prisma.reviewSnapshot.create({
      data: {
        projectId: project.id,
        sourceRunId: `run-${Date.now()}`,
        corpusVersion: '1',
        generatorVersion: '1.0.0',
        corpusHash: 'hash-123',
        integrityHash: 'int-123',
        importedBy: user,
      },
    });

    await expect(
      downloadExportPdf({
        projectId: project.id,
        snapshotId: snapshot.id,
        format: 'ieee',
      })
    ).rejects.toThrow();
  });

  it('downloads publication-grade IEEE Two-Column and IMRaD PDFs with correct headers', async () => {
    const user = `test-user-${Date.now()}`;
    const project = await prisma.project.create({
      data: { name: 'Test PDF IEEE Project', ownerId: user, slrProjectId: `slr-${Date.now()}` },
    });
    const snapshot = await prisma.reviewSnapshot.create({
      data: {
        projectId: project.id,
        sourceRunId: `run-${Date.now()}`,
        corpusVersion: '1',
        generatorVersion: '1.0.0',
        corpusHash: 'hash-ieee-123',
        integrityHash: 'int-ieee-123',
        importedBy: user,
      },
    });
    const manuscript = await prisma.manuscript.create({
      data: {
        projectId: project.id,
        snapshotId: snapshot.id,
        createdBy: user,
      },
    });
    const report = await prisma.verificationReport.create({
      data: {
        manuscriptId: manuscript.id,
        version: 1,
        status: 'PASSED',
        gates: {},
        issues: {},
        manifest: {},
        summary: {},
        runBy: user,
        runAt: new Date(),
      },
    });
    const approval = await prisma.approval.create({
      data: {
        manuscriptId: manuscript.id,
        stage: 'H3_FINAL',
        targetKind: 'manuscript_final',
        targetId: 'manuscript_final',
        targetHash: 'composite-hash-1',
        decision: 'APPROVED',
        decidedBy: user,
        slrRole: 'OWNER',
        decidedAt: new Date(),
      },
    });
    await prisma.exportPackage.create({
      data: {
        manuscriptId: manuscript.id,
        version: 1,
        h3ApprovalId: approval.id,
        verificationReportId: report.id,
        packageHash: 'sha256-mock-pkg-hash',
        manifest: [],
        bundle: {},
        exportedBy: user,
      },
    });

    // 1. Service direct call - IEEE profile
    const result = await downloadExportPdf({
      projectId: project.id,
      snapshotId: snapshot.id,
      format: 'ieee',
    });

    expect(result.filename).toMatch(/_v1_ieee_conference\.pdf$/);
    expect(result.packageHash).toBe('sha256-mock-pkg-hash');
    expect(Buffer.isBuffer(result.pdfBuffer)).toBe(true);
    // PDF Magic bytes %PDF- (0x25, 0x50, 0x44, 0x46)
    expect(result.pdfBuffer.subarray(0, 4)).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));

    // 2. HTTP GET /download-pdf endpoint (attachment by default)
    const httpRes = await request(app)
      .get(`/api/projects/${project.id}/snapshots/${snapshot.id}/manuscript/export/download-pdf?format=ieee`)
      .set(as(user));

    expect(httpRes.status).toBe(200);
    expect(httpRes.headers['content-type']).toBe('application/pdf');
    expect(httpRes.headers['content-disposition']).toMatch(/attachment; filename=.*ieee_conference\.pdf/);
    expect(httpRes.headers['etag']).toBe('"sha256-mock-pkg-hash"');

    // 3. HTTP GET with inline=1 and format=imrad
    const inlineRes = await request(app)
      .get(`/api/projects/${project.id}/snapshots/${snapshot.id}/manuscript/export/download-pdf?format=imrad&inline=1`)
      .set(as(user));

    expect(inlineRes.status).toBe(200);
    expect(inlineRes.headers['content-type']).toBe('application/pdf');
    expect(inlineRes.headers['content-disposition']).toMatch(/inline; filename=.*imrad_preprint\.pdf/);

    // 4. HTTP GET with invalid format
    const invalidRes = await request(app)
      .get(`/api/projects/${project.id}/snapshots/${snapshot.id}/manuscript/export/download-pdf?format=invalid_fmt`)
      .set(as(user));

    expect(invalidRes.status).toBe(400);
    expect(invalidRes.body.error?.code).toBe('INVALID_FORMAT');
  });
});
