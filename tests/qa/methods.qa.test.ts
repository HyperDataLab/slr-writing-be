import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractMethodsFacts } from '../../src/modules/methods/methods-facts.js';
import { findUngroundedNumbers, groundedNumbers } from '../../src/modules/methods/methods-grounding.js';
import { renderMethods } from '../../src/modules/methods/methods-renderer.js';
import type { Fact, MethodsInput } from '../../src/modules/methods/methods.types.js';

// QA (adversarial) tests of the pure layers of M2. No database.
const real = JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));
const realInput = (): MethodsInput => ({
  a10: structuredClone(real.artifacts.A10), a2: structuredClone(real.artifacts.A2),
  prismaExport: structuredClone(real.supplements.prisma_writing_export), studyCount: real.corpus.studies.length,
});
const fact = (facts: Fact[], key: string) => facts.find((item) => item.key === key)!;
const run = (input: MethodsInput) => { const facts = extractMethodsFacts(input); const draft = renderMethods(facts); return { facts, ...draft, ungrounded: findUngroundedNumbers(draft.markdown, facts) }; };
const withA10 = (mutate: (a10: any) => void) => { const input = realInput(); mutate(input.a10); return input; };
const withFlow = (mutate: (flow: any) => void) => { const input = realInput(); mutate((input.prismaExport as any).flow); return input; };
const withA2 = (mutate: (a2: any) => void) => { const input = realInput(); mutate(input.a2); return input; };
const lines = (markdown: string) => markdown.split('\n');

