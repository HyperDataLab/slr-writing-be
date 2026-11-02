import type { Approval, Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ForbiddenError } from '../../shared/errors/app-error.js';
import { SlrClient } from '../slr-client/slr-client.js';

/**
 * Approvals are the human decisions of the workflow: H1 (outline), H2 (content), H3 (final package). They are stored
 * as an append-only list of decisions, and the state of anything that can be approved is its latest decision.
 */
export type ApprovalStage = 'H1' | 'H2' | 'H3';
export type ApprovalDecision = 'APPROVED' | 'REJECTED';
export type ApprovalStatus = 'PENDING' | ApprovalDecision;

export interface ApprovalTarget {
  manuscriptId: string;
  stage: ApprovalStage;
  targetKind: string;
  targetId: string;
}

/**
 * Only the OWNER of the SLR project on slr-be may decide. The role is asked of slr-be with the caller's own token at the
 * moment of the decision, so a person who lost the role cannot decide on an old session. Returns the role to record.
 *
 * With REQUIRE_SLR_OWNER_FOR_APPROVAL off (tests, local work without slr-be) nothing is asked and 'NOT_CHECKED' is
 * recorded, so the record never claims a role that was not verified.
 */
export async function assertSlrOwner(params: { slrProjectId: string; authorization: string | undefined }): Promise<string> {
  if (!env.REQUIRE_SLR_OWNER_FOR_APPROVAL) return 'NOT_CHECKED';
  const role = await new SlrClient().getProjectRole(params.slrProjectId, { authorization: params.authorization });
  if (role !== 'OWNER') {
    throw new ForbiddenError('Only the owner of the SLR project can approve or reject', 'APPROVAL_REQUIRES_OWNER');
  }
  return role;
}

/** The latest decision about a target, or null when nobody has decided yet. */
export const latestDecision = (tx: Prisma.TransactionClient, target: ApprovalTarget): Promise<Approval | null> =>
  tx.approval.findFirst({
    where: { manuscriptId: target.manuscriptId, stage: target.stage, targetKind: target.targetKind, targetId: target.targetId },
    // seq grows with every insert, so the last row written is the latest decision even within the same millisecond.
    orderBy: { seq: 'desc' },
  });

export const statusOf = (decision: Approval | null): ApprovalStatus =>
  decision === null ? 'PENDING' : (decision.decision as ApprovalDecision);
