import { prisma } from '../../config/prisma.js';
import { MVP_ARTIFACT_TYPES, SlrClient, type SlrRequestContext } from '../slr-client/slr-client.js';
import type { SlrRunListItem } from '../snapshots/slr-source.schemas.js';
import { getOwnedProject } from './projects.service.js';

export type MvpArtifactState = 'approved' | 'unreviewed' | 'needs_human_review' | 'rejected' | 'missing';

export interface SlrRunSummary {
  runId: string;
  generatedAt: string;
  generatedBy: string | null;
  corpusHash: string;
  /** Review state of the artifacts the writing MVP reads (A1, A2, A7, A10). `missing` when the run has none. */
  mvpArtifacts: Record<string, MvpArtifactState>;
  /** All four MVP artifacts approved on slr-be. Informational: the import's readiness check stays authoritative. */
  mvpApproved: boolean;
  /** Snapshots already imported from this run into this project. */
  snapshots: Array<{ id: string; status: string }>;
}

export function summarizeRun(run: SlrRunListItem, imported: Array<{ id: string; sourceRunId: string; status: string }>): SlrRunSummary {
  const mvpArtifacts: Record<string, MvpArtifactState> = {};
  for (const type of MVP_ARTIFACT_TYPES) {
    mvpArtifacts[type] = run.artifacts.find((artifact) => artifact.artifact_type === type)?.review_status ?? 'missing';
  }
  return {
    runId: run.run_id,
    generatedAt: run.generated_at,
    generatedBy: run.generated_by ?? null,
    corpusHash: run.corpus_hash,
    mvpArtifacts,
    mvpApproved: MVP_ARTIFACT_TYPES.every((type) => mvpArtifacts[type] === 'approved'),
    snapshots: imported.filter((snapshot) => snapshot.sourceRunId === run.run_id).map(({ id, status }) => ({ id, status })),
  };
}

/** Lists the runs of the SLR project linked to a writing project, so a person can pick one instead of typing a run id. */
export async function listSlrRuns(params: { ownerId: string; projectId: string }, ctx: SlrRequestContext): Promise<SlrRunSummary[]> {
  const project = await getOwnedProject(params.ownerId, params.projectId);
  const runs = await new SlrClient().listRuns(project.slrProjectId, ctx);
  const imported = await prisma.reviewSnapshot.findMany({
    where: { projectId: project.id },
    select: { id: true, sourceRunId: true, status: true },
  });
  return runs.map((run) => summarizeRun(run, imported));
}
