import type {
  CitationItem,
  CitationManifest,
  UnresolvedCitation,
} from './verification.types.js';

export interface SnapshotRegistryForManifest {
  studies: Array<{
    externalId: string;
    title: string;
    year: number | null;
  }>;
  findings: Array<{
    externalId: string;
    studyId: string;
    fieldName: string;
    valueText: string;
  }>;
  evidence: Array<{
    externalId: string;
    studyId: string;
    quote: string;
    quoteHashVerified: boolean;
  }>;
}

export interface SectionRevisionForManifest {
  sectionKey: string;
  version: number;
  markdown: string;
  facts: unknown;
}

/**
 * Extracts citation markers and maps them to verified registry entities in the snapshot.
 * Identifies unresolved references and orphan markers.
 */
export function buildCitationManifest(params: {
  manuscriptId: string;
  snapshotId: string;
  sections: SectionRevisionForManifest[];
  registry: SnapshotRegistryForManifest;
}): CitationManifest {
  const { manuscriptId, snapshotId, sections, registry } = params;

  const studyMap = new Map<string, { externalId: string; title: string; year: number | null }>();
  for (const s of registry.studies) {
    studyMap.set(s.externalId, s);
  }

  const findingMap = new Map<string, { externalId: string; studyId: string; fieldName: string; valueText: string }>();
  for (const f of registry.findings) {
    findingMap.set(f.externalId, f);
  }

  const evidenceMap = new Map<string, { externalId: string; studyId: string; quote: string; quoteHashVerified: boolean }>();
  for (const e of registry.evidence) {
    evidenceMap.set(e.externalId, e);
  }

  const items: CitationItem[] = [];
  const unresolvedCitations: UnresolvedCitation[] = [];
  const seenCitationKeys = new Set<string>();

  for (const sec of sections) {
    const facts = (sec.facts && typeof sec.facts === 'object' ? sec.facts : {}) as Record<string, unknown>;
    const paragraphs = Array.isArray(facts.paragraphs) ? (facts.paragraphs as Array<Record<string, unknown>>) : [];

    for (const p of paragraphs) {
      const paragraphId = typeof p.paragraphId === 'string' ? p.paragraphId : 'unknown-para';
      const usedEvidenceIds = Array.isArray(p.usedEvidenceIds) ? (p.usedEvidenceIds as string[]) : [];
      const usedFindingIds = Array.isArray(p.usedFindingIds) ? (p.usedFindingIds as string[]) : [];

      // 1. Resolve Evidence IDs
      for (const eId of usedEvidenceIds) {
        const ev = evidenceMap.get(eId);
        if (!ev) {
          unresolvedCitations.push({
            marker: eId,
            location: `${sec.sectionKey}/${paragraphId}`,
            reason: `Evidence ID "${eId}" is not present in snapshot corpus registry`,
          });
          continue;
        }

        const study = studyMap.get(ev.studyId);
        const dedupeKey = `${sec.sectionKey}:${paragraphId}:${eId}`;
        if (!seenCitationKeys.has(dedupeKey)) {
          seenCitationKeys.add(dedupeKey);
          items.push({
            citationId: `cit-${sec.sectionKey}-${paragraphId}-${eId}`,
            sectionKey: sec.sectionKey,
            paragraphId,
            evidenceId: eId,
            studyId: ev.studyId,
            studyTitle: study?.title ?? 'Unknown Study',
            studyYear: study?.year ?? null,
            quote: ev.quote,
            quoteHashVerified: ev.quoteHashVerified,
            isResolved: true,
          });
        }
      }

      // 2. Resolve Finding IDs (when not already backed by evidence)
      for (const fId of usedFindingIds) {
        const f = findingMap.get(fId);
        if (!f) {
          unresolvedCitations.push({
            marker: fId,
            location: `${sec.sectionKey}/${paragraphId}`,
            reason: `Finding ID "${fId}" is not present in snapshot corpus registry`,
          });
          continue;
        }

        const study = studyMap.get(f.studyId);
        const dedupeKey = `${sec.sectionKey}:${paragraphId}:${fId}`;
        if (!seenCitationKeys.has(dedupeKey)) {
          seenCitationKeys.add(dedupeKey);
          items.push({
            citationId: `cit-${sec.sectionKey}-${paragraphId}-${fId}`,
            sectionKey: sec.sectionKey,
            paragraphId,
            findingId: fId,
            studyId: f.studyId,
            studyTitle: study?.title ?? 'Unknown Study',
            studyYear: study?.year ?? null,
            quoteHashVerified: true,
            isResolved: true,
          });
        }
      }

      // 3. Scan paragraph text for raw bracketed markers [E-xx] or foreign markers
      const text = typeof p.text === 'string' ? p.text : '';
      const markerRegex = /\[([a-zA-Z0-9_\-:]+)\]/g;
      let match: RegExpExecArray | null;
      while ((match = markerRegex.exec(text)) !== null) {
        const token = match[1];
        const isCitationCandidate =
          token.startsWith('E-') ||
          token.startsWith('F:') ||
          token.startsWith('study_') ||
          token.startsWith('paper_') ||
          token.startsWith('demo_') ||
          studyMap.has(token) ||
          evidenceMap.has(token) ||
          findingMap.has(token);

        if (isCitationCandidate) {
          const isKnownEvidence = evidenceMap.has(token);
          const isKnownFinding = findingMap.has(token);
          const isKnownStudy = studyMap.has(token);

          if (!isKnownEvidence && !isKnownFinding && !isKnownStudy) {
            unresolvedCitations.push({
              marker: token,
              location: `${sec.sectionKey}/${paragraphId}`,
              reason: `Unrecognized citation marker "[${token}]" found in drafted prose text`,
            });
          }
        }
      }
    }

    // 4. Scan overall section markdown for manual prose edits containing citation markers
    const proseMarkerRegex = /\[([a-zA-Z0-9_\-:]+)\]/g;
    let proseMatch: RegExpExecArray | null;
    while ((proseMatch = proseMarkerRegex.exec(sec.markdown)) !== null) {
      const token = proseMatch[1];
      const isCitationCandidate =
        token.startsWith('E-') ||
        token.startsWith('F:') ||
        token.startsWith('study_') ||
        token.startsWith('paper_') ||
        token.startsWith('demo_') ||
        studyMap.has(token) ||
        evidenceMap.has(token) ||
        findingMap.has(token);

      if (isCitationCandidate) {
        const isKnownEvidence = evidenceMap.has(token);
        const isKnownFinding = findingMap.has(token);
        const isKnownStudy = studyMap.has(token);

        if (!isKnownEvidence && !isKnownFinding && !isKnownStudy) {
          const alreadyFlagged = unresolvedCitations.some(
            (u) => u.marker === token && u.location.startsWith(sec.sectionKey),
          );
          if (!alreadyFlagged) {
            unresolvedCitations.push({
              marker: token,
              location: `${sec.sectionKey}/markdown`,
              reason: `Unrecognized citation marker "[${token}]" found in drafted prose text`,
            });
          }
        }
      }
    }
  }

  return {
    manuscriptId,
    snapshotId,
    items,
    unresolvedCitations,
    totalCitations: items.length + unresolvedCitations.length,
    resolvedCitations: items.length,
  };
}
