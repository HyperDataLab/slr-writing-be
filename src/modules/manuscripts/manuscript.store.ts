import { Prisma, type Manuscript } from '../../generated/prisma/client.js';
import { runExclusive } from '../../shared/utils/keyed-mutex.js';

/**
 * Shared by everything that writes to the manuscript of a snapshot (Methods, the blueprint, their approvals).
 * All of these writers take the same lock, so the manuscript row is created once and versions are numbered without gaps.
 */

// Writers wait a long time when a burst of requests hits one snapshot, so the transaction is given room for that.
export const WRITE_TRANSACTION_OPTIONS = { timeout: 60_000, maxWait: 60_000 };

const lockKey = (snapshotId: string) => `manuscript:${snapshotId}`;

/** One writer at a time for a snapshot: queue in memory first (holding no connection), then take the database lock. */
export const exclusiveForSnapshot = <T>(snapshotId: string, work: () => Promise<T>): Promise<T> =>
  runExclusive(lockKey(snapshotId), work);

/** Inside a transaction: wait for other server instances' writers. Released when the transaction ends. */
export const takeSnapshotLock = (tx: Prisma.TransactionClient, snapshotId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(snapshotId)}))`;

/** The manuscript of a snapshot, created if it does not exist yet. Safe against another writer creating it first. */
export async function ensureManuscript(tx: Prisma.TransactionClient, params: { projectId: string; snapshotId: string; actor: string }): Promise<Manuscript> {
  const existing = await tx.manuscript.findUnique({ where: { snapshotId: params.snapshotId } });
  if (existing) return existing;
  return tx.manuscript.create({ data: { projectId: params.projectId, snapshotId: params.snapshotId, createdBy: params.actor } });
}