describe('facts: hostile payload shapes', () => {
  it('prototype-pollution keys from JSON.parse do not leak into facts or Object.prototype', () => {
    const a10 = JSON.parse('{"__proto__":{"protocol":{"research_questions":[{"code":"X","question":"polluted?"}]}},"constructor":{"prototype":{"polluted":1}},"protocol":{"__proto__":{"picoc":{"population":["P"]}},"research_questions":[{"__proto__":{"question":"q"},"code":"RQ1"}]}}');
    const { facts, ungrounded } = run({ a10, a2: undefined, prismaExport: undefined, studyCount: 0 });
    expect(fact(facts, 'rq.items').status).toBe('missing');
    expect(fact(facts, 'picoc.population').status).toBe('missing');
    expect(({} as any).polluted).toBeUndefined();
    expect(ungrounded).toEqual([]);
  });

  it('wrong types everywhere become missing, no throw', () => {
    for (const odd of [null, 1, 'str', true, [], [[[]]], { a: { b: { c: {} } } }]) {
      const input: MethodsInput = { a10: { protocol: odd, search_strategy: odd, selected_studies: odd } as any, a2: { distributions: odd } as any, prismaExport: { flow: odd } as any, studyCount: 0 };
      const { facts, markdown, ungrounded } = run(input);
      expect(ungrounded).toEqual([]);
      expect(markdown).toContain('## Methods');
      for (const item of facts.filter((f) => f.key !== 'studies.included')) expect(item.status, `${item.key} for ${JSON.stringify(odd)}`).toBe('missing');
    }
  });

  it('numeric-looking strings, NaN-like, negative, float and boolean counts are missing', () => {
    for (const odd of ['6', ' 6 ', '6.0', -1, 1.5, true, null, [6], { value: 6 }, '0x6', '']) {
      const { facts } = run(withFlow((flow) => { flow.recordsScreened = odd; }));
      expect(fact(facts, 'prisma.screened').status, JSON.stringify(odd)).toBe('missing');
    }
  });

  it('-0 is kept as an explicit zero and rendered as 0', () => {
    const { facts, markdown, ungrounded } = run(withFlow((flow) => { flow.recordsScreened = -0; }));
    expect(fact(facts, 'prisma.screened').status).toBe('explicit');
    expect(markdown).toContain('A total of 0 records were screened');
    expect(ungrounded).toEqual([]);
  });

  it('integers beyond 2**53 are not safe counts, so they are reported as not reported instead of being printed', () => {
    const { markdown, facts, ungrounded } = run(withFlow((flow) => { flow.recordsScreened = 2 ** 53 + 2; }));
    expect(fact(facts, 'prisma.screened').status).toBe('missing');
    expect(markdown).not.toContain(String(2 ** 53 + 2));
    expect(markdown).toContain('records screened');
    expect(ungrounded).toEqual([]);
  });

  it('a count of 1e21 is not written in exponent notation in a manuscript sentence', () => {
    const { markdown, ungrounded } = run(withFlow((flow) => { flow.recordsScreened = 1e21; }));
    expect(ungrounded).toEqual([]); // grounding is fooled into agreeing either way
    expect(markdown).not.toMatch(/\d e\+\d|\de\+\d/);
  });

  it('a huge by_year list (200k entries) does not crash year-range extraction', () => {
    const input = withA2((a2) => { a2.distributions.by_year = Array.from({ length: 200_000 }, (_, i) => ({ label: String(1900 + (i % 120)), study_count: 1 })); });
    expect(() => extractMethodsFacts(input)).not.toThrow();
  });

  it('year labels that are not plain year strings are not coerced into years', () => {
    for (const label of ['0x7E5', '1e3', true, [2021], '2021.0', '  2021  ']) {
      const { facts } = run(withA2((a2) => { a2.distributions.by_year = [{ label, study_count: 1 }]; }));
      const range = fact(facts, 'studies.yearRange');
      // Only the plain string '2021' (or the number 2021) is a year; others must not become a guessed range.
      if (label === '  2021  ') continue; // trimmed whitespace is arguably fine
      expect([range.status, range.value], JSON.stringify(label)).toEqual(['missing', null]);
    }
  });

  it('a year with study_count 0 does not widen the range', () => {
    const { facts } = run(withA2((a2) => { a2.distributions.by_year.push({ label: '1900', study_count: 0, study_ids: [] }); }));
    expect(fact(facts, 'studies.yearRange').value).toBe('2021–2024');
  });

  it('huge strings and a 10 MB list of sources render in reasonable time and stay grounded', () => {
    const input = withA10((a10) => {
      a10.search_strategy.sources = Array.from({ length: 100_000 }, (_, i) => ({ source_id: `s${i}`, name: `Database ${i} ${'x'.repeat(80)}` }));
      a10.protocol.research_questions = [{ code: 'RQ1', question: 'q'.repeat(5_000_000) }];
    });
    const started = Date.now();
    const { markdown, ungrounded } = run(input);
    // Alone this takes about 3 s; the limit is loose because the whole suite runs files in parallel on one machine.
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(markdown.length).toBeGreaterThan(10_000_000);
    expect(ungrounded).toEqual([]);
  });

  it('deeply nested values are ignored without stack overflow', () => {
    let deep: any = 'leaf';
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const { facts } = run(withA10((a10) => { a10.protocol.picoc.population = deep; a10.protocol.research_questions = deep; }));
    expect(fact(facts, 'picoc.population').status).toBe('missing');
  });

  it('an exclusion reason without a count must not turn into "no reports were excluded"', () => {
    const { facts, markdown } = run(withFlow((flow) => { flow.reportsExcluded = [{ reason: 'Not empirical' }, { reason: 'No full text', count: '2' }]; }));
    expect(markdown).not.toContain('No reports were excluded after full-text assessment');
    expect(fact(facts, 'prisma.excludedFullText').status).not.toBe('explicit');
  });

  it('a zero-width-only research question is not an explicit fact rendered as an empty bullet', () => {
    const { facts, markdown } = run(withA10((a10) => { a10.protocol.research_questions = [{ question: '​‌' }]; }));
    expect(fact(facts, 'rq.items').status).toBe('missing');
    expect(markdown).not.toMatch(/^- ​/m);
  });
});

