import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { jobsService } from '../../src/modules/jobs/jobs.service.js';

const app = createApp();
const as = (uid: string) => ({ 'X-Dev-User-Id': uid });

beforeEach(() => {
  jobsService.clearAllJobs();
});

afterEach(() => {
  env.DEV_AUTH_ENABLED = true;
});

describe('Jobs API', () => {
  it('requires authentication for listing and getting jobs', async () => {
    env.DEV_AUTH_ENABLED = false;
    const resList = await request(app).get('/api/jobs');
    expect(resList.status).toBe(401);
    expect(resList.body.error.code).toBe('UNAUTHORIZED');

    const resGet = await request(app).get('/api/jobs/job_123');
    expect(resGet.status).toBe(401);
    expect(resGet.body.error.code).toBe('UNAUTHORIZED');
  });

  it('lists jobs for the authenticated user only', async () => {
    jobsService.createJob({ type: 'draft_section', userId: 'alice', projectId: 'p1' });
    jobsService.createJob({ type: 'verify_gates', userId: 'alice', projectId: 'p2' });
    jobsService.createJob({ type: 'export_package', userId: 'bob' });

    const resAlice = await request(app).get('/api/jobs').set(as('alice'));
    expect(resAlice.status).toBe(200);
    expect(resAlice.body.success).toBe(true);
    expect(resAlice.body.data.pagination.total).toBe(2);
    expect(resAlice.body.data.items.every((j: any) => j.userId === 'alice')).toBe(true);

    const resBob = await request(app).get('/api/jobs').set(as('bob'));
    expect(resBob.status).toBe(200);
    expect(resBob.body.data.pagination.total).toBe(1);
  });

  it('filters jobs by status and type', async () => {
    const j1 = jobsService.createJob({ type: 'draft_section', userId: 'alice' });
    jobsService.completeJob(j1.id);
    jobsService.createJob({ type: 'draft_section', userId: 'alice' }); // pending

    const resCompleted = await request(app).get('/api/jobs?status=completed').set(as('alice'));
    expect(resCompleted.status).toBe(200);
    expect(resCompleted.body.data.pagination.total).toBe(1);
    expect(resCompleted.body.data.items[0].status).toBe('completed');
  });

  it('retrieves a single job by id', async () => {
    const job = jobsService.createJob({ type: 'export_package', userId: 'alice' });
    jobsService.updateProgress(job.id, 45, 'Compressing artifacts');

    const res = await request(app).get(`/api/jobs/${job.id}`).set(as('alice'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(job.id);
    expect(res.body.data.progress).toBe(45);
    expect(res.body.data.step).toBe('Compressing artifacts');
  });

  it('returns 404 when querying an unknown job or another user’s job', async () => {
    const bobJob = jobsService.createJob({ type: 'export_package', userId: 'bob' });

    const resNotFound = await request(app).get('/api/jobs/job_nonexistent').set(as('alice'));
    expect(resNotFound.status).toBe(404);
    expect(resNotFound.body.error.code).toBe('JOB_NOT_FOUND');

    const resForbidden = await request(app).get(`/api/jobs/${bobJob.id}`).set(as('alice'));
    expect(resForbidden.status).toBe(404);
    expect(resForbidden.body.error.code).toBe('JOB_NOT_FOUND');
  });

  it('cancels a pending job and prevents cancelling completed job', async () => {
    const job = jobsService.createJob({ type: 'draft_section', userId: 'alice' });

    const resCancel = await request(app).post(`/api/jobs/${job.id}/cancel`).set(as('alice'));
    expect(resCancel.status).toBe(200);
    expect(resCancel.body.data.status).toBe('cancelled');

    // Attempting to cancel already cancelled or completed
    const completedJob = jobsService.createJob({ type: 'generic', userId: 'alice' });
    jobsService.completeJob(completedJob.id);

    const resCancelCompleted = await request(app).post(`/api/jobs/${completedJob.id}/cancel`).set(as('alice'));
    expect(resCancelCompleted.status).toBe(400);
    expect(resCancelCompleted.body.error.code).toBe('JOB_NOT_CANCELLABLE');
  });
});

