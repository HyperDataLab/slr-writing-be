import { showsNothing } from '../../shared/utils/invisible-text.js';
import type { Fact, FactItem, MethodsInput } from './methods.types.js';

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): Json => (isRecord(value) ? value : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
// A safe integer, so a huge value never reaches the text in exponent notation (1e+21).
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// Text that shows nothing (only spaces, control or zero-width characters) is not text.
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && !showsNothing(value) ? value.trim() : undefined;

// A publication year label must be exactly four digits, never a number in disguise such as '0x7E5', '1e3' or [2021].
const YEAR_LABEL = /^[1-9]\d{3}$/;

const explicit = (key: string, label: string, value: Fact['value'], source: string, derivation?: string): Fact => ({
  key, label, status: 'explicit', value, source, ...(derivation ? { derivation } : {}),
});
const missing = (key: string, label: string, source: string): Fact => ({ key, label, status: 'missing', value: null, source });

/** A list fact is explicit only when it has at least one usable entry. */
const listFact = (key: string, label: string, items: FactItem[], source: string): Fact =>
  items.length > 0 ? explicit(key, label, items, source) : missing(key, label, source);

const countFact = (key: string, label: string, value: unknown, source: string): Fact =>
  isCount(value) ? explicit(key, label, value, source) : missing(key, label, source);

const criteriaItems = (value: unknown): FactItem[] =>
  asArray(value).flatMap((entry) => {
    const record = asRecord(entry);
    const description = text(record.description);
    return description ? [{ ...(text(record.code) ? { id: text(record.code) } : {}), text: description }] : [];
  });

const stringItems = (value: unknown): FactItem[] => asArray(value).flatMap((entry) => (text(entry) ? [{ text: text(entry)! }] : []));

/** A search source is free-form in slr-be, so read only the common name fields and fall back to its id. */
const searchSourceItems = (value: unknown): FactItem[] =>
  asArray(value).flatMap((entry) => {
    const record = asRecord(entry);
    const id = text(record.source_id);
    const name = text(record.name) ?? text(record.database) ?? text(record.title) ?? text(record.label) ?? id;
    return name ? [{ ...(id && id !== name ? { id } : {}), text: name }] : [];
  });

/**
 * Turns a snapshot into the facts the Methods section is written from. A pure function: the same input always
 * gives the same facts, and a value the snapshot does not contain becomes a 'missing' fact, never a guess.
 */
export function extractMethodsFacts(input: MethodsInput): Fact[] {
  const protocol = asRecord(input.a10?.protocol);
  const picoc = asRecord(protocol.picoc);
  const flow = asRecord(input.prismaExport?.flow);
  const identified = asRecord(flow.recordsIdentified);
  const removed = asRecord(flow.recordsRemovedBeforeScreening);
  const prismaPath = 'prisma_writing_export.flow';

  const facts: Fact[] = [];

  facts.push(listFact('rq.items', 'Research questions',
    asArray(protocol.research_questions).flatMap((entry) => {
      const record = asRecord(entry);
      const question = text(record.question);
      return question ? [{ ...(text(record.code) ? { id: text(record.code) } : {}), text: question }] : [];
    }), 'A10.protocol.research_questions'));

  for (const part of ['population', 'intervention', 'comparison', 'outcome', 'context'] as const) {
    facts.push(listFact(`picoc.${part}`, `PICOC ${part}`, stringItems(picoc[part]), `A10.protocol.picoc.${part}`));
  }

  facts.push(listFact('criteria.inclusion', 'Inclusion criteria', criteriaItems(protocol.inclusion_criteria), 'A10.protocol.inclusion_criteria'));
  facts.push(listFact('criteria.exclusion', 'Exclusion criteria', criteriaItems(protocol.exclusion_criteria), 'A10.protocol.exclusion_criteria'));
  facts.push(listFact('search.sources', 'Search sources', searchSourceItems(asRecord(input.a10?.search_strategy).sources), 'A10.search_strategy.sources'));

  facts.push(countFact('prisma.identified.databases', 'Records identified from databases and registers', identified.databasesAndRegisters, `${prismaPath}.recordsIdentified.databasesAndRegisters`));
  facts.push(countFact('prisma.identified.otherMethods', 'Records identified from other methods', identified.otherMethods, `${prismaPath}.recordsIdentified.otherMethods`));
  facts.push(countFact('prisma.identified.unclassified', 'Records identified without a recorded source', identified.unclassified, `${prismaPath}.recordsIdentified.unclassified`));
  facts.push(countFact('prisma.removed.duplicates', 'Duplicate records removed', removed.duplicates, `${prismaPath}.recordsRemovedBeforeScreening.duplicates`));
  facts.push(countFact('prisma.removed.automation', 'Records removed by automation tools', removed.automation, `${prismaPath}.recordsRemovedBeforeScreening.automation`));
  facts.push(countFact('prisma.removed.otherReasons', 'Records removed for other reasons', removed.otherReasons, `${prismaPath}.recordsRemovedBeforeScreening.otherReasons`));
  facts.push(countFact('prisma.screened', 'Records screened', flow.recordsScreened, `${prismaPath}.recordsScreened`));
  facts.push(countFact('prisma.excludedScreening', 'Records excluded at screening', flow.recordsExcluded, `${prismaPath}.recordsExcluded`));
  facts.push(countFact('prisma.sought', 'Reports sought for retrieval', flow.reportsSoughtForRetrieval, `${prismaPath}.reportsSoughtForRetrieval`));
  facts.push(countFact('prisma.notRetrieved', 'Reports not retrieved', flow.reportsNotRetrieved, `${prismaPath}.reportsNotRetrieved`));
  facts.push(countFact('prisma.assessed', 'Reports assessed for eligibility', flow.reportsAssessedForEligibility, `${prismaPath}.reportsAssessedForEligibility`));

  // Reasons for excluding reports after full-text assessment: a list with counts, empty when nothing was excluded.
  // Explicit only when every entry is well formed. One broken entry means the list cannot be trusted, and a list with
  // dropped entries must never be read as "nothing was excluded".
  const excludedEntries = asArray(flow.reportsExcluded).map((entry) => {
    const record = asRecord(entry);
    const reason = text(record.reason);
    return reason && isCount(record.count) ? { text: reason, count: record.count } : undefined;
  });
  const excludedReports = excludedEntries.filter((entry): entry is { text: string; count: number } => entry !== undefined);
  facts.push(Array.isArray(flow.reportsExcluded) && excludedReports.length === excludedEntries.length
    ? explicit('prisma.excludedFullText', 'Reports excluded after full-text assessment, with reasons', excludedReports, `${prismaPath}.reportsExcluded`)
    : missing('prisma.excludedFullText', 'Reports excluded after full-text assessment, with reasons', `${prismaPath}.reportsExcluded`));

  facts.push(countFact('prisma.included', 'Studies included in the review', flow.studiesIncluded, `${prismaPath}.studiesIncluded`));
  facts.push(countFact('prisma.reportsOfIncluded', 'Reports of the included studies', flow.reportsOfIncludedStudies, `${prismaPath}.reportsOfIncludedStudies`));

  // Characteristics of the studies stored in the snapshot.
  facts.push(explicit('studies.included', 'Studies in the review corpus', input.studyCount, 'snapshot.studies'));
  // Only years that really have studies count, and a plain loop: spreading a long list into Math.min overflows the stack.
  let firstYear = Infinity;
  let lastYear = -Infinity;
  for (const entry of asArray(asRecord(input.a2?.distributions).by_year)) {
    const record = asRecord(entry);
    if (typeof record.label !== 'string' || !YEAR_LABEL.test(record.label) || !isCount(record.study_count) || record.study_count === 0) continue;
    const year = Number(record.label);
    if (year < firstYear) firstYear = year;
    if (year > lastYear) lastYear = year;
  }
  facts.push(Number.isFinite(firstYear)
    ? explicit('studies.yearRange', 'Publication years of the included studies', `${firstYear}–${lastYear}`, 'A2.distributions.by_year', 'minimum and maximum of the year labels that have studies')
    : missing('studies.yearRange', 'Publication years of the included studies', 'A2.distributions.by_year'));

  // Data extraction and quality assessment, counted from the studies A10 selected.
  const selected = asArray(input.a10?.selected_studies).filter(isRecord);
  if (selected.length > 0) {
    facts.push(explicit('extraction.total', 'Studies selected for data extraction', selected.length, 'A10.selected_studies'));
    facts.push(explicit('extraction.completed', 'Studies with completed data extraction',
      selected.filter((study) => asRecord(study.extraction).status === 'COMPLETED').length,
      'A10.selected_studies[].extraction.status', 'count of studies whose extraction status is COMPLETED'));
    facts.push(explicit('quality.assessed', 'Studies with a recorded quality assessment',
      selected.filter((study) => { const status = text(study.quality_status); return status !== undefined && status !== 'NOT_ASSESSED'; }).length,
      'A10.selected_studies[].quality_status', 'count of studies whose quality status is not NOT_ASSESSED'));
  } else {
    facts.push(missing('extraction.total', 'Studies selected for data extraction', 'A10.selected_studies'));
    facts.push(missing('extraction.completed', 'Studies with completed data extraction', 'A10.selected_studies'));
    facts.push(missing('quality.assessed', 'Studies with a recorded quality assessment', 'A10.selected_studies'));
  }

  return facts;
}
