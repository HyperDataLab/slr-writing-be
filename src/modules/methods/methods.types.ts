/**
 * Layer 1 of the Methods section: facts. A fact is one piece of data taken from the snapshot, with the path it came from.
 * Facts hold no prose. Whatever writes the sentences (a template now, an LLM later) may only use these values.
 */

/** One entry of a list fact, such as a research question, a criterion, a search source or an exclusion reason. */
export interface FactItem {
  /** Code or id shown with the text, for example 'RQ1' or 'IC2'. */
  id?: string;
  text: string;
  /** Present for counted items, such as an exclusion reason with its number of reports. */
  count?: number;
}

export type FactValue = number | string | FactItem[];

export interface Fact {
  /** Stable name, for example 'prisma.screened'. */
  key: string;
  label: string;
  /** 'explicit' = the snapshot says it; 'missing' = the snapshot has nothing, and the text must say so rather than guess. */
  status: 'explicit' | 'missing';
  /** null exactly when the status is 'missing'. */
  value: FactValue | null;
  /** Where in the snapshot the value comes from, for example 'prisma_writing_export.flow.recordsScreened'. */
  source: string;
  /** Set when the value is computed from the source rather than copied, for example a minimum. */
  derivation?: string;
}

export interface MethodsInput {
  /** Payload of artifact A10 (protocol, search strategy, selected studies). */
  a10: Record<string, unknown> | undefined;
  /** Payload of artifact A2 (descriptive statistics of the corpus). Optional. */
  a2: Record<string, unknown> | undefined;
  /** The PRISMA writing export copied into the snapshot. */
  prismaExport: Record<string, unknown> | undefined;
  /** Number of studies stored in the snapshot. */
  studyCount: number;
}

export interface MethodsDraft {
  markdown: string;
  facts: Fact[];
  /** Exact Markdown line ranges whose wording is grounded in these facts. End line is exclusive. */
  factPassages: MethodsFactPassage[];
  /** Keys of the facts the text used. */
  usedFactKeys: string[];
}

export interface MethodsFactPassage {
  id: string;
  startLine: number;
  endLine: number;
  factKeys: string[];
}
