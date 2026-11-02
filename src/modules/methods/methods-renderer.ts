import { toVisibleLine } from '../../shared/utils/invisible-text.js';
import type { Fact, FactItem, MethodsDraft } from './methods.types.js';

/**
 * Layer 2 of the Methods section: wording. This is a fixed English template over the facts of layer 1.
 * Every number in the output is copied from a fact, and a fact the snapshot does not have is reported as not reported,
 * never filled in. A model that writes prose later replaces this file and must pass the same grounding check.
 */

// Text from slr-be is written by people. Keep it on one line and stop Markdown or HTML in it from taking effect:
// - control and zero-width characters are removed, whitespace is collapsed to single spaces;
// - '&' is escaped first, so an entity such as '&#49;' stays literal text instead of becoming a character;
// - inline markers are escaped, and so is a marker that would start a block (heading, quote, list, rule, fence, table).
const clean = (value: string): string => {
  const flat = toVisibleLine(value).trim();
  const inline = flat
    .replace(/&/g, '&amp;')
    .replace(/[\\`*_[\]~]/g, (char) => `\\${char}`)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return inline
    .replace(/^([#+\-=|])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2');
};

const joinList = (parts: string[]): string =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

const sentence = (value: string): string => (/[.!?]$/.test(value) ? value : `${value}.`);

const itemText = (item: FactItem): string => clean(item.id ? `${item.id}: ${item.text}` : item.text);

export function renderMethods(facts: Fact[]): MethodsDraft {
  const byKey = new Map(facts.map((fact) => [fact.key, fact]));
  const used = new Set<string>();
  const use = (key: string): Fact => {
    const fact = byKey.get(key);
    if (!fact) throw new Error(`The Methods template needs the fact ${key}, which was not extracted`);
    used.add(key);
    return fact;
  };
  const count = (key: string): number | undefined => {
    const fact = use(key);
    return fact.status === 'explicit' && typeof fact.value === 'number' ? fact.value : undefined;
  };
  const items = (key: string): FactItem[] | undefined => {
    const fact = use(key);
    return fact.status === 'explicit' && Array.isArray(fact.value) ? fact.value : undefined;
  };

  const out: string[] = ['## Methods', ''];
  const paragraph = (...lines: string[]) => { out.push(...lines, ''); };
  const bullets = (list: FactItem[]) => list.map((item) => `- ${itemText(item)}`);

  // Review questions
  out.push('### Review questions', '');
  const questions = items('rq.items');
  if (questions) paragraph('The review addressed the following research questions:', '', ...bullets(questions));
  else paragraph('The research questions were not recorded in the review protocol.');

  // Eligibility criteria
  out.push('### Eligibility criteria', '');
  const inclusion = items('criteria.inclusion');
  const exclusion = items('criteria.exclusion');
  if (inclusion) paragraph('Studies were included if they met the following criteria:', '', ...bullets(inclusion));
  else paragraph('The inclusion criteria were not recorded in the review protocol.');
  if (exclusion) paragraph('Studies were excluded if they met the following criteria:', '', ...bullets(exclusion));
  else paragraph('The exclusion criteria were not recorded in the review protocol.');

  const picocLabels: Array<[string, string]> = [
    ['population', 'Population'], ['intervention', 'Intervention'], ['comparison', 'Comparison'], ['outcome', 'Outcome'], ['context', 'Context'],
  ];
  const picoc = picocLabels.flatMap(([part, label]) => {
    const list = items(`picoc.${part}`);
    return list ? [`${label}: ${list.map((item) => clean(item.text)).join('; ')}`] : [];
  });
  if (picoc.length > 0) paragraph('The review question was framed with the PICOC elements below.', '', ...picoc.map((line) => `- ${line}`));

  // Information sources
  out.push('### Information sources and search', '');
  const sources = items('search.sources');
  if (sources) paragraph(sentence(`The following sources were searched: ${joinList(sources.map((source) => clean(source.text)))}`));
  else paragraph('The databases and other sources that were searched were not reported in the review record.');

  // Study selection, from the PRISMA flow. Only counts that exist are stated; the rest are listed as not reported.
  out.push('### Study selection', '');
  const notReported: string[] = [];
  const num = (key: string): number | undefined => {
    const value = count(key);
    if (value === undefined) notReported.push((byKey.get(key)?.label ?? key).toLowerCase());
    return value;
  };
  const selection: string[] = [];

  const fromDatabases = num('prisma.identified.databases');
  const fromOther = num('prisma.identified.otherMethods');
  const unclassified = num('prisma.identified.unclassified');
  const identified = [
    fromDatabases !== undefined ? `from databases and registers (n = ${fromDatabases})` : '',
    fromOther !== undefined ? `from other methods (n = ${fromOther})` : '',
    unclassified !== undefined ? `without a recorded source (n = ${unclassified})` : '',
  ].filter(Boolean);
  if (identified.length > 0) selection.push(sentence(`Records were identified ${joinList(identified)}`));

  const duplicates = num('prisma.removed.duplicates');
  const automation = num('prisma.removed.automation');
  const otherRemoved = num('prisma.removed.otherReasons');
  const removed = [
    duplicates !== undefined ? `${duplicates} duplicate records` : '',
    automation !== undefined ? `${automation} records flagged by automation tools` : '',
    otherRemoved !== undefined ? `${otherRemoved} records for other reasons` : '',
  ].filter(Boolean);
  if (removed.length > 0) selection.push(sentence(`Before screening, ${joinList(removed)} were removed`));

  const screened = num('prisma.screened');
  const excludedScreening = num('prisma.excludedScreening');
  if (screened !== undefined) {
    selection.push(excludedScreening !== undefined
      ? sentence(`A total of ${screened} records were screened and ${excludedScreening} were excluded`)
      : sentence(`A total of ${screened} records were screened`));
  } else if (excludedScreening !== undefined) {
    selection.push(sentence(`A total of ${excludedScreening} records were excluded at screening`));
  }

  const sought = num('prisma.sought');
  const notRetrieved = num('prisma.notRetrieved');
  if (sought !== undefined) {
    selection.push(notRetrieved !== undefined
      ? sentence(`A total of ${sought} reports were sought for retrieval, of which ${notRetrieved} could not be retrieved`)
      : sentence(`A total of ${sought} reports were sought for retrieval`));
  } else if (notRetrieved !== undefined) {
    selection.push(sentence(`A total of ${notRetrieved} reports could not be retrieved`));
  }

  const assessed = num('prisma.assessed');
  if (assessed !== undefined) selection.push(sentence(`A total of ${assessed} reports were assessed for eligibility`));

  const excludedReports = items('prisma.excludedFullText');
  if (excludedReports === undefined) {
    notReported.push((byKey.get('prisma.excludedFullText')?.label ?? '').toLowerCase());
  } else if (excludedReports.length === 0) {
    selection.push('No reports were excluded after full-text assessment with a recorded reason.');
  } else {
    selection.push(sentence(`Reports were excluded after full-text assessment for the following reasons: ${joinList(
      excludedReports.map((entry) => `${clean(entry.text)} (n = ${entry.count ?? 0})`),
    )}`));
  }

  const includedStudies = num('prisma.included');
  const reportsOfIncluded = num('prisma.reportsOfIncluded');
  if (includedStudies !== undefined) {
    selection.push(reportsOfIncluded !== undefined
      ? sentence(`A total of ${includedStudies} studies were included in the review, described in ${reportsOfIncluded} reports`)
      : sentence(`A total of ${includedStudies} studies were included in the review`));
  } else if (reportsOfIncluded !== undefined) {
    selection.push(sentence(`The included studies were described in ${reportsOfIncluded} reports`));
  }

  if (selection.length > 0) paragraph(selection.join(' '));
  if (notReported.length > 0) {
    paragraph(sentence(`The review record does not report the following counts: ${joinList(notReported)}`));
  } else if (selection.length === 0) {
    paragraph('The review record contains no study selection counts.');
  }

  // Data extraction and quality assessment
  out.push('### Data extraction and quality assessment', '');
  const extractionTotal = count('extraction.total');
  const extractionDone = count('extraction.completed');
  const qualityAssessed = count('quality.assessed');
  const extractionLines: string[] = [];
  if (extractionTotal !== undefined && extractionDone !== undefined) {
    extractionLines.push(sentence(`Data were extracted for ${extractionDone} of the ${extractionTotal} studies selected for extraction`));
  } else {
    extractionLines.push('The data extraction status of the selected studies was not reported in the review record.');
  }
  if (qualityAssessed === undefined) {
    extractionLines.push('The quality assessment status of the selected studies was not reported in the review record.');
  } else if (qualityAssessed === 0) {
    extractionLines.push('No quality assessment was recorded for the included studies.');
  } else {
    extractionLines.push(sentence(`A quality assessment was recorded for ${qualityAssessed} of the included studies`));
  }
  paragraph(extractionLines.join(' '));

  // Characteristics of the studies
  out.push('### Characteristics of the included studies', '');
  const corpusStudies = count('studies.included') ?? 0;
  const yearRange = use('studies.yearRange');
  const years = yearRange.status === 'explicit' && typeof yearRange.value === 'string' ? yearRange.value : undefined;
  paragraph(years
    ? sentence(`The review corpus contains ${corpusStudies} studies, published during ${years}`)
    : sentence(`The review corpus contains ${corpusStudies} studies. Their publication years were not reported`));

  return { markdown: `${out.join('\n').trimEnd()}\n`, facts, usedFactKeys: [...used].sort() };
}
