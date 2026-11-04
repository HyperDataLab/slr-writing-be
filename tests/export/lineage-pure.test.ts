import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

// Guarantee zero database I/O by stubbing prisma client
vi.mock('../../src/config/prisma.js', () => ({
  prisma: {},
}));

import { createZipArchive, type ZipEntry } from '../../src/shared/utils/zip.js';
import { filterLineage } from '../../src/modules/export/lineage.service.js';
import { assembleSubmissionBundle } from '../../src/modules/export/package-assembler.js';
import type { LineageItem } from '../../src/modules/export/export.types.js';

// ============================================================================
// Helper: In-memory PKZIP parser and decompressor using Node built-ins
// ============================================================================

interface ParsedZipEntry {
  filename: string;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  uncompressedData: Buffer;
}

interface ParsedZipArchive {
  totalEntries: number;
  centralDirSize: number;
  centralDirOffset: number;
  entries: ParsedZipEntry[];
}

function parseAndExtractZip(buf: Buffer): ParsedZipArchive {
  // Locate EOCD signature 0x06054b50 (from the end of buffer)
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdOffset = buf.lastIndexOf(eocdSig);
  if (eocdOffset === -1) {
    throw new Error('End of Central Directory record signature not found');
  }

  const entriesOnDisk = buf.readUInt16LE(eocdOffset + 8);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buf.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  if (entriesOnDisk !== totalEntries) {
    throw new Error(`Disk entries (${entriesOnDisk}) do not match total entries (${totalEntries})`);
  }

  const entries: ParsedZipEntry[] = [];
  let cdPtr = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    const cdSig = buf.readUInt32LE(cdPtr);
    if (cdSig !== 0x02014b50) {
      throw new Error(`Expected Central Directory signature 0x02014b50 at offset ${cdPtr}, got 0x${cdSig.toString(16)}`);
    }

    const compressionMethod = buf.readUInt16LE(cdPtr + 10);
    const fileCrc = buf.readUInt32LE(cdPtr + 16);
    const compressedSize = buf.readUInt32LE(cdPtr + 20);
    const uncompressedSize = buf.readUInt32LE(cdPtr + 24);
    const filenameLen = buf.readUInt16LE(cdPtr + 28);
    const extraLen = buf.readUInt16LE(cdPtr + 30);
    const commentLen = buf.readUInt16LE(cdPtr + 32);
    const localHeaderOffset = buf.readUInt32LE(cdPtr + 42);

    const filename = buf.toString('utf8', cdPtr + 46, cdPtr + 46 + filenameLen);

    // Validate Local File Header for this entry
    const localSig = buf.readUInt32LE(localHeaderOffset);
    if (localSig !== 0x04034b50) {
      throw new Error(`Expected Local Header signature 0x04034b50 at offset ${localHeaderOffset}, got 0x${localSig.toString(16)}`);
    }

    const localFilenameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFilenameLen + localExtraLen;
    const compressedData = buf.subarray(dataStart, dataStart + compressedSize);

    let uncompressedData: Buffer;
    if (compressionMethod === 0 || uncompressedSize === 0) {
      uncompressedData = compressedData;
    } else if (compressionMethod === 8) {
      uncompressedData = inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported compression method ${compressionMethod}`);
    }

    entries.push({
      filename,
      compressionMethod,
      crc32: fileCrc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      uncompressedData,
    });

    cdPtr += 46 + filenameLen + extraLen + commentLen;
  }

  return {
    totalEntries,
    centralDirSize,
    centralDirOffset,
    entries,
  };
}

// ============================================================================
// Suite 1: Pure PKZIP Archive Generator (src/shared/utils/zip.ts)
// ============================================================================

describe('createZipArchive (Pure In-Memory PKZIP Generator)', () => {
  it('generates a valid empty archive when given an empty entry list', () => {
    const zipBuf = createZipArchive([]);

    // Standard PKZIP EOCD record is 22 bytes
    expect(zipBuf).toBeInstanceOf(Buffer);
    expect(zipBuf.length).toBe(22);

    // EOCD signature: 0x06054b50
    expect(zipBuf.readUInt32LE(0)).toBe(0x06054b50);
    // Number of entries: 0
    expect(zipBuf.readUInt16LE(8)).toBe(0);
    expect(zipBuf.readUInt16LE(10)).toBe(0);
    // Central directory size and offset: 0
    expect(zipBuf.readUInt32LE(12)).toBe(0);
    expect(zipBuf.readUInt32LE(16)).toBe(0);

    const parsed = parseAndExtractZip(zipBuf);
    expect(parsed.totalEntries).toBe(0);
    expect(parsed.entries).toHaveLength(0);
  });

  it('generates valid PKZIP buffers from multiple entries (text, empty file, binary Buffer)', () => {
    const textContent = 'Hello, Systematic Literature Review export engine!';
    const emptyContent = Buffer.alloc(0);
    const binaryContent = Buffer.from([0x00, 0xff, 0x12, 0x34, 0xde, 0xad, 0xbe, 0xef, 0x77, 0x88]);

    const entries: ZipEntry[] = [
      { filename: 'manuscript.txt', content: textContent },
      { filename: 'empty.placeholder', content: emptyContent },
      { filename: 'dataset.bin', content: binaryContent },
    ];

    const zipBuf = createZipArchive(entries);

    // Starts with Local file header signature 0x04034b50
    expect(zipBuf.readUInt32LE(0)).toBe(0x04034b50);

    // Parse and verify archive structure
    const parsed = parseAndExtractZip(zipBuf);
    expect(parsed.totalEntries).toBe(3);
    expect(parsed.entries).toHaveLength(3);

    // Validate Entry 1: text
    const textEntry = parsed.entries[0]!;
    expect(textEntry.filename).toBe('manuscript.txt');
    expect(textEntry.compressionMethod).toBe(8); // DEFLATE
    expect(textEntry.uncompressedSize).toBe(Buffer.byteLength(textContent, 'utf8'));
    expect(textEntry.crc32).toBe(crc32(Buffer.from(textContent, 'utf8')));
    expect(textEntry.uncompressedData.toString('utf8')).toBe(textContent);

    // Validate Entry 2: empty file (Stored method 0, crc 0)
    const emptyEntry = parsed.entries[1]!;
    expect(emptyEntry.filename).toBe('empty.placeholder');
    expect(emptyEntry.compressionMethod).toBe(0); // STORE
    expect(emptyEntry.uncompressedSize).toBe(0);
    expect(emptyEntry.compressedSize).toBe(0);
    expect(emptyEntry.crc32).toBe(0);
    expect(emptyEntry.uncompressedData.length).toBe(0);

    // Validate Entry 3: binary buffer
    const binEntry = parsed.entries[2]!;
    expect(binEntry.filename).toBe('dataset.bin');
    expect(binEntry.compressionMethod).toBe(8);
    expect(binEntry.uncompressedSize).toBe(binaryContent.length);
    expect(binEntry.crc32).toBe(crc32(binaryContent));
    expect(Buffer.compare(binEntry.uncompressedData, binaryContent)).toBe(0);
  });

  it('validates PKZIP magic signatures and internal offsets for all headers', () => {
    const entries: ZipEntry[] = [
      { filename: 'fileA.txt', content: 'Content A' },
      { filename: 'fileB.txt', content: 'Content B is slightly longer than A' },
    ];

    const zipBuf = createZipArchive(entries);

    // Local Header signatures check
    const localSig1 = zipBuf.readUInt32LE(0);
    expect(localSig1).toBe(0x04034b50);

    // Find Central Directory and EOCD signatures in buffer
    const cdSigPattern = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const eocdSigPattern = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

    expect(zipBuf.includes(cdSigPattern)).toBe(true);
    expect(zipBuf.includes(eocdSigPattern)).toBe(true);

    const parsed = parseAndExtractZip(zipBuf);
    expect(parsed.totalEntries).toBe(2);

    // Verify local offsets in central directory match actual local headers
    for (const ent of parsed.entries) {
      const headerSigAtOffset = zipBuf.readUInt32LE(ent.localHeaderOffset);
      expect(headerSigAtOffset).toBe(0x04034b50);
    }
  });

  it('handles unicode filenames and special characters with bit 11 UTF-8 set', () => {
    const unicodeEntries: ZipEntry[] = [
      { filename: 'tài-liệu/nghiên-cứu_2026.md', content: '# Nghiên cứu tổng quan\nNội dung tiếng Việt.' },
      { filename: 'special/🔬_results_#1 [draft].json', content: '{"status":"ok"}' },
      { filename: 'path with spaces/nested folder/table-📊.csv', content: 'col1,col2\n10,20' },
    ];

    const zipBuf = createZipArchive(unicodeEntries);
    const parsed = parseAndExtractZip(zipBuf);

    expect(parsed.totalEntries).toBe(3);
    expect(parsed.entries[0]!.filename).toBe('tài-liệu/nghiên-cứu_2026.md');
    expect(parsed.entries[0]!.uncompressedData.toString('utf8')).toContain('Nội dung tiếng Việt.');

    expect(parsed.entries[1]!.filename).toBe('special/🔬_results_#1 [draft].json');
    expect(parsed.entries[1]!.uncompressedData.toString('utf8')).toBe('{"status":"ok"}');

    expect(parsed.entries[2]!.filename).toBe('path with spaces/nested folder/table-📊.csv');
    expect(parsed.entries[2]!.uncompressedData.toString('utf8')).toBe('col1,col2\n10,20');

    // Verify general purpose bit 11 (0x0800) is set in local header
    const localFlag = zipBuf.readUInt16LE(6);
    expect((localFlag & 0x0800) !== 0).toBe(true);
  });

  it('compresses very large repetitive content effectively with DEFLATE and verifies CRC32', () => {
    // Generate 256 KB of repeating structured JSON text
    const repetitiveText = JSON.stringify({
      study: 'Automated SLR Evidence Synthesis',
      methodology: 'Empirical PRISMA Workflow Analysis',
      findings: Array.from({ length: 1500 }, (_, i) => ({
        id: `finding-${i}`,
        score: (i * 1.5) % 100,
        tags: ['accuracy', 'reproducibility', 'lineage'],
      })),
    });

    const uncompressedSize = Buffer.byteLength(repetitiveText, 'utf8');
    expect(uncompressedSize).toBeGreaterThan(100_000);

    const zipBuf = createZipArchive([{ filename: 'large_payload.json', content: repetitiveText }]);
    const parsed = parseAndExtractZip(zipBuf);

    const entry = parsed.entries[0]!;
    expect(entry.filename).toBe('large_payload.json');
    expect(entry.uncompressedSize).toBe(uncompressedSize);
    // Compression should achieve significant size reduction
    expect(entry.compressedSize).toBeLessThan(entry.uncompressedSize / 3);
    expect(entry.crc32).toBe(crc32(Buffer.from(repetitiveText, 'utf8')));
    expect(entry.uncompressedData.toString('utf8')).toBe(repetitiveText);
  });

  it('treats empty string content identical to zero-byte buffer', () => {
    const zipBuf = createZipArchive([{ filename: 'empty-string.txt', content: '' }]);
    const parsed = parseAndExtractZip(zipBuf);

    expect(parsed.totalEntries).toBe(1);
    const entry = parsed.entries[0]!;
    expect(entry.filename).toBe('empty-string.txt');
    expect(entry.compressionMethod).toBe(0);
    expect(entry.uncompressedSize).toBe(0);
    expect(entry.compressedSize).toBe(0);
    expect(entry.crc32).toBe(0);
    expect(entry.uncompressedData.length).toBe(0);
  });
});

// ============================================================================
// Suite 2: filterLineage (src/modules/export/lineage.service.ts)
// ============================================================================

describe('filterLineage (Pure In-Memory Lineage Filter)', () => {
  const mockLineageItems: LineageItem[] = [
    {
      sectionKey: 'Introduction',
      paragraphIndex: 0,
      paragraphKey: 'para_intro_1',
      text: 'Systematic literature reviews in software engineering require rigorous traceability.',
      rhetoricalMove: 'EstablishContext',
      claimSlot: 'C1',
      claimStrength: 'STRONG',
      usedFindingIds: ['F:study-1:acc', 'F:study-2:speed'],
      usedEvidenceIds: ['E-study-1-quote-1'],
      findings: [
        {
          id: 'find-101',
          externalId: 'F:study-1:acc',
          fieldName: 'accuracy',
          sectionName: 'Results',
          valueText: 'High synthesis accuracy rate of 94%',
          consensusMatch: 'DIRECT',
        },
        {
          id: 'find-102',
          externalId: 'F:study-2:speed',
          fieldName: 'speedup',
          sectionName: 'Results',
          valueText: 'Faster extraction turnaround time',
          consensusMatch: 'SUPPORTIVE',
        },
      ],
      evidence: [
        {
          id: 'ev-201',
          externalId: 'E-study-1-quote-1',
          studyId: 'study-1',
          quote: 'Copilot improved task completion speed by 55% in controlled trials.',
          quoteHashVerified: true,
          page: 4,
          section: '3.1',
          paragraph: 2,
          studyTitle: 'Empirical Study on LLMs',
          studyAuthors: ['Nguyen et al.'],
          studyYear: 2024,
          studyDoi: '10.1109/TSE.2024.01',
        },
      ],
    },
    {
      sectionKey: 'Results',
      paragraphIndex: 0,
      paragraphKey: 'para_results_1',
      text: 'Empirical findings suggest significant productivity gains across varied developers.',
      rhetoricalMove: 'PresentEvidence',
      claimSlot: 'C2',
      claimStrength: 'MODERATE',
      usedFindingIds: ['F:study-3:productivity'],
      usedEvidenceIds: ['E-study-3-quote-1', 'E-study-3-quote-2'],
      findings: [
        {
          id: 'find-103',
          externalId: 'F:study-3:productivity',
          fieldName: 'productivity',
          sectionName: 'Synthesis',
          valueText: 'Productivity uplift observed in 12 out of 14 projects',
        },
      ],
      evidence: [
        {
          id: 'ev-202',
          externalId: 'E-study-3-quote-1',
          studyId: 'study-3',
          quote: 'Participant developers experienced a 45% productivity boost in task completion.',
          quoteHashVerified: true,
          page: 8,
          section: '4.2',
          paragraph: 1,
          studyTitle: 'Developer Productivity Review',
          studyAuthors: ['Smith and Doe'],
          studyYear: 2023,
          studyDoi: '10.1145/3544548',
        },
        {
          id: 'ev-203',
          externalId: 'E-study-3-quote-2',
          studyId: 'study-3',
          quote: 'Junior engineers benefited the most from AI coding assistance.',
          quoteHashVerified: true,
          page: 9,
          section: '4.3',
          paragraph: 3,
        },
      ],
    },
    {
      sectionKey: 'Discussion',
      paragraphIndex: 0,
      paragraphKey: 'para_disc_1',
      text: 'Threats to validity include potential hallucination and unverified assertions.',
      rhetoricalMove: 'DiscussLimitations',
      claimSlot: 'C3',
      claimStrength: 'CAUTIOUS',
      usedFindingIds: [],
      usedEvidenceIds: ['ev-unresolved-ghost'],
      findings: [],
      evidence: [],
    },
  ];

  it('filters by sectionKey case-insensitively', () => {
    // Exact match
    const introMatches = filterLineage(mockLineageItems, { sectionKey: 'Introduction' });
    expect(introMatches).toHaveLength(1);
    expect(introMatches[0]!.sectionKey).toBe('Introduction');

    // Lowercase query against Titlecase item
    const resultsLower = filterLineage(mockLineageItems, { sectionKey: 'results' });
    expect(resultsLower).toHaveLength(1);
    expect(resultsLower[0]!.sectionKey).toBe('Results');

    // Uppercase query
    const discUpper = filterLineage(mockLineageItems, { sectionKey: 'DISCUSSION' });
    expect(discUpper).toHaveLength(1);
    expect(discUpper[0]!.sectionKey).toBe('Discussion');

    // Non-existent sectionKey returns empty array
    const conclusionMatches = filterLineage(mockLineageItems, { sectionKey: 'Conclusion' });
    expect(conclusionMatches).toEqual([]);
  });

  it('filters by evidenceId matching direct evidence id, externalId, or usedEvidenceIds', () => {
    // Match by evidence.id
    const matchByEvId = filterLineage(mockLineageItems, { evidenceId: 'ev-201' });
    expect(matchByEvId).toHaveLength(1);
    expect(matchByEvId[0]!.paragraphKey).toBe('para_intro_1');

    // Match by evidence.externalId
    const matchByEvExtId = filterLineage(mockLineageItems, { evidenceId: 'E-study-1-quote-1' });
    expect(matchByEvExtId).toHaveLength(1);
    expect(matchByEvExtId[0]!.paragraphKey).toBe('para_intro_1');

    // Match by secondary evidence in array
    const matchSecondEv = filterLineage(mockLineageItems, { evidenceId: 'ev-203' });
    expect(matchSecondEv).toHaveLength(1);
    expect(matchSecondEv[0]!.paragraphKey).toBe('para_results_1');

    // Match by usedEvidenceIds when evidence details array is empty
    const matchGhostEv = filterLineage(mockLineageItems, { evidenceId: 'ev-unresolved-ghost' });
    expect(matchGhostEv).toHaveLength(1);
    expect(matchGhostEv[0]!.paragraphKey).toBe('para_disc_1');

    // Non-matching evidenceId returns empty array
    const matchNone = filterLineage(mockLineageItems, { evidenceId: 'ev-does-not-exist' });
    expect(matchNone).toEqual([]);
  });

  it('filters by findingId matching direct finding id, externalId, or usedFindingIds', () => {
    // Match by finding.id
    const matchFindId = filterLineage(mockLineageItems, { findingId: 'find-101' });
    expect(matchFindId).toHaveLength(1);
    expect(matchFindId[0]!.paragraphKey).toBe('para_intro_1');

    // Match by finding.externalId
    const matchFindExtId = filterLineage(mockLineageItems, { findingId: 'F:study-2:speed' });
    expect(matchFindExtId).toHaveLength(1);
    expect(matchFindExtId[0]!.paragraphKey).toBe('para_intro_1');

    // Match finding in second item
    const matchFindProd = filterLineage(mockLineageItems, { findingId: 'F:study-3:productivity' });
    expect(matchFindProd).toHaveLength(1);
    expect(matchFindProd[0]!.paragraphKey).toBe('para_results_1');

    // Non-matching findingId returns empty array
    const matchNoFind = filterLineage(mockLineageItems, { findingId: 'find-unknown-999' });
    expect(matchNoFind).toEqual([]);
  });

  it('filters by sentence as case-insensitive substring in paragraph text or verbatim evidence quote', () => {
    // Substring in paragraph text (exact case)
    const textMatch1 = filterLineage(mockLineageItems, { sentence: 'rigorous traceability' });
    expect(textMatch1).toHaveLength(1);
    expect(textMatch1[0]!.paragraphKey).toBe('para_intro_1');

    // Substring in paragraph text (case-insensitive uppercase)
    const textMatch2 = filterLineage(mockLineageItems, { sentence: 'PRODUCTIVITY GAINS' });
    expect(textMatch2).toHaveLength(1);
    expect(textMatch2[0]!.paragraphKey).toBe('para_results_1');

    // Substring in evidence.quote
    const quoteMatch1 = filterLineage(mockLineageItems, { sentence: '45% productivity boost' });
    expect(quoteMatch1).toHaveLength(1);
    expect(quoteMatch1[0]!.paragraphKey).toBe('para_results_1');

    // Substring in evidence.quote (case-insensitive)
    const quoteMatch2 = filterLineage(mockLineageItems, { sentence: 'JUNIOR ENGINEERS BENEFITED' });
    expect(quoteMatch2).toHaveLength(1);
    expect(quoteMatch2[0]!.paragraphKey).toBe('para_results_1');

    // Non-matching sentence returns empty array
    const noSentenceMatch = filterLineage(mockLineageItems, { sentence: 'nonexistent quantum computing claim' });
    expect(noSentenceMatch).toEqual([]);
  });

  it('evaluates combined filters with AND logic across all specified criteria', () => {
    // Both sectionKey and findingId match
    const combo1 = filterLineage(mockLineageItems, {
      sectionKey: 'results',
      findingId: 'find-103',
    });
    expect(combo1).toHaveLength(1);
    expect(combo1[0]!.paragraphKey).toBe('para_results_1');

    // 3 matching criteria: sectionKey, sentence, evidenceId
    const combo2 = filterLineage(mockLineageItems, {
      sectionKey: 'Results',
      sentence: 'productivity boost',
      evidenceId: 'ev-202',
    });
    expect(combo2).toHaveLength(1);
    expect(combo2[0]!.paragraphKey).toBe('para_results_1');

    // Section matches but findingId belongs to another section -> returns empty array
    const comboMismatch = filterLineage(mockLineageItems, {
      sectionKey: 'Results',
      findingId: 'find-101', // belongs to Introduction
    });
    expect(comboMismatch).toEqual([]);

    // Section matches but sentence search fails -> returns empty array
    const comboSentenceMismatch = filterLineage(mockLineageItems, {
      sectionKey: 'Introduction',
      sentence: 'Junior engineers benefited',
    });
    expect(comboSentenceMismatch).toEqual([]);
  });

  it('returns all items when query is empty, and returns empty array when source list is empty', () => {
    const all = filterLineage(mockLineageItems, {});
    expect(all).toHaveLength(3);
    expect(all).toEqual(mockLineageItems);

    const empty = filterLineage([], { sectionKey: 'Results' });
    expect(empty).toEqual([]);
  });
});

// ============================================================================
// Suite 3: assembleSubmissionBundle (src/modules/export/package-assembler.ts)
// ============================================================================

describe('assembleSubmissionBundle (Pure Bundle Assembler)', () => {
  const createMockParams = (overrides?: {
    emptyTitle?: boolean;
    emptyStudies?: boolean;
    omitBlueprint?: boolean;
    runAtString?: boolean;
  }) => ({
    manuscriptId: 'ms-test-001',
    snapshot: {
      id: 'snap-corpus-2026',
      title: overrides?.emptyTitle ? '' : 'Empirical Analysis of LLM Assisted Software Synthesis',
      runId: 'run-slr-999',
      slrProjectId: 'proj-42',
      corpusHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      integrityHash: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      studies: overrides?.emptyStudies
        ? []
        : [
            {
              id: 'st-1',
              externalId: 'S-1',
              title: 'Empirical Study on LLMs in Coding',
              authors: ['Nguyen, A.', 'Smith, J.', 'Rahman, M.'],
              year: 2024,
              doi: '10.1109/TSE.2024.1234567',
              venue: 'IEEE Trans. Softw. Eng.',
            },
            {
              id: 'st-2',
              externalId: 'S-2',
              title: 'Developer Productivity and AI Assistants',
              authors: ['Barke, S.', 'Ziegler, A.'],
              year: 2023,
              doi: null,
              venue: 'ACM CHI',
            },
            {
              id: 'st-3',
              externalId: 'S-3',
              title: 'Legacy Refactoring Report',
              authors: [],
              year: null,
              doi: '10.1000/182',
              venue: null,
            },
          ],
    },
    journalProfile: {
      id: 'acm-tosem',
      version: 2,
      name: 'ACM Transactions on Software Engineering and Methodology',
      sections: [
        { key: 'abstract', order: 1, required: true },
        { key: 'introduction', order: 2, required: true },
        { key: 'methods', order: 3, required: true },
        { key: 'results', order: 4, required: true },
        { key: 'discussion', order: 5, required: true },
      ],
    },
    // Provided out of order to ensure assembleSubmissionBundle sorts by profile.order
    sections: [
      {
        sectionKey: 'results',
        latestRevision: {
          version: 2,
          markdown: '## Results\n\nLLM assistants provided noticeable productivity gains.',
          generator: 'section-drafter',
          contentHash: 'hash-res-2',
          createdAt: new Date('2026-11-04T09:00:00.000Z'),
        },
      },
      {
        sectionKey: 'abstract',
        latestRevision: {
          version: 1,
          markdown: '## Abstract\n\nThis review evaluates AI coding tools.',
          generator: 'section-drafter',
          contentHash: 'hash-abs-1',
          createdAt: new Date('2026-11-04T08:00:00.000Z'),
        },
      },
      {
        sectionKey: 'introduction',
        latestRevision: {
          version: 3,
          markdown: '## Introduction\n\nContext and scope of empirical evaluation.',
          generator: 'section-drafter',
          contentHash: 'hash-intro-3',
          createdAt: new Date('2026-11-04T08:30:00.000Z'),
        },
      },
      {
        sectionKey: 'methods',
        latestRevision: {
          version: 1,
          markdown: '## Methods\n\nPRISMA 2020 protocol was followed strictly.',
          generator: 'section-drafter',
          contentHash: 'hash-meth-1',
          createdAt: new Date('2026-11-04T08:45:00.000Z'),
        },
      },
      {
        sectionKey: 'appendix', // Extra section not explicitly present in journal profile
        latestRevision: {
          version: 1,
          markdown: '## Appendix\n\nSupplemental survey questionnaire.',
          generator: 'manual-author',
          contentHash: 'hash-app-1',
          createdAt: new Date('2026-11-04T09:30:00.000Z'),
        },
      },
      {
        sectionKey: 'discussion',
        latestRevision: {
          version: 1,
          markdown: '   \n  \n', // Blank markdown - should be safely omitted from manuscript
          generator: 'section-drafter',
          contentHash: 'hash-disc-empty',
          createdAt: new Date('2026-11-04T09:15:00.000Z'),
        },
      },
    ],
    verificationReport: {
      id: 'vr-1001',
      version: 1,
      status: 'PASSED',
      manifest: {
        totalCitations: 12,
        verifiedQuotes: 12,
        ungroundedCount: 0,
      },
      gates: [
        { gateId: 'G1', status: 'PASSED' },
        { gateId: 'G2', status: 'PASSED' },
      ],
      issues: [],
      summary: {
        passed: 7,
        warnings: 0,
        failed: 0,
        needsReview: 0,
        blockingIssuesCount: 0,
      },
      runAt: overrides?.runAtString ? '2026-11-04T10:00:00.000Z' : new Date('2026-11-04T10:00:00.000Z'),
    },
    approvals: [
      {
        id: 'appr-h1',
        seq: 1,
        stage: 'H1',
        targetKind: 'BLUEPRINT',
        targetId: 'bp-1',
        decision: 'APPROVED',
        note: 'Blueprint approved',
        decidedBy: 'user-lead',
        slrRole: 'OWNER',
        decidedAt: new Date('2026-11-04T08:00:00.000Z'),
      },
      {
        id: 'appr-h2',
        seq: 2,
        stage: 'H2',
        targetKind: 'SECTION',
        targetId: 'results',
        decision: 'APPROVED',
        note: null,
        decidedBy: 'user-lead',
        slrRole: 'OWNER',
        decidedAt: new Date('2026-11-04T09:30:00.000Z'),
      },
      {
        id: 'appr-h3',
        seq: 3,
        stage: 'H3',
        targetKind: 'MANUSCRIPT',
        targetId: 'ms-test-001',
        decision: 'APPROVED',
        note: 'Final submission package gate passed',
        decidedBy: 'user-owner',
        slrRole: 'OWNER',
        decidedAt: new Date('2026-11-04T10:15:00.000Z'),
      },
    ],
    blueprintRevision: overrides?.omitBlueprint
      ? null
      : {
          version: 1,
          profileId: 'acm-tosem',
          profileVersion: 2,
          origin: 'GENERATED',
          createdAt: new Date('2026-11-04T07:45:00.000Z'),
        },
    lineage: [
      {
        sectionKey: 'results',
        paragraphIndex: 0,
        paragraphKey: 'para_results_1',
        text: 'LLM assistants provided noticeable productivity gains.',
        usedFindingIds: ['find-1'],
        usedEvidenceIds: ['ev-1'],
        findings: [
          {
            id: 'find-1',
            externalId: 'F1',
            fieldName: 'speedup',
            sectionName: 'Results',
            valueText: '2x faster',
          },
        ],
        evidence: [
          {
            id: 'ev-1',
            externalId: 'E1',
            studyId: 'st-1',
            quote: 'Developers finished twice as fast.',
            quoteHashVerified: true,
            page: 3,
            section: '2.1',
            paragraph: 1,
          },
        ],
      },
    ],
    exportVersion: 1,
    exportedBy: 'analyst-jane',
  });

  it('assembles all 7 submission files in the manifest and zip archive', () => {
    const params = createMockParams();
    const result = assembleSubmissionBundle(params);

    const expectedFilenames = [
      'manuscript.md',
      'citation-manifest.json',
      'verification-report.json',
      'ai-disclosure.md',
      'revision-history.json',
      'evidence-lineage.json',
      'audit-metadata.json',
    ];

    expect(result.manifest).toHaveLength(7);
    expect(result.manifest.map((m) => m.filename)).toEqual(expectedFilenames);

    // Validate manifest item attributes
    for (const item of result.manifest) {
      expect(item.sizeBytes).toBeGreaterThan(0);
      expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof item.contentType).toBe('string');
      expect(item.contentType.length).toBeGreaterThan(0);
      expect(typeof item.description).toBe('string');
      expect(item.description.length).toBeGreaterThan(0);
    }

    // Validate that the zip buffer contains all 7 files and matches manifest sizes
    const parsedZip = parseAndExtractZip(result.zipBuffer);
    expect(parsedZip.totalEntries).toBe(7);
    expect(parsedZip.entries.map((e) => e.filename)).toEqual(expectedFilenames);

    for (let i = 0; i < 7; i++) {
      const manifestItem = result.manifest[i]!;
      const zipEntry = parsedZip.entries[i]!;
      expect(zipEntry.uncompressedSize).toBe(manifestItem.sizeBytes);
      const computedHash = createHash('sha256').update(zipEntry.uncompressedData).digest('hex');
      expect(computedHash).toBe(manifestItem.sha256);
    }
  });

  it('verifies manuscript.md orders sections by profile order, formats title, and builds numbered references', () => {
    const params = createMockParams();
    const result = assembleSubmissionBundle(params);

    const manuscript = result.bundle['manuscript'] as string;
    expect(typeof manuscript).toBe('string');

    // Title format
    expect(manuscript.startsWith('# Empirical Analysis of LLM Assisted Software Synthesis\n\n')).toBe(true);

    // Section ordering: abstract (1) -> introduction (2) -> methods (3) -> results (4)
    const abstractIdx = manuscript.indexOf('## Abstract');
    const introIdx = manuscript.indexOf('## Introduction');
    const methodsIdx = manuscript.indexOf('## Methods');
    const resultsIdx = manuscript.indexOf('## Results');
    const appendixIdx = manuscript.indexOf('## Appendix');
    const referencesIdx = manuscript.indexOf('## References');

    expect(abstractIdx).toBeGreaterThan(-1);
    expect(introIdx).toBeGreaterThan(abstractIdx);
    expect(methodsIdx).toBeGreaterThan(introIdx);
    expect(resultsIdx).toBeGreaterThan(methodsIdx);
    // Non-profile section 'appendix' appears after profile sections, before references
    expect(appendixIdx).toBeGreaterThan(resultsIdx);
    expect(referencesIdx).toBeGreaterThan(appendixIdx);

    // Blank section 'discussion' was excluded
    expect(manuscript).not.toContain('## Discussion');

    // Numbered bibliography check
    expect(manuscript).toContain('1. Nguyen, A., Smith, J., Rahman, M. (2024) "Empirical Study on LLMs in Coding". *IEEE Trans. Softw. Eng.* https://doi.org/10.1109/TSE.2024.1234567');
    expect(manuscript).toContain('2. Barke, S., Ziegler, A. (2023) "Developer Productivity and AI Assistants". *ACM CHI*');
    expect(manuscript).toContain('3. Unknown Authors (n.d.) "Legacy Refactoring Report". https://doi.org/10.1000/182');
  });

  it('handles fallback title and empty study corpus in manuscript.md', () => {
    const params = createMockParams({ emptyTitle: true, emptyStudies: true });
    const result = assembleSubmissionBundle(params);

    const manuscript = result.bundle['manuscript'] as string;
    // Fallback title
    expect(manuscript.startsWith('# Systematic Literature Review Manuscript\n\n')).toBe(true);
    // Empty studies corpus note
    expect(manuscript).toContain('*No primary studies registered in this review corpus.*');
  });

  it('calculates a valid, deterministic packageHash for the bundle', () => {
    const params = createMockParams();
    const result = assembleSubmissionBundle(params);

    expect(result.packageHash).toMatch(/^[a-f0-9]{64}$/);

    // Reconstruct packageHash exactly as assembleSubmissionBundle does
    const manifestStr = result.manifest.map((m) => `${m.filename}:${m.sha256}`).join('|');
    const zipHash = createHash('sha256').update(result.zipBuffer).digest('hex');
    const expectedPackageHash = createHash('sha256').update(`${manifestStr}|zip:${zipHash}`).digest('hex');

    expect(result.packageHash).toBe(expectedPackageHash);
    expect(result.bundle['packageHash']).toBe(result.packageHash);
  });

  it('verifies zipBuffer starts with PKZIP signature 0x04034b50 (PK\\x03\\x04)', () => {
    const params = createMockParams();
    const result = assembleSubmissionBundle(params);

    expect(Buffer.isBuffer(result.zipBuffer)).toBe(true);
    expect(result.zipBuffer.length).toBeGreaterThan(0);
    // Signature PK\x03\x04
    expect(result.zipBuffer[0]).toBe(0x50); // 'P'
    expect(result.zipBuffer[1]).toBe(0x4b); // 'K'
    expect(result.zipBuffer[2]).toBe(0x03);
    expect(result.zipBuffer[3]).toBe(0x04);
  });

  it('populates ai-disclosure.md with ICMJE/COPE compliance and journal profile details', () => {
    const params = createMockParams();
    const result = assembleSubmissionBundle(params);

    const aiDisclosure = result.bundle['aiDisclosure'] as string;
    expect(aiDisclosure).toContain('ICMJE');
    expect(aiDisclosure).toContain('COPE');
    expect(aiDisclosure).toContain('ACM Transactions on Software Engineering and Methodology');
    expect(aiDisclosure).toContain('acm-tosem');
    expect(aiDisclosure).toContain('snap-corpus-2026');
    expect(aiDisclosure).toContain('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    expect(aiDisclosure).toContain('H1 Outline Approval');
    expect(aiDisclosure).toContain('H2 Section Draft Approval');
    expect(aiDisclosure).toContain('H3 Final Submission Approval');
  });

  it('populates revision-history.json and handles blueprintRevision present and null', () => {
    // 1. With blueprintRevision present
    const paramsWithBp = createMockParams();
    const resultWithBp = assembleSubmissionBundle(paramsWithBp);
    const parsedRevWithBp = parseAndExtractZip(resultWithBp.zipBuffer);
    const revHistFile1 = parsedRevWithBp.entries.find((e) => e.filename === 'revision-history.json')!;
    const revHistJson1 = JSON.parse(revHistFile1.uncompressedData.toString('utf8'));

    expect(revHistJson1.manuscriptId).toBe('ms-test-001');
    expect(revHistJson1.blueprint).not.toBeNull();
    expect(revHistJson1.blueprint.profileId).toBe('acm-tosem');
    expect(revHistJson1.blueprint.version).toBe(1);
    expect(revHistJson1.sections).toHaveLength(6);
    expect(revHistJson1.approvals).toHaveLength(3);

    // 2. With blueprintRevision = null
    const paramsNoBp = createMockParams({ omitBlueprint: true });
    const resultNoBp = assembleSubmissionBundle(paramsNoBp);
    const parsedRevNoBp = parseAndExtractZip(resultNoBp.zipBuffer);
    const revHistFile2 = parsedRevNoBp.entries.find((e) => e.filename === 'revision-history.json')!;
    const revHistJson2 = JSON.parse(revHistFile2.uncompressedData.toString('utf8'));

    expect(revHistJson2.blueprint).toBeNull();
  });

  it('populates audit-metadata.json and formats verificationReport runAt date or string', () => {
    // With Date object for runAt
    const paramsDate = createMockParams({ runAtString: false });
    const resultDate = assembleSubmissionBundle(paramsDate);
    const parsedDate = parseAndExtractZip(resultDate.zipBuffer);
    const auditFile = parsedDate.entries.find((e) => e.filename === 'audit-metadata.json')!;
    const auditJson = JSON.parse(auditFile.uncompressedData.toString('utf8'));

    expect(auditJson.exportVersion).toBe(1);
    expect(auditJson.exportedBy).toBe('analyst-jane');
    expect(auditJson.snapshot.id).toBe('snap-corpus-2026');
    expect(auditJson.journalProfile.name).toBe('ACM Transactions on Software Engineering and Methodology');
    expect(auditJson.verificationStatus).toBe('PASSED');

    // With ISO string for runAt
    const paramsStr = createMockParams({ runAtString: true });
    const resultStr = assembleSubmissionBundle(paramsStr);
    const parsedStr = parseAndExtractZip(resultStr.zipBuffer);
    const vrFile = parsedStr.entries.find((e) => e.filename === 'verification-report.json')!;
    const vrJson = JSON.parse(vrFile.uncompressedData.toString('utf8'));
    expect(vrJson.runAt).toBe('2026-11-04T10:00:00.000Z');
  });

  it('aggregates lineage summary accurately in the bundle object', () => {
    const params = createMockParams();
    const result = assembleSubmissionBundle(params);

    const lineageSummary = result.bundle['lineageSummary'] as {
      totalParagraphs: number;
      paragraphsWithFindings: number;
      paragraphsWithEvidence: number;
    };

    expect(lineageSummary).toEqual({
      totalParagraphs: 1,
      paragraphsWithFindings: 1,
      paragraphsWithEvidence: 1,
    });
  });
});
