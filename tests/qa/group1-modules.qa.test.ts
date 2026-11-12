import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { evidenceListQuerySchema } from '../../src/modules/evidence/evidence.schemas.js';
import { jobListQuerySchema, jobStatusSchema } from '../../src/modules/jobs/jobs.schemas.js';
import { jobsService } from '../../src/modules/jobs/jobs.service.js';
import { FakeSlrBe } from '../slr-client/fake-slr-be.js';

const app = createApp();
const fakeSlr = new FakeSlrBe();
const as = (uid: string, token?: string) => ({
  'X-Dev-User-Id': uid,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

let originalBaseUrl: string;

beforeAll(async () => {
  await fakeSlr.start();
  originalBaseUrl = env.SLR_API_BASE_URL;
  env.SLR_API_BASE_URL = fakeSlr.baseUrl;
});

afterAll(async () => {
  env.SLR_API_BASE_URL = originalBaseUrl;
  await fakeSlr.stop();
});

beforeEach(() => {
  jobsService.clearAllJobs();
  fakeSlr.reset();
});

afterEach(() => {
  env.DEV_AUTH_ENABLED = true;
});

// ============================================================================
// SUITE 1: Jobs Service & API Adversarial Testing
// ============================================================================
describe('QA: Jobs Service & API Lifecycle and Ownership Isolation', () => {
  const alice = 'qa-user-alice';
  const bob = 'qa-user-bob';
  const charlie = 'qa-user-charlie';

  describe('Service: Lifecycle & State Transitions', () => {
    it('creates job with correct defaults and metadata', () => {
      const job = jobsService.createJob({
        type: 'draft_section',
        userId: alice,
        projectId: 'project-alpha',
        snapshotId: 'snap-001',
        metadata: { targetWords: 1500, style: 'ieee' },
      });

      expect(job.id).toMatch(/^job_[a-f0-9]{32}$/);
      expect(job.type).toBe('draft_section');
      expect(job.status).toBe('pending');
      expect(job.userId).toBe(alice);
      expect(job.projectId).toBe('project-alpha');
      expect(job.snapshotId).toBe('snap-001');
      expect(job.progress).toBe(0);
      expect(job.createdAt).toBeDefined();
      expect(job.startedAt).toBeUndefined();
      expect(job.completedAt).toBeUndefined();
      expect(job.metadata).toEqual({ targetWords: 1500, style: 'ieee' });
    });

    it('handles startJob transitions and step setting', () => {
      const job = jobsService.createJob({ type: 'verify_gates', userId: alice });
      const started = jobsService.startJob(job.id, 'Initializing G1-G6');

      expect(started.status).toBe('running');
      expect(started.step).toBe('Initializing G1-G6');
      expect(started.startedAt).toBeDefined();

      // Throws on unknown jobId
      expect(() => jobsService.startJob('job_nonexistent')).toThrowError('Job not found');
    });

    it('clamps progress strictly between 0 and 100 with rounding', () => {
      const job = jobsService.createJob({ type: 'export_package', userId: alice });

      jobsService.updateProgress(job.id, 42.7, 'Formatting LaTeX');
      expect(job.progress).toBe(43);
      expect(job.step).toBe('Formatting LaTeX');

      // Clamping negative to 0
      jobsService.updateProgress(job.id, -99);
      expect(job.progress).toBe(0);

      // Clamping > 100 to 100
      jobsService.updateProgress(job.id, 250);
      expect(job.progress).toBe(100);

      // Throws on unknown job
      expect(() => jobsService.updateProgress('job_unknown', 50)).toThrowError('Job not found');
    });

    it('completes job with result and sets progress to 100', () => {
      const job = jobsService.createJob<{ manifestHash: string }>({ type: 'export_package', userId: alice });
      const completed = jobsService.completeJob(job.id, { manifestHash: 'sha256-abc' });

      expect(completed.status).toBe('completed');
      expect(completed.progress).toBe(100);
      expect(completed.result).toEqual({ manifestHash: 'sha256-abc' });
      expect(completed.completedAt).toBeDefined();

      // Throws on unknown job
      expect(() => jobsService.completeJob('job_unknown')).toThrowError('Job not found');
    });

    it('fails job with structured error code, message and details', () => {
      const job = jobsService.createJob({ type: 'draft_section', userId: alice });
      const failed = jobsService.failJob(job.id, {
        code: 'LLM_PACE_EXCEEDED',
        message: 'Rate limit pacing timed out after 3 retries',
        details: { attempts: 3, delayMs: 45000 },
      });

      expect(failed.status).toBe('failed');
      expect(failed.error).toEqual({
        code: 'LLM_PACE_EXCEEDED',
        message: 'Rate limit pacing timed out after 3 retries',
        details: { attempts: 3, delayMs: 45000 },
      });
      expect(failed.completedAt).toBeDefined();

      // Default error code when omitted
      const job2 = jobsService.createJob({ type: 'generic', userId: alice });
      jobsService.failJob(job2.id, { message: 'Unexpected crash' });
      expect(job2.error?.code).toBe('JOB_EXECUTION_FAILED');

      // Throws on unknown job
      expect(() => jobsService.failJob('job_unknown', { message: 'err' })).toThrowError('Job not found');
    });

    it('cancels pending and running jobs, but refuses completed or failed jobs', () => {
      // Cancel pending
      const pendingJob = jobsService.createJob({ type: 'generic', userId: alice });
      const cancelledPending = jobsService.cancelJob(pendingJob.id, alice);
      expect(cancelledPending.status).toBe('cancelled');
      expect(cancelledPending.completedAt).toBeDefined();

      // Cancel running
      const runningJob = jobsService.createJob({ type: 'generic', userId: alice });
      jobsService.startJob(runningJob.id);
      const cancelledRunning = jobsService.cancelJob(runningJob.id, alice);
      expect(cancelledRunning.status).toBe('cancelled');

      // Refuses completed
      const compJob = jobsService.createJob({ type: 'generic', userId: alice });
      jobsService.completeJob(compJob.id);
      expect(() => jobsService.cancelJob(compJob.id, alice)).toThrowError(/Cannot cancel a job that is already completed/);

      // Refuses failed
      const failedJob = jobsService.createJob({ type: 'generic', userId: alice });
      jobsService.failJob(failedJob.id, { message: 'Failed' });
      expect(() => jobsService.cancelJob(failedJob.id, alice)).toThrowError(/Cannot cancel a job that is already failed/);
    });

    it('cancelled job ignores subsequent progress updates, completion, or failure', () => {
      const job = jobsService.createJob({ type: 'draft_section', userId: alice });
      jobsService.startJob(job.id);
      jobsService.cancelJob(job.id, alice);

      expect(job.status).toBe('cancelled');

      // Attempting to update progress on cancelled job does not alter cancelled status
      jobsService.updateProgress(job.id, 80, 'Late progress');
      expect(job.status).toBe('cancelled');

      // Attempting to complete on cancelled job does not alter cancelled status
      jobsService.completeJob(job.id, { output: 'ignored' });
      expect(job.status).toBe('cancelled');
      expect(job.result).toBeUndefined();

      // Attempting to fail on cancelled job does not alter cancelled status
      jobsService.failJob(job.id, { message: 'Late failure' });
      expect(job.status).toBe('cancelled');
      expect(job.error).toBeUndefined();
    });

    it('runJob runs an asynchronous task with updater, respects cancellation and handles errors', async () => {
      // 1. Successful execution
      const job1 = await jobsService.runJob(
        { type: 'sync_snapshot', userId: alice },
        async (updater) => {
          updater.setProgress(20, 'Fetching A1');
          expect(updater.isCancelled()).toBe(false);
          updater.setStep('Fetching A10');
          updater.setProgress(70);
          return { importedArtifacts: 4 };
        },
      );

      await new Promise((r) => setTimeout(r, 60));
      const finished1 = jobsService.getJob<{ importedArtifacts: number }>(job1.id, alice);
      expect(finished1.status).toBe('completed');
      expect(finished1.progress).toBe(100);
      expect(finished1.result).toEqual({ importedArtifacts: 4 });

      // 2. Errored execution
      const job2 = await jobsService.runJob(
        { type: 'sync_snapshot', userId: alice },
        async () => {
          const err = new Error('Upstream timeout');
          (err as any).code = 'SLR_TIMEOUT';
          throw err;
        },
      );

      await new Promise((r) => setTimeout(r, 60));
      const finished2 = jobsService.getJob(job2.id, alice);
      expect(finished2.status).toBe('failed');
      expect(finished2.error?.code).toBe('SLR_TIMEOUT');
      expect(finished2.error?.message).toBe('Upstream timeout');

      // 3. Early cancellation before task finishes
      let cancelledInTask = false;
      const job3 = await jobsService.runJob(
        { type: 'sync_snapshot', userId: alice },
        async (updater) => {
          updater.setProgress(10, 'Step 1');
          await new Promise((r) => setTimeout(r, 50));
          cancelledInTask = updater.isCancelled();
          return { done: true };
        },
      );

      // Cancel immediately
      jobsService.cancelJob(job3.id, alice);
      await new Promise((r) => setTimeout(r, 80));

      expect(cancelledInTask).toBe(true);
      const finished3 = jobsService.getJob(job3.id, alice);
      expect(finished3.status).toBe('cancelled');
      expect(finished3.result).toBeUndefined();
    });
  });

  describe('Service: User Isolation & TTL Cleanup', () => {
    it('enforces strict cross-user isolation: User B cannot access or cancel User A jobs', () => {
      const aliceJob = jobsService.createJob({ type: 'draft_section', userId: alice, projectId: 'proj-secret' });

      // Alice can read
      expect(jobsService.getJob(aliceJob.id, alice).id).toBe(aliceJob.id);

      // Bob cannot read (throws JOB_NOT_FOUND to prevent probing)
      expect(() => jobsService.getJob(aliceJob.id, bob)).toThrowError('Job not found');

      // Bob cannot cancel Alice's job
      expect(() => jobsService.cancelJob(aliceJob.id, bob)).toThrowError('Job not found');
      expect(aliceJob.status).toBe('pending');

      // Bob's list does not contain Alice's job
      const bobJobs = jobsService.listJobs(bob);
      expect(bobJobs.items).toHaveLength(0);
      expect(bobJobs.pagination.total).toBe(0);
    });

    it('TTL eviction cleans only expired finished jobs, keeping active and fresh jobs', () => {
      const now = Date.now();

      // Create all jobs first before aging them
      const pendingJob = jobsService.createJob({ type: 'generic', userId: alice });
      const runningJob = jobsService.createJob({ type: 'generic', userId: alice });
      jobsService.startJob(runningJob.id);

      const recentJob = jobsService.createJob({ type: 'generic', userId: alice });
      jobsService.completeJob(recentJob.id);

      const oldCompletedJob = jobsService.createJob({ type: 'generic', userId: alice });
      jobsService.completeJob(oldCompletedJob.id);

      const oldFailedJob = jobsService.createJob({ type: 'generic', userId: alice });
      jobsService.failJob(oldFailedJob.id, { message: 'Boom' });

      const oldCancelledJob = jobsService.createJob({ type: 'generic', userId: alice });
      jobsService.cancelJob(oldCancelledJob.id, alice);

      // Now set ages:
      // 1. Active pending job: should NOT be evicted regardless of age
      pendingJob.createdAt = new Date(now - 10 * 3600 * 1000).toISOString();

      // 2. Active running job: should NOT be evicted
      runningJob.startedAt = new Date(now - 10 * 3600 * 1000).toISOString();

      // 3. Recently completed job (5 min ago): should NOT be evicted
      recentJob.completedAt = new Date(now - 5 * 60 * 1000).toISOString();

      // 4. Old completed job (2 hours old, TTL = 1 hour): SHOULD be evicted
      oldCompletedJob.completedAt = new Date(now - 2 * 3600 * 1000).toISOString();

      // 5. Old failed job (3 hours old): SHOULD be evicted
      oldFailedJob.completedAt = new Date(now - 3 * 3600 * 1000).toISOString();

      // 6. Old cancelled job (4 hours old): SHOULD be evicted
      oldCancelledJob.completedAt = new Date(now - 4 * 3600 * 1000).toISOString();

      const evictedCount = jobsService.evictExpiredJobs(3600 * 1000); // 1 hour TTL
      expect(evictedCount).toBe(3);

      // Verify survivors
      expect(jobsService.getJob(pendingJob.id, alice).id).toBe(pendingJob.id);
      expect(jobsService.getJob(runningJob.id, alice).id).toBe(runningJob.id);
      expect(jobsService.getJob(recentJob.id, alice).id).toBe(recentJob.id);

      // Verify evicted ones are gone
      expect(() => jobsService.getJob(oldCompletedJob.id, alice)).toThrowError('Job not found');
      expect(() => jobsService.getJob(oldFailedJob.id, alice)).toThrowError('Job not found');
      expect(() => jobsService.getJob(oldCancelledJob.id, alice)).toThrowError('Job not found');

      // Test automatic eviction during createJob
      const anotherOldJob = jobsService.createJob({ type: 'generic', userId: alice });
      jobsService.completeJob(anotherOldJob.id);
      anotherOldJob.completedAt = new Date(now - 2 * 3600 * 1000).toISOString();

      // Creating a new job triggers auto-eviction
      const triggerJob = jobsService.createJob({ type: 'generic', userId: alice });
      expect(triggerJob.id).toBeDefined();
      expect(() => jobsService.getJob(anotherOldJob.id, alice)).toThrowError('Job not found');
    });

    it('paginates and sorts newest first correctly across multiple filters', () => {
      // Create 25 jobs for Alice with varying dates
      const baseTime = Date.now();
      for (let i = 0; i < 25; i++) {
        const j = jobsService.createJob({
          type: i % 2 === 0 ? 'draft_section' : 'verify_gates',
          userId: alice,
          projectId: i < 10 ? 'proj-A' : 'proj-B',
          snapshotId: i === 0 ? 'snap-target' : undefined,
        });
        // Deterministic createdAt sequence
        j.createdAt = new Date(baseTime + i * 1000).toISOString();
        if (i % 3 === 0) jobsService.completeJob(j.id);
      }

      // Page 1 with limit 10
      const p1 = jobsService.listJobs(alice, { page: 1, limit: 10 });
      expect(p1.items).toHaveLength(10);
      expect(p1.pagination.total).toBe(25);
      expect(p1.pagination.totalPages).toBe(3);
      expect(p1.pagination.page).toBe(1);
      expect(p1.pagination.limit).toBe(10);

      // Confirm newest is first
      const time0 = new Date(p1.items[0].createdAt).getTime();
      const time1 = new Date(p1.items[1].createdAt).getTime();
      expect(time0).toBeGreaterThanOrEqual(time1);

      // Page 3 with limit 10
      const p3 = jobsService.listJobs(alice, { page: 3, limit: 10 });
      expect(p3.items).toHaveLength(5);

      // Filter by projectId
      const projA = jobsService.listJobs(alice, { projectId: 'proj-A' });
      expect(projA.pagination.total).toBe(10);

      // Filter by snapshotId
      const snapTarget = jobsService.listJobs(alice, { snapshotId: 'snap-target' });
      expect(snapTarget.pagination.total).toBe(1);
      expect(snapTarget.items[0].snapshotId).toBe('snap-target');

      // Filter by status completed
      const completed = jobsService.listJobs(alice, { status: 'completed' });
      expect(completed.items.every((j) => j.status === 'completed')).toBe(true);
    });
  });

  describe('API: HTTP Endpoints & Adversarial Security', () => {
    it('requires authentication for all /api/jobs endpoints', async () => {
      env.DEV_AUTH_ENABLED = false;

      const listRes = await request(app).get('/api/jobs');
      expect(listRes.status).toBe(401);
      expect(listRes.body.error.code).toBe('UNAUTHORIZED');

      const getRes = await request(app).get('/api/jobs/job_123');
      expect(getRes.status).toBe(401);
      expect(getRes.body.error.code).toBe('UNAUTHORIZED');

      const cancelRes = await request(app).post('/api/jobs/job_123/cancel');
      expect(cancelRes.status).toBe(401);
      expect(cancelRes.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects malicious jobId parameter (path traversal, surrogates, NUL byte, length > 200)', async () => {
      // guardIdParam guards jobId
      const resNul = await request(app).get('/api/jobs/job%00bad').set(as(alice));
      expect(resNul.status).toBe(404);
      expect(resNul.body.error.code).toBe('JOB_NOT_FOUND');

      const tooLongId = 'j'.repeat(201);
      const resTooLong = await request(app).get(`/api/jobs/${tooLongId}`).set(as(alice));
      expect(resTooLong.status).toBe(404);
      expect(resTooLong.body.error.code).toBe('JOB_NOT_FOUND');
    });

    it('validates query parameters strictly with 400 VALIDATION_ERROR', async () => {
      // 1. Invalid status
      const resBadStatus = await request(app).get('/api/jobs?status=resurrected').set(as(alice));
      expect(resBadStatus.status).toBe(400);
      expect(resBadStatus.body.error.code).toBe('VALIDATION_ERROR');

      // 2. Negative page
      const resNegPage = await request(app).get('/api/jobs?page=-1').set(as(alice));
      expect(resNegPage.status).toBe(400);
      expect(resNegPage.body.error.code).toBe('VALIDATION_ERROR');

      // 3. Page = 0
      const resZeroPage = await request(app).get('/api/jobs?page=0').set(as(alice));
      expect(resZeroPage.status).toBe(400);
      expect(resZeroPage.body.error.code).toBe('VALIDATION_ERROR');

      // 4. Excessive limit (> 100)
      const resLimit101 = await request(app).get('/api/jobs?limit=101').set(as(alice));
      expect(resLimit101.status).toBe(400);
      expect(resLimit101.body.error.code).toBe('VALIDATION_ERROR');

      // 5. Unstorable text in type
      const resUnstorable = await request(app).get('/api/jobs?type=bad%00text').set(as(alice));
      expect(resUnstorable.status).toBe(400);
      expect(resUnstorable.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('prevents cross-user data leakage and horizontal privilege escalation', async () => {
      const aliceJob = jobsService.createJob({ type: 'draft_section', userId: alice });

      // Bob tries to view Alice's job
      const getRes = await request(app).get(`/api/jobs/${aliceJob.id}`).set(as(bob));
      expect(getRes.status).toBe(404);
      expect(getRes.body.error.code).toBe('JOB_NOT_FOUND');

      // Bob tries to cancel Alice's job
      const cancelRes = await request(app).post(`/api/jobs/${aliceJob.id}/cancel`).set(as(bob));
      expect(cancelRes.status).toBe(404);
      expect(cancelRes.body.error.code).toBe('JOB_NOT_FOUND');
      expect(jobsService.getJob(aliceJob.id, alice).status).toBe('pending');

      // Charlie's job listing shows 0 jobs
      const charlieRes = await request(app).get('/api/jobs').set(as(charlie));
      expect(charlieRes.status).toBe(200);
      expect(charlieRes.body.data.items).toHaveLength(0);
      expect(charlieRes.body.data.pagination.total).toBe(0);
    });

    it('cancels job successfully via API and returns 400 when attempting to cancel completed job', async () => {
      const job = jobsService.createJob({ type: 'export_package', userId: alice });

      const cancelRes = await request(app).post(`/api/jobs/${job.id}/cancel`).set(as(alice));
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('cancelled');

      const completedJob = jobsService.createJob({ type: 'export_package', userId: alice });
      jobsService.completeJob(completedJob.id);

      const cancelCompletedRes = await request(app).post(`/api/jobs/${completedJob.id}/cancel`).set(as(alice));
      expect(cancelCompletedRes.status).toBe(400);
      expect(cancelCompletedRes.body.error.code).toBe('JOB_NOT_CANCELLABLE');
    });
  });
});

// ============================================================================
// SUITE 2: Evidence Schemas Adversarial Testing
// ============================================================================
describe('QA: Evidence Schemas Adversarial Boundary Testing', () => {
  it('accepts empty query and applies defaults (page=1, limit=50, verified=undefined)', () => {
    const res = evidenceListQuerySchema.safeParse({ query: {} });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.query.page).toBe(1);
    expect(res.data.query.limit).toBe(50);
    expect(res.data.query.verified).toBeUndefined();
    expect(res.data.query.search).toBeUndefined();
    expect(res.data.query.studyId).toBeUndefined();
    expect(res.data.query.claimId).toBeUndefined();
  });

  describe('Page Boundaries', () => {
    it.each([
      ['0', false],
      ['-1', false],
      ['-999', false],
      ['1.5', false],
      ['not_a_number', false],
      ['1', true],
      ['50', true],
      ['10000', true],
    ])('evaluates page=%s with success=%s', (pageVal, expectedSuccess) => {
      const parsed = evidenceListQuerySchema.safeParse({ query: { page: pageVal } });
      expect(parsed.success).toBe(expectedSuccess);
      if (parsed.success) {
        expect(parsed.data.query.page).toBe(Number(pageVal));
      }
    });
  });

  describe('Limit Boundaries', () => {
    it.each([
      ['0', false],
      ['-5', false],
      ['201', false],
      ['9999', false],
      ['1', true],
      ['50', true],
      ['199', true],
      ['200', true],
    ])('evaluates limit=%s with success=%s', (limitVal, expectedSuccess) => {
      const parsed = evidenceListQuerySchema.safeParse({ query: { limit: limitVal } });
      expect(parsed.success).toBe(expectedSuccess);
      if (parsed.success) {
        expect(parsed.data.query.limit).toBe(Number(limitVal));
      }
    });
  });

  describe('Verified Boolean Transform', () => {
    it('transforms "true" to boolean true', () => {
      const parsed = evidenceListQuerySchema.safeParse({ query: { verified: 'true' } });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.query.verified).toBe(true);
    });

    it('transforms "false" to boolean false', () => {
      const parsed = evidenceListQuerySchema.safeParse({ query: { verified: 'false' } });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.query.verified).toBe(false);
    });

    it.each([
      '1', '0', 'yes', 'no', 'TRUE', 'FALSE', 'True', 'False', 'undefined', 'null', '', 'maybe',
    ])('rejects non-enum verified value: %j', (val) => {
      const parsed = evidenceListQuerySchema.safeParse({ query: { verified: val } });
      expect(parsed.success).toBe(false);
    });
  });

  describe('Search & Filter Text Unstorable Characters & Length Constraints', () => {
    it.each([
      'test\u0000nullbyte',
      'lone\uD800surrogate',
      'lone\uDFFFsurrogate',
      'mixed\u0000\uD83D\uDE00',
    ])('rejects unstorable characters in search: %j', (searchVal) => {
      const parsed = evidenceListQuerySchema.safeParse({ query: { search: searchVal } });
      expect(parsed.success).toBe(false);
    });

    it('rejects search string exceeding 200 characters', () => {
      const tooLong = 'a'.repeat(201);
      const parsed = evidenceListQuerySchema.safeParse({ query: { search: tooLong } });
      expect(parsed.success).toBe(false);

      const maxAllowed = 'a'.repeat(200);
      const parsedAllowed = evidenceListQuerySchema.safeParse({ query: { search: maxAllowed } });
      expect(parsedAllowed.success).toBe(true);
    });

    it('accepts legitimate search text with spaces, punctuation, numbers, and emojis', () => {
      const validSearch = 'Deep Learning & NLP in 2026: (Review - Part 1) 🚀';
      const parsed = evidenceListQuerySchema.safeParse({ query: { search: validSearch } });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.query.search).toBe(validSearch);
    });

    it('rejects studyId and claimId exceeding 200 characters', () => {
      const tooLong = 'id_'.repeat(70);
      expect(evidenceListQuerySchema.safeParse({ query: { studyId: tooLong } }).success).toBe(false);
      expect(evidenceListQuerySchema.safeParse({ query: { claimId: tooLong } }).success).toBe(false);
    });
  });
});

// ============================================================================
// SUITE 3: SLR Discovery API Adversarial Testing
// ============================================================================
describe('QA: SLR Discovery API Upstream Integration & Security', () => {
  const alice = 'alice-researcher';
  const aliceToken = 'slr-token-alice-xyz';

  describe('Authentication Enforcement', () => {
    it('returns 401 UNAUTHORIZED for unauthenticated /api/slr/projects', async () => {
      env.DEV_AUTH_ENABLED = false;
      const res = await request(app).get('/api/slr/projects');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 UNAUTHORIZED for unauthenticated /api/slr/projects/:projectId/runs', async () => {
      env.DEV_AUTH_ENABLED = false;
      const res = await request(app).get('/api/slr/projects/proj-001/runs');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Token Forwarding & Upstream Communication', () => {
    it('forwards the caller’s Authorization header as-is to slr-be for projects', async () => {
      fakeSlr.json('/api/projects', {
        success: true,
        data: {
          items: [{ id: 'p1', name: 'Systematic Literature Review 2026' }],
          pageNumber: 1,
          pageSize: 25,
          totalCount: 1,
          totalPages: 1,
        },
      });

      const res = await request(app)
        .get('/api/slr/projects?search=Literature&pageNumber=1&pageSize=25')
        .set(as(alice, aliceToken));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);

      // Verify token forwarding
      expect(fakeSlr.requests).toHaveLength(1);
      expect(fakeSlr.requests[0].authorization).toBe(`Bearer ${aliceToken}`);
    });

    it('forwards the caller’s Authorization header to slr-be for project runs', async () => {
      fakeSlr.json('/api/projects/proj-123/synthesis/artifacts/runs', {
        success: true,
        data: [
          {
            run_id: 'run-20261101-abc',
            generated_at: '2026-11-01T12:00:00Z',
            generated_by: 'leader',
            corpus_hash: 'hash-xyz',
            artifacts: [{ artifact_type: 'A1', review_status: 'approved', validation_status: 'valid' }],
          },
        ],
      });

      const res = await request(app)
        .get('/api/slr/projects/proj-123/runs')
        .set(as(alice, aliceToken));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].run_id).toBe('run-20261101-abc');

      expect(fakeSlr.requests).toHaveLength(1);
      expect(fakeSlr.requests[0].authorization).toBe(`Bearer ${aliceToken}`);
    });
  });

  describe('Upstream Error Code Mapping', () => {
    it('maps upstream 404 to 404 SLR_NOT_FOUND', async () => {
      fakeSlr.json(
        '/api/projects/proj-missing/synthesis/artifacts/runs',
        { success: false, error: { message: 'Not found' } },
        404,
      );

      const res = await request(app)
        .get('/api/slr/projects/proj-missing/runs')
        .set(as(alice, aliceToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SLR_NOT_FOUND');
    });

    it('maps upstream 401 to 401 SLR_AUTH_REJECTED', async () => {
      fakeSlr.json(
        '/api/projects/proj-123/synthesis/artifacts/runs',
        { success: false, error: { message: 'Token expired' } },
        401,
      );

      const res = await request(app)
        .get('/api/slr/projects/proj-123/runs')
        .set(as(alice, 'expired-token'));

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SLR_AUTH_REJECTED');
    });

    it('maps upstream 403 to 403 SLR_FORBIDDEN', async () => {
      fakeSlr.json(
        '/api/projects/proj-private/synthesis/artifacts/runs',
        { success: false, error: { message: 'Forbidden' } },
        403,
      );

      const res = await request(app)
        .get('/api/slr/projects/proj-private/runs')
        .set(as(alice, aliceToken));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SLR_FORBIDDEN');
    });

    it('maps upstream 500/502 to 502 SLR_UPSTREAM_ERROR', async () => {
      fakeSlr.json(
        '/api/projects/proj-broken/synthesis/artifacts/runs',
        { success: false, error: { message: 'Internal upstream error' } },
        500,
      );

      const res = await request(app)
        .get('/api/slr/projects/proj-broken/runs')
        .set(as(alice, aliceToken));

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('SLR_UPSTREAM_ERROR');
    });
  });

  describe('Adversarial Input Validation & Guarding', () => {
    it('blocks unstorable text in search with 400 VALIDATION_ERROR', async () => {
      const resNul = await request(app)
        .get('/api/slr/projects?search=query%00injection')
        .set(as(alice));
      expect(resNul.status).toBe(400);
      expect(resNul.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('blocks invalid pageNumber or pageSize with 400 VALIDATION_ERROR', async () => {
      // pageNumber = 0
      const resZeroPage = await request(app)
        .get('/api/slr/projects?pageNumber=0')
        .set(as(alice));
      expect(resZeroPage.status).toBe(400);
      expect(resZeroPage.body.error.code).toBe('VALIDATION_ERROR');

      // pageSize > 100
      const resExcessPageSize = await request(app)
        .get('/api/slr/projects?pageSize=101')
        .set(as(alice));
      expect(resExcessPageSize.status).toBe(400);
      expect(resExcessPageSize.body.error.code).toBe('VALIDATION_ERROR');

      // Negative pageNumber
      const resNegPage = await request(app)
        .get('/api/slr/projects?pageNumber=-5')
        .set(as(alice));
      expect(resNegPage.status).toBe(400);
      expect(resNegPage.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('guards projectId param against unstorable characters or excessive length', async () => {
      const resNul = await request(app)
        .get('/api/slr/projects/proj%00malicious/runs')
        .set(as(alice));
      expect(resNul.status).toBe(404);
      expect(resNul.body.error.code).toBe('SLR_NOT_FOUND');

      const tooLongProjId = 'p'.repeat(201);
      const resTooLong = await request(app)
        .get(`/api/slr/projects/${tooLongProjId}/runs`)
        .set(as(alice));
      expect(resTooLong.status).toBe(404);
      expect(resTooLong.body.error.code).toBe('SLR_NOT_FOUND');
    });
  });
});