describe('renderer: injection through user text', () => {
  const rq = (question: string, code?: string) => run(withA10((a10) => { a10.protocol.research_questions = [{ ...(code === undefined ? {} : { code }), question }]; }));

  it('links, images, emphasis, code and HTML are escaped', () => {
    const { markdown } = rq('[click](http://evil) ![img](x.png) **b** _i_ `code` <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(markdown).toContain('\\[click\\](http://evil) !\\[img\\](x.png) \\*\\*b\\*\\* \\_i\\_ \\`code\\` &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('<img');
  });

  it('newlines in text and code cannot start new blocks (front matter, fences, headings, tables)', () => {
    const { markdown } = rq('first\n---\ntitle: x\n---\n```js\nalert(1)\n```\n# H1\n| a | b |\n|---|---|', 'RQ1\n## Injected');
    const rqLines = lines(markdown).filter((line) => line.startsWith('- RQ1'));
    expect(rqLines).toHaveLength(1);
    expect(lines(markdown).filter((line) => line.startsWith('#')).every((line) => /^#{2,3} [A-Z]/.test(line) && !line.includes('Injected'))).toBe(true);
    expect(markdown).not.toMatch(/^```/m);
  });

  it('a leading # / > / 1. / ~~~ / --- in a list item is escaped so it stays plain text (CommonMark list-item content)', () => {
    for (const hostile of ['# Big heading', '> quoted', '1. nested', '~~~', '---', '+ x', '1) x']) {
      const { markdown } = rq(hostile);
      const line = lines(markdown).find((l) => l.startsWith('- ') && l.includes(hostile.slice(-1)))!;
      // After "- " a raw block marker would be parsed as a heading/blockquote/list/fence/thematic break inside the item.
      expect(line, hostile).not.toBe(`- ${hostile}`);
    }
  });

  it('html entities are neutralised so they do not render as other characters or digits', () => {
    const { markdown } = rq('&#49;&#50; studies &lt;b&gt; &amp;');
    // An unescaped & lets "&#49;&#50;" render as "12" while the grounding check sees only "49" and "50".
    expect(markdown).not.toContain('- &#49;&#50;');
  });

  it('GFM strikethrough is escaped', () => {
    const { markdown } = rq('~~struck~~ www.evil.example http://evil.example');
    expect(markdown).toContain('\\~\\~struck\\~\\~');
    expect(markdown).not.toContain('~~struck~~');
  });

  it('control characters and zero-width characters are removed from the text', () => {
    const { markdown } = rq('a\u0001b\u0000c\u200Bd\uFEFFe');
    expect(markdown).toContain('abcde');
    expect(markdown).not.toMatch(/[\u0000-\u0008\u200B\uFEFF]/);
  });

  it('unicode and RTL text survive byte for byte', () => {
    const text = 'Đánh giá مراجعة منهجية 系统综述 🚀';
    expect(rq(text).markdown).toContain(`- ${text}`);
  });

  it('every user field that reaches the output is escaped', () => {
    const evil = '<b>x</b> [l](u) *e*';
    const escaped = '&lt;b&gt;x&lt;/b&gt; \\[l\\](u) \\*e\\*';
    const input = withA10((a10) => {
      a10.protocol.research_questions = [{ code: evil, question: evil }];
      a10.protocol.inclusion_criteria = [{ code: evil, description: evil }];
      a10.protocol.exclusion_criteria = [{ code: evil, description: evil }];
      for (const part of ['population', 'intervention', 'comparison', 'outcome', 'context']) a10.protocol.picoc[part] = [evil];
      a10.search_strategy.sources = [{ source_id: evil, name: evil }];
    });
    (input.prismaExport as any).flow.reportsExcluded = [{ reason: evil, count: 1 }];
    const { markdown } = run(input);
    expect(markdown).not.toContain('<b>');
    expect(markdown).not.toMatch(/(?<!\\)\[l/);
    expect(markdown.split(escaped).length - 1).toBeGreaterThanOrEqual(1 + 1 + 1 + 1 + 1 + 1 + 5);
  });

  it('a very long single line is kept on one line', () => {
    const { markdown } = rq('w '.repeat(200_000));
    expect(lines(markdown).some((line) => line.length > 300_000)).toBe(true);
  });
});

describe('grounding check', () => {
  it('digits in user text are grounded because they are in facts', () => {
    const { ungrounded, markdown } = run(withA10((a10) => { a10.protocol.research_questions = [{ code: 'RQ7', question: 'Is 87% of 2019 code buggy?' }]; }));
    expect(markdown).toContain('87%');
    expect(ungrounded).toEqual([]);
  });

  it('the template itself never emits an ungrounded number across many odd inputs', () => {
    const variants: Array<(i: MethodsInput) => void> = [
      (i) => { i.prismaExport = undefined; },
      (i) => { i.a2 = undefined; },
      (i) => { i.a10 = {}; },
      (i) => { (i.prismaExport as any).flow.reportsExcluded = [{ reason: 'r', count: 0 }, { reason: 's', count: 12345 }]; },
      (i) => { i.studyCount = 0; },
      (i) => { i.studyCount = 999999; },
      (i) => { (i.a10 as any).selected_studies = []; },
      (i) => { (i.a2 as any).distributions.by_year = [{ label: '2024' }]; },
    ];
    for (const change of variants) {
      const input = realInput(); change(input);
      expect(run(input).ungrounded).toEqual([]);
    }
  });

  it('catches a number not in the facts', () => {
    const facts = extractMethodsFacts(realInput());
    expect(findUngroundedNumbers('We screened 4242 records.', facts)).toEqual(['4242']);
  });

  it('leading zeros are distinct from the plain number', () => {
    const facts = extractMethodsFacts(realInput());
    expect(findUngroundedNumbers('screened 06 records', facts)).toEqual(['06']);
  });

  it('a number in the year range is grounded only as the whole run', () => {
    const facts = extractMethodsFacts(realInput());
    expect(findUngroundedNumbers('in 2025', facts)).toEqual(['2025']);
    expect(findUngroundedNumbers('in 2024', facts)).toEqual([]);
  });

  it('digits of other scripts are folded to ASCII and checked (fullwidth, Arabic-Indic, superscript)', () => {
    expect(findUngroundedNumbers('１２３ records, ٤٥ reports, x² ³', [])).toEqual(['123', '45', '2', '3']);
  });

  it('a fullwidth or Arabic-Indic digit is grounded by the same number in the facts', () => {
    const facts = extractMethodsFacts(realInput());
    expect(findUngroundedNumbers('６ records and ٦ reports', facts)).toEqual([]);
  });

  it('LIMIT: a negative sign is not seen, so -6 is grounded by 6', () => {
    const facts = extractMethodsFacts(realInput());
    expect(findUngroundedNumbers('-6 records', facts)).toEqual([]);
  });

  it('LIMIT: digits split by markup are each grounded on their own', () => {
    const facts = extractMethodsFacts(realInput());
    expect(groundedNumbers(facts).has('2021')).toBe(true);
    expect(findUngroundedNumbers('6**0**6 records', facts)).toEqual([]);
  });

  it('LIMIT: digits inside user text ground the same number anywhere in the template text', () => {
    const facts = extractMethodsFacts(withA10((a10) => { a10.protocol.research_questions = [{ question: 'Does 5000 matter?' }]; }));
    expect(findUngroundedNumbers('A total of 5000 records were screened.', facts)).toEqual([]);
  });
});

describe('determinism', () => {
  it('same input gives byte-identical markdown and facts over many runs', () => {
    const first = run(realInput());
    for (let i = 0; i < 50; i++) {
      const next = run(realInput());
      expect(next.markdown).toBe(first.markdown);
      expect(JSON.stringify(next.facts)).toBe(JSON.stringify(first.facts));
    }
  });

  it('key order of payload objects does not matter', () => {
    const reverse = (value: any): any => Array.isArray(value) ? value.map(reverse)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)])) : value;
    const a = run(realInput());
    const input = realInput();
    const b = run({ a10: reverse(input.a10), a2: reverse(input.a2), prismaExport: reverse(input.prismaExport), studyCount: input.studyCount });
    expect(b.markdown).toBe(a.markdown);
    expect(JSON.stringify(b.facts)).toBe(JSON.stringify(a.facts));
  });

  it('facts order and keys are stable and complete', () => {
    const keys = extractMethodsFacts(realInput()).map((f) => f.key);
    expect(extractMethodsFacts({ a10: undefined, a2: undefined, prismaExport: undefined, studyCount: 0 }).map((f) => f.key)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every fact used by the template is a known fact and markdown ends with one newline', () => {
    const { usedFactKeys, facts, markdown } = run(realInput());
    expect(usedFactKeys.every((key) => facts.some((f) => f.key === key))).toBe(true);
    expect(markdown.endsWith('\n') && !markdown.endsWith('\n\n')).toBe(true);
  });
});
