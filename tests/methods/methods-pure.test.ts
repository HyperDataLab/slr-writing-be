import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractMethodsFacts } from '../../src/modules/methods/methods-facts.js';
import { findUngroundedNumbers, groundedNumbers } from '../../src/modules/methods/methods-grounding.js';
import { renderMethods } from '../../src/modules/methods/methods-renderer.js';
import type { Fact, MethodsInput } from '../../src/modules/methods/methods.types.js';

// Pure functions: no database, no network.
const real = JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));
const realInput = (): MethodsInput => ({
  a10: structuredClone(real.artifacts.A10), a2: structuredClone(real.artifacts.A2),
  prismaExport: structuredClone(real.supplements.prisma_writing_export), studyCount: real.corpus.studies.length,
});
const empty = (): MethodsInput => ({ a10: undefined, a2: undefined, prismaExport: undefined, studyCount: 0 });
const fact = (facts: Fact[], key: string) => facts.find((item) => item.key === key)!;
const render = (input: MethodsInput) => { const facts = extractMethodsFacts(input); return { facts, ...renderMethods(facts) }; };

describe('extractMethodsFacts on a real slr-be run', () => {
  const facts = extractMethodsFacts(realInput());

  it('reads the protocol', () => {
    expect(fact(facts, 'rq.items').value).toHaveLength(3);
    expect(fact(facts, 'rq.items').value).toContainEqual({ id: 'RQ1', text: 'Which LLM-based tools are evaluated for code generation and program repair?' });
    expect(fact(facts, 'criteria.inclusion').value).toEqual([{ id: 'IC1', text: 'Empirically evaluates LLM-based code generation, repair or developer productivity.' }]);
    expect(fact(facts, 'picoc.intervention').value).toHaveLength(3);
  });

  it('reads the PRISMA flow, keeping a zero as a zero and a null as missing', () => {
    expect(fact(facts, 'prisma.screened')).toMatchObject({ status: 'explicit', value: 6, source: 'prisma_writing_export.flow.recordsScreened' });
    expect(fact(facts, 'prisma.removed.duplicates')).toMatchObject({ status: 'explicit', value: 0 });
    expect(fact(facts, 'prisma.removed.automation')).toMatchObject({ status: 'missing', value: null });
    expect(fact(facts, 'prisma.reportsOfIncluded')).toMatchObject({ status: 'missing', value: null });
  });

  it('marks what the review record lacks as missing instead of guessing', () => {
    expect(fact(facts, 'search.sources')).toMatchObject({ status: 'missing', value: null });
  });

  it('counts studies and extraction, and says quality was not assessed', () => {
    expect(fact(facts, 'studies.included').value).toBe(6);
    expect(fact(facts, 'extraction.total').value).toBe(6);
    expect(fact(facts, 'extraction.completed').value).toBe(6);
    expect(fact(facts, 'quality.assessed').value).toBe(0);
  });

  it('derives the year range and says how', () => {
    expect(fact(facts, 'studies.yearRange')).toMatchObject({ value: '2021–2024', derivation: expect.stringContaining('minimum') });
  });

  it('gives every fact a source, and a value exactly when it is explicit', () => {
    for (const item of facts) {
      expect(item.source.length).toBeGreaterThan(0);
      expect(item.value === null).toBe(item.status === 'missing');
    }
  });

  it('has unique keys', () => {
    expect(new Set(facts.map((item) => item.key)).size).toBe(facts.length);
  });
});

describe('extractMethodsFacts on degenerate input', () => {
  it('turns an empty snapshot into missing facts, except the study count it always knows', () => {
    const facts = extractMethodsFacts(empty());
    expect(facts.filter((item) => item.status === 'explicit').map((item) => item.key)).toEqual(['studies.included']);
  });

  it.each([[-1], [1.5], ['6'], [null], [undefined], [NaN], [Infinity], [[]], [{}]])('treats %j as a missing count', (bad) => {
    const input = realInput();
    (input.prismaExport as any).flow.recordsScreened = bad;
    expect(fact(extractMethodsFacts(input), 'prisma.screened').status).toBe('missing');
  });

  it('survives wrong types anywhere in the payloads', () => {
    for (const junk of [null, 'text', 42, [], true]) {
      const input: MethodsInput = { a10: { protocol: junk, search_strategy: junk, selected_studies: junk } as any, a2: { distributions: junk } as any, prismaExport: { flow: junk } as any, studyCount: 2 };
      expect(() => render(input)).not.toThrow();
    }
  });

  it('ignores entries without usable text and keeps the rest', () => {
    const input = realInput();
    (input.a10 as any).protocol.research_questions = [{ code: 'RQ9' }, null, 'x', { question: '   ' }, { code: 'RQ2', question: 'Kept?' }];
    expect(fact(extractMethodsFacts(input), 'rq.items').value).toEqual([{ id: 'RQ2', text: 'Kept?' }]);
  });

  it('reads search sources of unknown shape without inventing a name', () => {
    const input = realInput();
    (input.a10 as any).search_strategy.sources = [{ source_id: 's1', name: 'Scopus' }, { source_id: 's2' }, { database: 'IEEE Xplore' }, {}, 7];
    expect(fact(extractMethodsFacts(input), 'search.sources').value).toEqual([{ id: 's1', text: 'Scopus' }, { text: 's2' }, { text: 'IEEE Xplore' }]);
  });

  it('keeps exclusion reasons with their counts and ignores malformed ones', () => {
    const input = realInput();
    (input.prismaExport as any).flow.reportsExcluded = [{ reason: 'Wrong population', count: 3 }, { reason: 'x', count: -1 }, { count: 2 }, null];
    expect(fact(extractMethodsFacts(input), 'prisma.excludedFullText').value).toEqual([{ text: 'Wrong population', count: 3 }]);
  });

  it('counts quality assessment from the study statuses', () => {
    const input = realInput();
    (input.a10 as any).selected_studies[0].quality_status = 'ASSESSED';
    (input.a10 as any).selected_studies[1].quality_status = 'LOW';
    expect(fact(extractMethodsFacts(input), 'quality.assessed').value).toBe(2);
  });

  it('is deterministic', () => {
    expect(extractMethodsFacts(realInput())).toEqual(extractMethodsFacts(realInput()));
  });
});

