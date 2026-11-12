import { describe, it, expect, beforeEach } from 'vitest';
import { jobsService } from '../../src/modules/jobs/jobs.service.js';

describe('JobsService', () => {
  const userId = 'user-1';
  const otherUserId = 'user-2';

  beforeEach(() => {
    jobsService.clearAllJobs();
  });

  it('creates and retrieves a job for the owner', () => {
    const job = jobsService.createJob({
      type: 'draft_section',
      userId,
      projectId: 'proj-1',
      metadata: { sectionKey: 'results' },
    });

    expect(job.id).toMatch(/^job_/);
    expect(job.status).toBe('pending');
    expect(job.progress).toBe(0);
    expect(job.userId).toBe(userId);
    expect(job.metadata).toEqual({ sectionKey: 'results' });

    const retrieved = jobsService.getJob(job.id, userId);
    expect(retrieved).toEqual(job);
  });

  it('rejects access from another user (fail-closed)', () => {
    const job = jobsService.createJob({
      type: 'generic',
      userId,
    });

    expect(() => jobsService.getJob(job.id, otherUserId)).toThrowError();
  });

  it('updates progress and steps', () => {
    const job = jobsService.createJob({
      type: 'verify_gates',
      userId,
    });

    jobsService.startJob(job.id, 'Starting gates');
    expect(job.status).toBe('running');
    expect(job.step).toBe('Starting gates');
    expect(job.startedAt).toBeDefined();

    jobsService.updateProgress(job.id, 50, 'Running G3');
    expect(job.progress).toBe(50);
    expect(job.step).toBe('Running G3');

    // Clamps between 0 and 100
    jobsService.updateProgress(job.id, 150);
    expect(job.progress).toBe(100);

    jobsService.updateProgress(job.id, -20);
    expect(job.progress).toBe(0);
  });

  it('completes job with result', () => {
    const job = jobsService.createJob<{ reportId: string }>({
      type: 'verify_gates',
      userId,
    });

    jobsService.completeJob(job.id, { reportId: 'rep-123' });
    expect(job.status).toBe('completed');
    expect(job.progress).toBe(100);
    expect(job.result).toEqual({ reportId: 'rep-123' });
    expect(job.completedAt).toBeDefined();
  });

  it('fails job with error details', () => {
    const job = jobsService.createJob({
      type: 'export_package',
      userId,
    });

    jobsService.failJob(job.id, {
      code: 'GATE_FAILED',
      message: 'Quality gate G1 failed',
      details: { brokenCitations: 2 },
    });

    expect(job.status).toBe('failed');
    expect(job.error).toEqual({
      code: 'GATE_FAILED',
      message: 'Quality gate G1 failed',
      details: { brokenCitations: 2 },
    });
  });

  it('cancels pending and running jobs, but refuses completed/failed', () => {
    const job1 = jobsService.createJob({ type: 'generic', userId });
    jobsService.cancelJob(job1.id, userId);
    expect(job1.status).toBe('cancelled');

    const job2 = jobsService.createJob({ type: 'generic', userId });
    jobsService.completeJob(job2.id);
    expect(() => jobsService.cancelJob(job2.id, userId)).toThrowError(/already completed/);
  });

  it('lists jobs with filters and pagination', () => {
    for (let i = 1; i <= 15; i++) {
      jobsService.createJob({
        type: i % 2 === 0 ? 'draft_section' : 'verify_gates',
        userId,
        projectId: i <= 5 ? 'proj-A' : 'proj-B',
      });
    }
    // And another user's job
    jobsService.createJob({ type: 'generic', userId: otherUserId });

    const userJobs = jobsService.listJobs(userId, { limit: 10 });
    expect(userJobs.pagination.total).toBe(15);
    expect(userJobs.items.length).toBe(10);
    expect(userJobs.pagination.totalPages).toBe(2);

    const filtered = jobsService.listJobs(userId, { projectId: 'proj-A' });
    expect(filtered.pagination.total).toBe(5);

    const typeFiltered = jobsService.listJobs(userId, { type: 'draft_section' });
    expect(typeFiltered.pagination.total).toBe(7);
  });

  it('runJob runs an asynchronous task and marks completed', async () => {
    const job = await jobsService.runJob(
      { type: 'draft_section', userId },
      async (updater) => {
        updater.setProgress(30, 'Drafting intro');
        updater.setProgress(80, 'Polishing citations');
        return { wordsCount: 500 };
      },
    );

    expect(job.id).toBeDefined();

    // Give microtask loop a tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    const finalJob = jobsService.getJob<{ wordsCount: number }>(job.id, userId);
    expect(finalJob.status).toBe('completed');
    expect(finalJob.progress).toBe(100);
    expect(finalJob.result).toEqual({ wordsCount: 500 });
  });

  it('runJob catches task errors and marks failed', async () => {
    const job = await jobsService.runJob(
      { type: 'draft_section', userId },
      async () => {
        const err = new Error('LLM rate limit exhausted');
        (err as any).code = 'LLM_RATE_LIMIT';
        throw err;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const finalJob = jobsService.getJob(job.id, userId);
    expect(finalJob.status).toBe('failed');
    expect(finalJob.error?.code).toBe('LLM_RATE_LIMIT');
    expect(finalJob.error?.message).toBe('LLM rate limit exhausted');
  });

  it('evicts expired completed jobs', () => {
    const job = jobsService.createJob({ type: 'generic', userId });
    jobsService.completeJob(job.id);

    // Artificially age the completedAt
    job.completedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const evicted = jobsService.evictExpiredJobs(3600 * 1000);
    expect(evicted).toBe(1);
    expect(() => jobsService.getJob(job.id, userId)).toThrowError();
  });
});

