export interface EvidenceSourceAnchor {
  page: number | null;
  section: string | null;
  paragraph: number | null;
  tableOrFigure: string | null;
  charStart: number | null;
  charEnd: number | null;
}

export interface EvidenceStudySummary {
  id: string;
  externalId: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
}

export interface EvidenceFindingSummary {
  id: string;
  externalId: string;
  fieldId: string;
  fieldName: string;
  valueText: string;
}

export interface EvidenceClaimSummary {
  id: string;
  externalId: string;
  title: string;
  researchQuestionId: string | null;
}

export interface EvidenceDetail {
  id: string;
  snapshotId: string;
  externalId: string;
  fieldId: string;
  quote: string;
  quoteHash: string | null;
  quoteHashVerified: boolean;
  sourceRevision: string;
  sourceHash: string | null;
  sourceAnchor: EvidenceSourceAnchor;
  study: EvidenceStudySummary;
  document: {
    id: string;
    externalId: string;
    kind: string;
  };
  findings: EvidenceFindingSummary[];
  claims: EvidenceClaimSummary[];
}

export interface EvidenceStats {
  total: number;
  verifiedCount: number;
  unverifiedCount: number;
  withClaimsCount: number;
  unlinkedCount: number;
}

export interface EvidencePagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface EvidenceListView {
  items: EvidenceDetail[];
  stats: EvidenceStats;
  pagination: EvidencePagination;
}
