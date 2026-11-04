import { prisma } from '../../config/prisma.js';
import type { LineageItem } from './export.types.js';

interface RawParagraphFact {
  paragraphId?: string;
  paragraphKey?: string;
  text?: string;
  usedEvidenceIds?: string[];
  usedFindingIds?: string[];
}

interface RawPlanParagraph {
  id?: string;
  paragraphKey?: string;
  rhetoricalMove?: string;
  claimSlot?: string;
  claimStrength?: string;
  sectionKey?: string;
  targetFindings?: string[];
  targetEvidence?: string[];
}

/**
 * Builds the complete evidence lineage graph for a manuscript:
 * traces every paragraph down through ParagraphPlan -> ExtractedFinding -> Study -> Evidence & SourceAnchor.
 */
export async function buildManuscriptLineage(params: {
  manuscriptId: string;
  snapshotId: string;
}): Promise<LineageItem[]> {
  const [sections, latestPlan, findings, evidenceList] = await Promise.all([
    prisma.manuscriptSection.findMany({
      where: { manuscriptId: params.manuscriptId },
      include: {
        revisions: {
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    }),
    prisma.paragraphPlanRevision.findFirst({
      where: { manuscriptId: params.manuscriptId },
      orderBy: { version: 'desc' },
    }),
    prisma.extractedFinding.findMany({
      where: { snapshotId: params.snapshotId },
    }),
    prisma.evidence.findMany({
      where: { snapshotId: params.snapshotId },
      include: {
        study: true,
        document: true,
      },
    }),
  ]);

  // Index findings by id and externalId
  const findingMap = new Map<string, typeof findings[0]>();
  for (const f of findings) {
    findingMap.set(f.id, f);
    findingMap.set(f.externalId, f);
  }

  // Index evidence by id and externalId
  const evidenceMap = new Map<string, typeof evidenceList[0]>();
  for (const ev of evidenceList) {
    evidenceMap.set(ev.id, ev);
    evidenceMap.set(ev.externalId, ev);
  }

  // Index paragraph plan items by key or id
  const planMap = new Map<string, RawPlanParagraph>();
  if (latestPlan && latestPlan.content && typeof latestPlan.content === 'object') {
    const rawContent = latestPlan.content as { paragraphs?: RawPlanParagraph[] };
    if (Array.isArray(rawContent.paragraphs)) {
      for (const p of rawContent.paragraphs) {
        if (p.paragraphKey) planMap.set(p.paragraphKey, p);
        if (p.id) planMap.set(p.id, p);
      }
    }
  }

  const markerRegex = /\[([a-zA-Z0-9_\-:]+)\]/g;
  const lineageItems: LineageItem[] = [];

  for (const sec of sections) {
    const latestRev = sec.revisions[0];
    if (!latestRev) continue;

    const facts = (latestRev.facts as { paragraphs?: RawParagraphFact[] }) || {};
    let paragraphs: { key?: string; text: string; usedEv: string[]; usedFind: string[] }[] = [];

    if (Array.isArray(facts.paragraphs) && facts.paragraphs.length > 0) {
      paragraphs = facts.paragraphs.map((p, idx) => ({
        key: p.paragraphKey || p.paragraphId || `para_${sec.sectionKey}_${idx + 1}`,
        text: p.text || '',
        usedEv: Array.isArray(p.usedEvidenceIds) ? p.usedEvidenceIds : [],
        usedFind: Array.isArray(p.usedFindingIds) ? p.usedFindingIds : [],
      }));
    } else {
      // Split raw markdown into paragraphs
      const splitParas: string[] = latestRev.markdown
        .split(/\n\n+/)
        .map((t: string) => t.trim())
        .filter((t: string) => t.length > 0 && !t.startsWith('#'));

      paragraphs = splitParas.map((t: string, idx: number) => ({
        key: `para_${sec.sectionKey}_${idx + 1}`,
        text: t,
        usedEv: [],
        usedFind: [],
      }));
    }

    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
      const p = paragraphs[pIdx]!;
      const usedFindingIds = new Set<string>(p.usedFind);
      const usedEvidenceIds = new Set<string>(p.usedEv);

      // Scan inline citation markers in text
      let match: RegExpExecArray | null;
      markerRegex.lastIndex = 0;
      while ((match = markerRegex.exec(p.text)) !== null) {
        const marker = match[1]!;
        if (evidenceMap.has(marker)) {
          usedEvidenceIds.add(marker);
        } else if (findingMap.has(marker)) {
          usedFindingIds.add(marker);
        } else if (marker.startsWith('E-')) {
          usedEvidenceIds.add(marker);
          if (evidenceMap.has(marker.slice(2))) usedEvidenceIds.add(marker.slice(2));
        } else if (marker.startsWith('F:')) {
          usedFindingIds.add(marker);
          if (findingMap.has(marker.slice(2))) usedFindingIds.add(marker.slice(2));
        }
      }

      // Check plan info
      const planItem = p.key ? planMap.get(p.key) : undefined;
      if (planItem) {
        if (Array.isArray(planItem.targetFindings)) {
          for (const fId of planItem.targetFindings) usedFindingIds.add(fId);
        }
        if (Array.isArray(planItem.targetEvidence)) {
          for (const evId of planItem.targetEvidence) usedEvidenceIds.add(evId);
        }
      }

      // Resolve findings
      const resolvedFindings: LineageItem['findings'] = [];
      for (const fId of usedFindingIds) {
        const found = findingMap.get(fId);
        if (found) {
          resolvedFindings.push({
            id: found.id,
            externalId: found.externalId,
            fieldName: found.fieldName,
            sectionName: found.sectionName,
            valueText: found.valueText,
            consensusMatch: found.role || undefined,
          });
        }
      }

      // Resolve evidence
      const resolvedEvidence: LineageItem['evidence'] = [];
      for (const evId of usedEvidenceIds) {
        const found = evidenceMap.get(evId);
        if (found) {
          resolvedEvidence.push({
            id: found.id,
            externalId: found.externalId,
            studyId: found.studyId,
            quote: found.quote,
            quoteHashVerified: found.quoteHashVerified,
            page: found.page,
            section: found.section,
            paragraph: found.paragraph,
            studyTitle: found.study.title,
            studyAuthors: found.study.authors,
            studyYear: found.study.year,
            studyDoi: found.study.doi,
            sourceRevision: found.sourceRevision,
          });
        }
      }

      resolvedFindings.sort((a, b) => a.externalId.localeCompare(b.externalId));
      resolvedEvidence.sort((a, b) => a.externalId.localeCompare(b.externalId));

      lineageItems.push({
        sectionKey: sec.sectionKey,
        paragraphIndex: pIdx,
        paragraphKey: p.key,
        text: p.text,
        rhetoricalMove: planItem?.rhetoricalMove,
        claimSlot: planItem?.claimSlot,
        claimStrength: planItem?.claimStrength,
        usedFindingIds: Array.from(usedFindingIds),
        usedEvidenceIds: Array.from(usedEvidenceIds),
        findings: resolvedFindings,
        evidence: resolvedEvidence,
      });
    }
  }

  return lineageItems;
}

/**
 * Filter lineage items by query parameters (sectionKey, evidenceId, findingId, sentence search).
 */
export function filterLineage(
  items: LineageItem[],
  query: {
    sectionKey?: string;
    evidenceId?: string;
    findingId?: string;
    sentence?: string;
  }
): LineageItem[] {
  return items.filter((item) => {
    if (query.sectionKey && item.sectionKey.toLowerCase() !== query.sectionKey.toLowerCase()) {
      return false;
    }
    if (query.evidenceId) {
      const match =
        item.usedEvidenceIds.includes(query.evidenceId) ||
        item.evidence.some((e) => e.id === query.evidenceId || e.externalId === query.evidenceId);
      if (!match) return false;
    }
    if (query.findingId) {
      const match =
        item.usedFindingIds.includes(query.findingId) ||
        item.findings.some((f) => f.id === query.findingId || f.externalId === query.findingId);
      if (!match) return false;
    }
    if (query.sentence) {
      const searchLower = query.sentence.toLowerCase();
      const matchText = item.text.toLowerCase().includes(searchLower);
      const matchQuote = item.evidence.some((e) => e.quote.toLowerCase().includes(searchLower));
      if (!matchText && !matchQuote) return false;
    }
    return true;
  });
}
