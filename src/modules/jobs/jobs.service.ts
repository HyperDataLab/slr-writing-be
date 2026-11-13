import { randomUUID } from 'node:crypto';
import { NotFoundError, BadRequestError } from '../../shared/errors/app-error.js';
import type {
  CreateJobInput,
  JobListFilter,
  JobRecord,
  JobStatus,
  JobUpdater,
} from './jobs.types.js';

class JobsService {
  private jobs = new Map<string, JobRecord>();
  private readonly defaultTtlMs = 60 * 60 * 1000; // 1 hour

  createJob<TResult = unknown>(input: CreateJobInput): JobRecord<TResult> {
    this.evictExpiredJobs();
    const id = `job_${randomUUID().replace(/-/g, '')}`;
    const record: JobRecord<TResult> = {
      id,
      type: input.type,
      status: 'pending',
      userId: input.userId,
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      progress: 0,
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
    };
    this.jobs.set(id, record as JobRecord);
    return record;
  }

  getJob<TResult = unknown>(jobId: string, userId: string): JobRecord<TResult> {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) {
      throw new NotFoundError('Job not found', 'JOB_NOT_FOUND');
    }
    return job as JobRecord<TResult>;
  }

  listJobs(userId: string, filter: JobListFilter = {}) {
    this.evictExpiredJobs();
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));

    let items = Array.from(this.jobs.values()).filter((j) => j.userId === userId);

    if (filter.status) {
      items = items.filter((j) => j.status === filter.status);
    }
    if (filter.type) {
      items = items.filter((j) => j.type === filter.type);
    }
    if (filter.projectId) {
      items = items.filter((j) => j.projectId === filter.projectId);
    }
    if (filter.snapshotId) {
      items = items.filter((j) => j.snapshotId === filter.snapshotId);
    }

    // Sort newest first
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = items.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const start = (page - 1) * limit;
    const paginatedItems = items.slice(start, start + limit);

    return {
      items: paginatedItems,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  startJob(jobId: string, step?: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError('Job not found', 'JOB_NOT_FOUND');
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    if (step) job.step = step;
    return job;
  }

  updateProgress(jobId: string, progress: number, step?: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError('Job not found', 'JOB_NOT_FOUND');
    if (job.status === 'cancelled') return job;
    job.progress = Math.max(0, Math.min(100, Math.round(progress)));
    if (step) job.step = step;
    return job;
  }

  completeJob<TResult>(jobId: string, result?: TResult): JobRecord<TResult> {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError('Job not found', 'JOB_NOT_FOUND');
    if (job.status === 'cancelled') return job as JobRecord<TResult>;
    job.status = 'completed';
    job.progress = 100;
    job.result = result;
    job.completedAt = new Date().toISOString();
    return job as JobRecord<TResult>;
  }

  failJob(jobId: string, error: { code?: string; message: string; details?: unknown }): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError('Job not found', 'JOB_NOT_FOUND');
    if (job.status === 'cancelled') return job;
    job.status = 'failed';
    job.error = {
      code: error.code ?? 'JOB_EXECUTION_FAILED',
      message: error.message,
      details: error.details,
    };
    job.completedAt = new Date().toISOString();
    return job;
  }

  cancelJob(jobId: string, userId: string): JobRecord {
    const job = this.getJob(jobId, userId);
    if (job.status === 'completed' || job.status === 'failed') {
      throw new BadRequestError(`Cannot cancel a job that is already ${job.status}`, 'JOB_NOT_CANCELLABLE');
    }
    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    return job;
  }

  /**
   * Runs an asynchronous task function with progress tracking.
   * If taskFn succeeds, marks job completed.
   * If taskFn throws, marks job failed.
   */
  async runJob<TResult>(
    input: CreateJobInput,
    taskFn: (updater: JobUpdater) => Promise<TResult>,
  ): Promise<JobRecord<TResult>> {
    const job = this.createJob<TResult>(input);
    this.startJob(job.id);

    const updater: JobUpdater = {
      setProgress: (progress: number, step?: string) => this.updateProgress(job.id, progress, step),
      setStep: (step: string) => {
        const current = this.jobs.get(job.id);
        if (current) current.step = step;
      },
      isCancelled: () => this.jobs.get(job.id)?.status === 'cancelled',
    };

    // Execute in background
    Promise.resolve()
      .then(async () => {
        try {
          const result = await taskFn(updater);
          if (this.jobs.get(job.id)?.status !== 'cancelled') {
            this.completeJob(job.id, result);
          }
        } catch (err: unknown) {
          if (this.jobs.get(job.id)?.status !== 'cancelled') {
            const message = err instanceof Error ? err.message : 'Unknown job failure';
            const code = (err as { code?: string })?.code ?? 'JOB_FAILED';
            this.failJob(job.id, { code, message });
          }
        }
      })
      .catch(() => {
        // Prevent unhandled promise rejection
      });

    return job;
  }

  evictExpiredJobs(ttlMs = this.defaultTtlMs): number {
    const now = Date.now();
    let count = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (job.completedAt) {
        const finishedAt = new Date(job.completedAt).getTime();
        if (now - finishedAt > ttlMs) {
          this.jobs.delete(id);
          count++;
        }
      }
    }
    return count;
  }

  clearAllJobs(): void {
    this.jobs.clear();
  }
}

export const jobsService = new JobsService();

