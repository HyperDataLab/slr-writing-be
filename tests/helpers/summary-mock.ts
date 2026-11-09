import { DATA_MARKER } from '../../src/modules/llm/prompt.js';

/**
 * Deterministic stand-in for the model that writes Abstract and Conclusion. It reads the DATA object of the prompt and
 * answers with plain text that has no digits and no citation markers, so it always passes the summary checks.
 * Returns null for any other prompt template, so a test's own mock can fall through to it.
 */
export function summaryMock(req: { promptTemplateId: string; prompt: string }): { text: string; usedSections: string[] } | null {
  if (req.promptTemplateId !== 'abstract-draft' && req.promptTemplateId !== 'conclusion-draft') return null;
  const data = JSON.parse(req.prompt.split(`${DATA_MARKER}\n`)[1]) as { approvedSections: Array<{ sectionKey: string }> };
  const usedSections = data.approvedSections.map((section) => section.sectionKey);
  const text =
    req.promptTemplateId === 'abstract-draft'
      ? 'This systematic review examined how AI coding assistants perform on code generation and program repair. ' +
        'The authors followed a documented protocol and screened the included studies against explicit criteria.\n\n' +
        'The approved sections report that accuracy depends on the task and the benchmark, and that the evidence has important limitations. ' +
        'The findings should be read together with those limitations.'
      : 'The approved results and discussion answer the research questions of this review. ' +
        'Assistants perform well on some code generation tasks, but the strength of the evidence varies between studies and benchmarks.\n\n' +
        'Future work should address the limitations that the discussion section describes before firm conclusions are drawn.';
  return { text, usedSections };
}
