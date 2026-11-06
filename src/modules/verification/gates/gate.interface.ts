import type {
  CitationManifest,
  QualityGateResult,
  ReviewIssue,
} from '../verification.types.js';
import type {
  SectionRevisionForManifest,
  SnapshotRegistryForManifest,
} from '../manifest.service.js';

export interface GateEvaluationContext {
  manifest: CitationManifest;
  sections: SectionRevisionForManifest[];
  registry: SnapshotRegistryForManifest;
  blueprint: {
    researchQuestions: Array<{ rqId: string; code: string | null; question: string }>;
    sections: Array<{ key: string; include: boolean; subsections: Array<{ id: string; title: string }> }>;
  };
  /** Per-RQ blueprint coverage; an RQ with a notApplicableReason is exempt from the drafted-paragraph requirement. */
  coverage?: Array<{ rqId: string; notApplicableReason: string | null }>;
  /** Sections that must be drafted before the manuscript can pass (see manuscripts/required-sections). */
  requiredSections?: string[];
  supplements?: {
    prismaWritingExport?: {
      flow?: {
        studiesIncluded?: number | null;
      };
      includedStudies?: Array<{ id: string }>;
    };
  };
  paragraphPlans?: Array<{
    id: string;
    sectionKey: string;
    rqIds?: string[];
    claimStrength: 'strong' | 'neutral' | 'qualified';
    conditionsRequired?: boolean;
  }>;
}

export interface GateEvaluator {
  gateId: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7';
  name: string;
  evaluate(context: GateEvaluationContext): Promise<{ result: QualityGateResult; issues: ReviewIssue[] }>;
}
