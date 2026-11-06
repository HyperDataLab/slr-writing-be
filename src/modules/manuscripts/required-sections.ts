import { createHash } from 'node:crypto';
import { prisma } from '../../config/prisma.js';
import type { BlueprintContent } from '../blueprint/blueprint.types.js';
import type { ParagraphPlanContent } from '../paragraph-plans/paragraph-plan.types.js';

/**
 * Sections that must have a drafted (and, for H3, H2-approved) revision before the manuscript can be verified or
 * exported. Methods comes from the fixed template and Results from the evidence-grounded drafter; every other section
 * that the approved blueprint includes becomes required as soon as it has at least one READY_TO_DRAFT paragraph plan,
 * because then the engine can draft it. Included sections the engine cannot draft (no plan, e.g. Abstract which has no
 * generator yet, or no paragraph with enough evidence) would block forever, so they are reported as omitted instead.
 */
export const ALWAYS_REQUIRED_SECTIONS = ['methods', 'results'] as const;

/**
 * Fingerprint of the latest revision of every section. A verification report records the fingerprint of what it
 * checked; if the sections change afterwards the report is stale and must not unlock H3.
 */
export function fingerprintSections(sections: Array<{ sectionKey: string; contentHash: string | null }>): string {
  const parts = [...sections]
    .sort((a, b) => a.sectionKey.localeCompare(b.sectionKey))
    .map((s) => `${s.sectionKey}:${s.contentHash ?? 'empty'}`);
  return createHash('sha256').update(parts.join(';')).digest('hex');
}

export interface RequiredSections {
  required: string[];
  omitted: string[];
  /** Required sections (other than Methods) with no READY_TO_DRAFT plan: they cannot be drafted until evidence is resolved. */
  undraftable: string[];
}

export function computeRequiredSections(params: {
  blueprintSections: Array<{ key: string; include: boolean }>;
  plans: Array<{ sectionKey: string; status?: string }>;
}): RequiredSections {
  const planned = new Set(params.plans.filter((plan) => plan.status === 'READY_TO_DRAFT').map((plan) => plan.sectionKey));
  const required = new Set<string>(ALWAYS_REQUIRED_SECTIONS);
  const omitted: string[] = [];

  for (const section of params.blueprintSections) {
    if (!section.include || required.has(section.key)) continue;
    if (planned.has(section.key)) required.add(section.key);
    else omitted.push(section.key);
  }

  const undraftable = [...required].filter((key) => key !== 'methods' && !planned.has(key));
  return { required: [...required], omitted, undraftable };
}

/** Required and omitted sections for the approved blueprint and the latest paragraph plans of a manuscript. */
export async function loadRequiredSections(manuscriptId: string, blueprint: BlueprintContent): Promise<RequiredSections> {
  const latestPlans = await prisma.paragraphPlanRevision.findFirst({
    where: { manuscriptId },
    orderBy: { version: 'desc' },
  });
  const plans = ((latestPlans?.content ?? null) as unknown as ParagraphPlanContent | null)?.plans ?? [];
  return computeRequiredSections({ blueprintSections: blueprint.sections ?? [], plans });
}
