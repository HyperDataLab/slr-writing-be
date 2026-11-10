import { deepFreeze } from '../../shared/utils/deep-freeze.js';
import { journalProfileSchema, type JournalProfile } from './journal-profile.schema.js';

/**
 * IEEE Conference Two-Column Profile:
 * Targets IEEE Transactions & Conference Proceedings publication format.
 * Features:
 * - Two-column layout with 24pt full-width header
 * - Roman numeral section numbering (I. INTRODUCTION, II. METHODS...)
 * - IEEE numeric citation format [1], [2]
 * - Formatted Abstract & Index Terms
 * - Explicit threats to validity and compliance note
 */
const draft = {
  id: 'ieee-conference',
  version: 1,
  name: 'IEEE Conference Two-Column Format',
  articleType: 'systematic_review',
  language: 'en',
  journal: {
    name: 'IEEE Conference Proceedings',
    url: 'https://www.ieee.org/conferences/publishing/templates.html',
  },
  verification: {
    status: 'unverified',
    verifiedAt: null,
    verifiedBy: null,
    policySourceUrls: [],
  },
  wordBudgetSource: 'suggested_default',
  citationStyle: 'IEEE Numeric [1]',
  notice: 'Formatted according to IEEE Conference two-column publication standards (2-column layout, Roman numeral sections, numeric citations). Word budgets follow IEEE conference paper limits.',
  sections: [
    {
      key: 'abstract',
      title: 'Abstract & Index Terms',
      order: 1,
      required: true,
      wordBudget: { min: 150, max: 250 },
      sources: ['A10', 'other_sections'],
      generator: 'summary-llm@1',
      purpose: 'Summarise review objectives, methods, main results and conclusion in IEEE abstract format with Index Terms.',
    },
    {
      key: 'introduction',
      title: 'Introduction',
      order: 2,
      required: true,
      wordBudget: { min: 400, max: 800 },
      sources: ['A10', 'other_sections'],
      generator: null,
      purpose: 'State the problem, motivation and the research questions in Section I.',
    },
    {
      key: 'methods',
      title: 'Methods and Review Protocol',
      order: 3,
      required: true,
      wordBudget: { min: 600, max: 1200 },
      sources: ['A10', 'prisma_writing_export', 'A2'],
      generator: 'methods-template@1',
      purpose: 'Report the protocol, eligibility criteria, sources, study selection flow and PRISMA 2020 summary in Section II.',
    },
    {
      key: 'results',
      title: 'Results and Empirical Synthesis',
      order: 4,
      required: true,
      wordBudget: { min: 800, max: 1800 },
      sources: ['A1', 'A2'],
      generator: null,
      purpose: 'Present the synthesis by theme, tied to primary studies and evidence anchors in Section III.',
    },
    {
      key: 'discussion',
      title: 'Discussion and Threats to Validity',
      order: 5,
      required: true,
      wordBudget: { min: 600, max: 1400 },
      sources: ['A7', 'A1', 'A10', 'rq_findings'],
      generator: null,
      purpose: 'Interpret empirical results, show where studies agree or conflict, and state threats to validity in Section IV.',
    },
    {
      key: 'conclusion',
      title: 'Conclusion and Future Work',
      order: 6,
      required: true,
      wordBudget: { min: 150, max: 400 },
      sources: ['A10', 'other_sections', 'rq_findings'],
      generator: 'summary-llm@1',
      purpose: 'Answer the research questions and highlight future directions in Section V.',
    },
  ],
};

export const IEEE_JOURNAL_PROFILE: JournalProfile = deepFreeze(journalProfileSchema.parse(draft));
