import {
  type DocumentPolicy,
  type ResumePagePolicyReason,
  type ResumeTargetPages,
} from "./document-policy";
import type { JdKeywordProfile } from "./types/jobs";
import type { ApplicationRoleFamily } from "./types/settings";

export type ResumeMasterVariant = "one_page" | "two_page";
export type ResumeLayoutMode = "reference_1_page" | "reference_2_page";
export type ResumeReferencePurpose = "format" | "evidence";

export interface ResumeGenerationReferenceSummary {
  purpose: ResumeReferencePurpose;
  fileName: string;
  relativePath: string;
  roleFamily?: ApplicationRoleFamily | string;
  section?: string;
}

export interface ResumeGenerationDecision {
  roleFamily: ApplicationRoleFamily;
  documentPolicyReason: ResumePagePolicyReason;
  targetPages: ResumeTargetPages;
  masterVariant: ResumeMasterVariant;
  layoutMode: ResumeLayoutMode;
  referenceRoleFamilies: string[];
  blockedDomainTerms: string[];
  policyLabel: string;
  policyReason: string;
  allowsManualResumeTargetPages: boolean;
  formatReferences: ResumeGenerationReferenceSummary[];
  evidenceReferences: ResumeGenerationReferenceSummary[];
}

export function referenceRoleFamiliesForDecision(
  policy: Pick<DocumentPolicy, "roleFamily" | "resumePagePolicyReason">,
): string[] {
  const families = new Set<string>([policy.roleFamily]);
  if (
    policy.resumePagePolicyReason === "city_public_sector" ||
    policy.resumePagePolicyReason === "ontario_provincial" ||
    policy.resumePagePolicyReason === "public_sector_government"
  ) {
    families.add("public_sector_policy_economic_development");
    families.add("market_insights_research");
    families.add("data_analytics_operations");
    families.add("city_public_policy_data_research");
  } else if (policy.resumePagePolicyReason === "consulting") {
    families.add("consulting_strategy");
    families.add("business_development_partnerships");
  } else {
    families.add("data_analytics_operations");
    families.add("business_development_partnerships");
    families.add("market_insights_research");
  }
  return Array.from(families);
}

export function buildResumeGenerationDecision(args: {
  policy: DocumentPolicy;
  keywordProfile?: JdKeywordProfile | null;
  formatReferences?: ResumeGenerationReferenceSummary[];
  evidenceReferences?: ResumeGenerationReferenceSummary[];
}): ResumeGenerationDecision {
  const targetPages = args.policy.resumeTargetPages;
  return {
    roleFamily: args.policy.roleFamily,
    documentPolicyReason: args.policy.resumePagePolicyReason,
    targetPages,
    masterVariant: targetPages === 1 ? "one_page" : "two_page",
    layoutMode: targetPages === 1 ? "reference_1_page" : "reference_2_page",
    referenceRoleFamilies: referenceRoleFamiliesForDecision(args.policy),
    blockedDomainTerms: args.keywordProfile?.blockedUnlessPresent ?? [],
    policyLabel: args.policy.resumePagePolicyLabel,
    policyReason: args.policy.reason,
    allowsManualResumeTargetPages: args.policy.allowsManualResumeTargetPages,
    formatReferences: args.formatReferences ?? [],
    evidenceReferences: args.evidenceReferences ?? [],
  };
}

export function formatResumeGenerationDecisionMarker(
  decision: Pick<
    ResumeGenerationDecision,
    | "documentPolicyReason"
    | "targetPages"
    | "masterVariant"
    | "layoutMode"
    | "formatReferences"
  >,
): string {
  const formatReferences = decision.formatReferences
    .slice(0, 3)
    .map((item) => item.relativePath || item.fileName)
    .join("; ");
  return [
    `policyReason=${decision.documentPolicyReason}`,
    `targetPages=${decision.targetPages}`,
    `masterVariant=${decision.masterVariant}`,
    `layoutMode=${decision.layoutMode}`,
    formatReferences ? `formatReferences=${formatReferences}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}
