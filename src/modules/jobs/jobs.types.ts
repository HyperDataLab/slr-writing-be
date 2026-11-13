export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobType =
  | 'draft_section'
  | 'verify_gates'
  | 'export_package'
  | 'sync_snapshot'
  | 'generic'
  | (string & {});

export interface JobRecord<TResult = unknown> {
  id: string;
  type: JobType;
  status: JobStatus;
  userId: string;
  projectId?: string;
  snapshotId?: string;
  progress: number;
  step?: string;
  result?: TResult;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateJobInput {
  type: JobType;
  userId: string;
  projectId?: string;
  snapshotId?: string;
  metadata?: Record<string, unknown>;
}

export interface JobUpdater {
  setProgress: (progress: number, step?: string) => void;
  setStep: (step: string) => void;
  isCancelled: () => boolean;
}

export interface JobListFilter {
  type?: string;
  status?: JobStatus;
  projectId?: string;
  snapshotId?: string;
  page?: number;
  limit?: number;
}

