import { prisma } from '../../config/prisma.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import type {
  EvidenceClaimSummary,
  EvidenceDetail,
  EvidenceFindingSummary,
  EvidenceListView,
  EvidenceStats,
} from './evidence.types.js';

export interface ListSnapshotEvidenceOptions {
  projectId: string;
  snapshotId: string;
  query: {
    search?: string;
    verified?: boolean;
    studyId?: string;
    claimId?: string;
    page: number;
    limit: number;
  };
}

export async function listSnapshotEvidence(
  options: ListSnapshotEvidenceOptions,
): Promise<EvidenceListView> {
  const { projectId, snapshotId, query } = options;

  // Confirm snapshot belongs to project
  const snapshot = await prisma.reviewSnapshot.findFirst({
    where: { id: snapshotId, projectId },
    select: { id: true },
  });
  if (!snapshot) {
    throw new NotFoundError('Snapshot not found', 'SNAPSHOT_NOT_FOUND');
  }

  // Build where clause
  const where: any = { snapshotId };

  if (typeof query.verified === 'boolean') {
    where.quoteHashVerified = query.verified;
  }

  if (query.studyId) {
    where.OR = [
      { studyId: query.studyId },
      { study: { externalId: query.studyId } },
    ];
  }

  if (query.search) {
    const term = query.search;
    where.AND = [
      ...(where.AND ?? []),
      {
        OR: [
          { quote: { contains: term, mode: 'insensitive' } },
          { externalId: { contains: term, mode: 'insensitive' } },
          { study: { title: { contains: term, mode: 'insensitive' } } },
        ],
      },
    ];
  }

  const page = Math.max(1, query.page);
  const limit = Math.min(200, Math.max(1, query.limit));
  const skip = (page - 1) * limit;

  // Fetch paginated evidence with relations
  const [rawItems, totalFiltered, allStatsRows] = await Promise.all([
    prisma.evidence.findMany({
      where,
      skip,
      take: limit,
      orderBy: { externalId: 'asc' },
      include: {
        study: {
          select: {
            id: true,
            externalId: true,
            title: true,
            authors: true,
            year: true,
            venue: true,
            doi: true,
          },
        },
        document: {
          select: {
            id: true,
            externalId: true,
            kind: true,
          },
        },
        findings: {
          include: {
            finding: {
              include: {
                claimItems: {
                  include: {
                    claim: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.evidence.count({ where }),
    prisma.evidence.findMany({
      where: { snapshotId },
      select: {
        id: true,
        quoteHashVerified: true,
        findings: {
          select: {
            finding: {
              select: {
                claimItems: {
                  select: { claimId: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  // Compute snapshot-level stats
  const total = allStatsRows.length;
  let verifiedCount = 0;
  let withClaimsCount = 0;

  for (const row of allStatsRows) {
    if (row.quoteHashVerified) verifiedCount++;
    const hasClaim = row.findings.some((ef) => ef.finding.claimItems.length > 0);
    if (hasClaim) withClaimsCount++;
  }

  const stats: EvidenceStats = {
    total,
    verifiedCount,
    unverifiedCount: total - verifiedCount,
    withClaimsCount,
    unlinkedCount: total - withClaimsCount,
  };

  // Map database rows to EvidenceDetail items
  const items: EvidenceDetail[] = rawItems.map((item) => {
    const findings: EvidenceFindingSummary[] = [];
    const claimsMap = new Map<string, EvidenceClaimSummary>();

    for (const ef of item.findings) {
      findings.push({
        id: ef.finding.id,
        externalId: ef.finding.externalId,
        fieldId: ef.finding.fieldId,
        fieldName: ef.finding.fieldName,
        valueText: ef.finding.valueText,
      });

      for (const ci of ef.finding.claimItems) {
        if (!claimsMap.has(ci.claim.externalId)) {
          claimsMap.set(ci.claim.externalId, {
            id: ci.claim.id,
            externalId: ci.claim.externalId,
            title: ci.claim.title,
            researchQuestionId: ci.claim.researchQuestionId,
          });
        }
      }
    }

    return {
      id: item.id,
      snapshotId: item.snapshotId,
      externalId: item.externalId,
      fieldId: item.fieldId,
      quote: item.quote,
      quoteHash: item.quoteHash,
      quoteHashVerified: item.quoteHashVerified,
      sourceRevision: item.sourceRevision,
      sourceHash: item.sourceHash,
      sourceAnchor: {
        page: item.page,
        section: item.section,
        paragraph: item.paragraph,
        tableOrFigure: item.tableOrFigure,
        charStart: item.charStart,
        charEnd: item.charEnd,
      },
      study: item.study,
      document: item.document,
      findings,
      claims: Array.from(claimsMap.values()),
    };
  });

  return {
    items,
    stats,
    pagination: {
      page,
      limit,
      total: totalFiltered,
      totalPages: Math.ceil(totalFiltered / limit) || 1,
    },
  };
}

export async function getSnapshotEvidenceById(options: {
  projectId: string;
  snapshotId: string;
  evidenceId: string;
}): Promise<EvidenceDetail> {
  const { projectId, snapshotId, evidenceId } = options;

  // Confirm snapshot belongs to project
  const snapshot = await prisma.reviewSnapshot.findFirst({
    where: { id: snapshotId, projectId },
    select: { id: true },
  });
  if (!snapshot) {
    throw new NotFoundError('Snapshot not found', 'SNAPSHOT_NOT_FOUND');
  }

  const item = await prisma.evidence.findFirst({
    where: {
      snapshotId,
      OR: [{ id: evidenceId }, { externalId: evidenceId }],
    },
    include: {
      study: {
        select: {
          id: true,
          externalId: true,
          title: true,
          authors: true,
          year: true,
          venue: true,
          doi: true,
        },
      },
      document: {
        select: {
          id: true,
          externalId: true,
          kind: true,
        },
      },
      findings: {
        include: {
          finding: {
            include: {
              claimItems: {
                include: {
                  claim: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!item) {
    throw new NotFoundError('Evidence not found', 'EVIDENCE_NOT_FOUND');
  }

  const findings: EvidenceFindingSummary[] = [];
  const claimsMap = new Map<string, EvidenceClaimSummary>();

  for (const ef of item.findings) {
    findings.push({
      id: ef.finding.id,
      externalId: ef.finding.externalId,
      fieldId: ef.finding.fieldId,
      fieldName: ef.finding.fieldName,
      valueText: ef.finding.valueText,
    });

    for (const ci of ef.finding.claimItems) {
      if (!claimsMap.has(ci.claim.externalId)) {
        claimsMap.set(ci.claim.externalId, {
          id: ci.claim.id,
          externalId: ci.claim.externalId,
          title: ci.claim.title,
          researchQuestionId: ci.claim.researchQuestionId,
        });
      }
    }
  }

  return {
    id: item.id,
    snapshotId: item.snapshotId,
    externalId: item.externalId,
    fieldId: item.fieldId,
    quote: item.quote,
    quoteHash: item.quoteHash,
    quoteHashVerified: item.quoteHashVerified,
    sourceRevision: item.sourceRevision,
    sourceHash: item.sourceHash,
    sourceAnchor: {
      page: item.page,
      section: item.section,
      paragraph: item.paragraph,
      tableOrFigure: item.tableOrFigure,
      charStart: item.charStart,
      charEnd: item.charEnd,
    },
    study: item.study,
    document: item.document,
    findings,
    claims: Array.from(claimsMap.values()),
  };
}
