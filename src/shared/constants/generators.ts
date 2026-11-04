/**
 * The text generators that exist, written name@version. A journal profile may only name a generator from this list,
 * so it cannot promise a way of writing a section that the system does not have. Adding a generator means adding it here.
 */
export const METHODS_GENERATOR = 'methods-template@1';
export const RESULTS_LLM_GENERATOR = 'llm-draft@1';

export const KNOWN_GENERATORS: readonly string[] = [METHODS_GENERATOR, RESULTS_LLM_GENERATOR];
