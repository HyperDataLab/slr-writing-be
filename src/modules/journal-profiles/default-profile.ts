import { deepFreeze } from '../../shared/utils/deep-freeze.js';
import { journalProfileSchema, type JournalProfile } from './journal-profile.schema.js';

/**
 * The one profile the MVP ships: a generic IMRaD layout for a systematic review. No journal has been chosen, so it is
 * marked unverified, carries no policy source, and its word budgets are this system's suggestions, not a journal's limits.
 * When a venue is chosen, add a second profile with its own id; do not edit this one into a journal's profile.
 *
 * Section sources follow docs/mvp-scope.md section 5.
 */
const draft = {
  id: 'generic-imrad',
  version: 1,
  name: 'Generic IMRaD systematic review',
  articleType: 'systematic_review',
  language: 'en',
  journal: { name: null, url: null },
  verification: { status: 'unverified', verifiedAt: null, verifiedBy: null, policySourceUrls: [] },
  wordBudgetSource: 'suggested_default',
  citationStyle: null,
  notice: 'Not verified against the policy of any journal. The layout and the word budgets are suggestions of this system. Check the target journal\'s author guidelines before submitting.',
  sections: [
    {
      key: 'abstract', title: 'Abstract', order: 1, required: true, wordBudget: { min: 150, max: 300 },
      sources: ['A10', 'other_sections'], generator: 'summary-llm@1',
      purpose: 'Summarise the review question, methods, main results and conclusion; written last from the other sections.',
    },
    {
      key: 'introduction', title: 'Introduction', order: 2, required: true, wordBudget: { min: 400, max: 800 },
      sources: ['A10', 'other_sections'], generator: null,
      purpose: 'State the problem, the gap and the research questions of the review.',
    },
    {
      key: 'methods', title: 'Methods', order: 3, required: true, wordBudget: { min: 600, max: 1200 },
      sources: ['A10', 'prisma_writing_export', 'A2'], generator: 'methods-template@1',
      purpose: 'Report the protocol, eligibility criteria, sources, study selection flow and data extraction.',
    },
    {
      key: 'results', title: 'Results', order: 4, required: true, wordBudget: { min: 800, max: 1800 },
      sources: ['A1', 'A2'], generator: null,
      purpose: 'Present the synthesis by theme, each statement tied to the findings and studies behind it.',
    },
    {
      key: 'discussion', title: 'Discussion', order: 5, required: true, wordBudget: { min: 600, max: 1400 },
      sources: ['A7', 'A1', 'A10', 'rq_findings'], generator: null,
      purpose: 'Interpret the results, show where studies agree or conflict, and state the limitations.',
    },
    {
      key: 'conclusion', title: 'Conclusion', order: 6, required: true, wordBudget: { min: 150, max: 400 },
      sources: ['A10', 'other_sections', 'rq_findings'], generator: 'summary-llm@1',
      purpose: 'Answer the research questions and say what follows from the review.',
    },
  ],
};

// Parsing at load time means a profile that breaks its own rules stops the server from starting.
// Frozen, because the whole process shares this object: nothing may change it, only copies of it.
export const DEFAULT_JOURNAL_PROFILE: JournalProfile = deepFreeze(journalProfileSchema.parse(draft));