describe('renderMethods', () => {
  it('writes every section for the real run, with numbers copied from the facts', () => {
    const { markdown } = render(realInput());
    for (const heading of ['## Methods', '### Review questions', '### Eligibility criteria', '### Information sources and search', '### Study selection', '### Data extraction and quality assessment', '### Characteristics of the included studies']) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain('- RQ1: Which LLM-based tools');
    expect(markdown).toContain('from databases and registers (n = 0), from other methods (n = 0) and without a recorded source (n = 6)');
    expect(markdown).toContain('A total of 6 records were screened and 0 were excluded.');
    expect(markdown).toContain('published during 2021–2024');
    expect(markdown).toContain('No quality assessment was recorded');
  });

  it('says what is not reported instead of filling it in', () => {
    const { markdown } = render(realInput());
    expect(markdown).toContain('The databases and other sources that were searched were not reported');
    expect(markdown).toContain('records removed by automation tools');
  });

  it('with nothing but a study count, reports everything else as not reported and invents no number', () => {
    const { markdown, facts } = render({ ...empty(), studyCount: 4 });
    expect(markdown).toContain('The research questions were not recorded');
    expect(markdown).toContain('Their publication years were not reported');
    expect(markdown).toContain('The review corpus contains 4 studies');
    expect(findUngroundedNumbers(markdown, facts)).toEqual([]);
    expect(markdown.match(/\d+/g)).toEqual(['4']);
  });

  it('is deterministic and ends with one newline', () => {
    const a = render(realInput()).markdown; const b = render(realInput()).markdown;
    expect(a).toBe(b);
    expect(a.endsWith('\n') && !a.endsWith('\n\n')).toBe(true);
  });

  it('records which facts it used, and uses every fact for the real run', () => {
    const { usedFactKeys, facts } = render(realInput());
    expect(usedFactKeys).toEqual(facts.map((item) => item.key).sort());
  });

  it('stops text from the review record turning into Markdown or HTML', () => {
    const input = realInput();
    (input.a10 as any).protocol.research_questions = [{ code: 'RQ1', question: 'Is <script>alert(1)</script> **bold** `code` [link](http://x) _it_\n\n# heading?' }];
    const { markdown } = render(input);
    expect(markdown).not.toContain('<script>');
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).toContain('\\*\\*bold\\*\\*');
    expect(markdown).toContain('\\`code\\`');
    expect(markdown).toContain('\\[link\\]');
    const line = markdown.split('\n').find((row) => row.startsWith('- RQ1'))!;
    expect(line).toContain('heading?');
    expect(markdown.split('\n').filter((row) => row.startsWith('# heading'))).toEqual([]);
  });

  it('does not let a research question add a number the review record does not hold', () => {
    const input = realInput();
    (input.a10 as any).protocol.research_questions = [{ code: 'RQ1', question: 'Does it help 87% of users?' }];
    const { markdown, facts } = render(input);
    expect(findUngroundedNumbers(markdown, facts)).toEqual([]); // 87 comes from the record itself, so it is grounded
  });

  it('handles exclusion reasons, a single count and a list of one', () => {
    const input = realInput();
    (input.prismaExport as any).flow.reportsExcluded = [{ reason: 'Wrong population', count: 2 }, { reason: 'No full text', count: 1 }];
    const { markdown, facts } = render(input);
    expect(markdown).toContain('Wrong population (n = 2) and No full text (n = 1)');
    expect(findUngroundedNumbers(markdown, facts)).toEqual([]);
  });
});

describe('grounding check', () => {
  const factsOf = () => extractMethodsFacts(realInput());

  it('accepts the template output for the real run', () => {
    const { markdown, facts } = render(realInput());
    expect(findUngroundedNumbers(markdown, facts)).toEqual([]);
  });

  it('reports a number that no fact holds', () => {
    const { markdown, facts } = render(realInput());
    expect(findUngroundedNumbers(`${markdown}\nIn addition 4821 records were found.`, facts)).toEqual(['4821']);
  });

  it('catches a changed number inside a sentence', () => {
    const { markdown, facts } = render(realInput());
    expect(findUngroundedNumbers(markdown.replace('A total of 6 records were screened', 'A total of 7 records were screened'), facts)).toEqual(['7']);
    expect(findUngroundedNumbers(markdown.replace('A total of 6 records were screened', 'A total of 63 records were screened'), facts)).toEqual(['63']);
  });

  it('treats 007 and 7 as different, and ignores facts that are missing', () => {
    const facts = factsOf();
    expect(findUngroundedNumbers('about 007 items', facts)).toEqual(['007']);
    const allowed = groundedNumbers(facts);
    expect(allowed.has('6')).toBe(true);
    expect(allowed.has('2021')).toBe(true);
  });

  it('counts digits inside words and decimals as separate runs, so 3.5 needs both 3 and 5 to be grounded', () => {
    const facts: Fact[] = [{ key: 'a', label: 'a', status: 'explicit', value: 3, source: 's' }];
    expect(findUngroundedNumbers('value 3.5', facts)).toEqual(['5']);
  });

  it('known limit: a number written as a word is not seen', () => {
    expect(findUngroundedNumbers('Forty-two records were screened.', [])).toEqual([]);
  });
});
