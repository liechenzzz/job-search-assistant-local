import { logger } from "@infra/logger";
import type {
  ExperienceCapabilityDigest,
  JdKeywordProfile,
  JdQualificationProfile,
  JdServiceValueBrief,
  ResumeContentPlan,
  ResumePositioningPlan,
  ResumeServiceFitReport,
  SelectedResumeEvidence,
  TailoredExperienceItem,
} from "@shared/types";
import type { JsonSchemaDefinition, LlmResponse } from "./llm/types";

type ServiceValueLlmClient = {
  callJson<T>(args: {
    model: string;
    messages: Array<{ role: "user" | "system" | "assistant"; content: string }>;
    jsonSchema: JsonSchemaDefinition;
    stage?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): Promise<LlmResponse<T>>;
};

export const JD_SERVICE_VALUE_BRIEF_SCHEMA: JsonSchemaDefinition = {
  name: "jd_service_value_brief",
  schema: {
    type: "object",
    properties: {
      buyerNeed: { type: "string" },
      targetStakeholders: { type: "array", items: { type: "string" } },
      businessDecisionsSupported: { type: "array", items: { type: "string" } },
      expectedDeliverables: { type: "array", items: { type: "string" } },
      mustSignalConcepts: { type: "array", items: { type: "string" } },
      avoidDominantFrames: { type: "array", items: { type: "string" } },
      candidateValueProposition: { type: "string" },
      evidenceTranslationTargets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            jdNeed: { type: "string" },
            resumeProofTheme: { type: "string" },
            acceptableWording: { type: "string" },
            overclaimRisk: { type: "string" },
          },
          required: [
            "jdNeed",
            "resumeProofTheme",
            "acceptableWording",
            "overclaimRisk",
          ],
          additionalProperties: false,
        },
      },
    },
    required: [
      "buyerNeed",
      "targetStakeholders",
      "businessDecisionsSupported",
      "expectedDeliverables",
      "mustSignalConcepts",
      "avoidDominantFrames",
      "candidateValueProposition",
      "evidenceTranslationTargets",
    ],
    additionalProperties: false,
  },
};

export const RESUME_SERVICE_FIT_SCHEMA: JsonSchemaDefinition = {
  name: "resume_service_fit_verifier",
  schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pass", "needs_review", "weak_fit"] },
      score: { type: "number" },
      targetBuyerNeed: { type: "string" },
      resumeCurrentlySignals: { type: "array", items: { type: "string" } },
      matchedServiceValues: { type: "array", items: { type: "string" } },
      missingOrWeakServiceValues: { type: "array", items: { type: "string" } },
      oldFrameRisks: { type: "array", items: { type: "string" } },
      unsupportedOrNeedsConfirmation: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            severity: { type: "string", enum: ["soft", "medium", "high"] },
            recommendation: { type: "string" },
          },
          required: ["claim", "severity", "recommendation"],
          additionalProperties: false,
        },
      },
      manualFixSuggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            section: {
              type: "string",
              enum: ["summary", "skills", "experience", "education"],
            },
            issue: { type: "string" },
            suggestedDirection: { type: "string" },
          },
          required: ["section", "issue", "suggestedDirection"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "status",
      "score",
      "targetBuyerNeed",
      "resumeCurrentlySignals",
      "matchedServiceValues",
      "missingOrWeakServiceValues",
      "oldFrameRisks",
      "unsupportedOrNeedsConfirmation",
      "manualFixSuggestions",
    ],
    additionalProperties: false,
  },
};

export async function generateJdServiceValueBrief(args: {
  llm: ServiceValueLlmClient;
  model: string;
  jobDescription: string;
  jobTitle?: string | null;
  employer?: string | null;
  jdKeywordProfile: JdKeywordProfile;
  jdQualificationProfile: JdQualificationProfile;
  selectedEvidence: SelectedResumeEvidence[];
  experienceDigests: ExperienceCapabilityDigest[];
  contentPlan: ResumeContentPlan;
}): Promise<JdServiceValueBrief | null> {
  try {
    const result = await args.llm.callJson<JdServiceValueBrief>({
      model: args.model,
      messages: [{ role: "user", content: buildJdServiceValuePrompt(args) }],
      jsonSchema: JD_SERVICE_VALUE_BRIEF_SCHEMA,
      stage: "jd_service_value_brief",
      metadata: { generatedVisibleContent: false },
    });
    if (!result.success) {
      logger.warn("JD service-value brief generation failed", {
        error: result.error,
        jobTitle: args.jobTitle,
        employer: args.employer,
      });
      return null;
    }
    return sanitizeJdServiceValueBrief(result.data);
  } catch (error) {
    logger.warn("JD service-value brief generation threw", {
      error: error instanceof Error ? error.message : String(error),
      jobTitle: args.jobTitle,
      employer: args.employer,
    });
    return null;
  }
}

export async function verifyResumeServiceFit(args: {
  llm: ServiceValueLlmClient;
  model: string;
  jobTitle?: string | null;
  employer?: string | null;
  jdServiceValueBrief: JdServiceValueBrief;
  resumePositioningPlan: ResumePositioningPlan | null;
  headline: string;
  summary: string;
  skills: Array<{ name: string; keywords: string[] }>;
  experience: TailoredExperienceItem[];
  selectedEvidence: SelectedResumeEvidence[];
  generationTrace: unknown;
}): Promise<ResumeServiceFitReport> {
  try {
    const result = await args.llm.callJson<ResumeServiceFitReport>({
      model: args.model,
      messages: [{ role: "user", content: buildResumeServiceFitPrompt(args) }],
      jsonSchema: RESUME_SERVICE_FIT_SCHEMA,
      stage: "service_fit_judge",
      metadata: { generatedVisibleContent: false },
    });
    if (!result.success) {
      logger.warn("Resume service-fit verification failed", {
        error: result.error,
        jobTitle: args.jobTitle,
        employer: args.employer,
      });
      return buildServiceFitUnavailableReport(args.jdServiceValueBrief);
    }
    return (
      sanitizeResumeServiceFitReport(result.data, args.jdServiceValueBrief) ??
      buildServiceFitUnavailableReport(args.jdServiceValueBrief)
    );
  } catch (error) {
    logger.warn("Resume service-fit verification threw", {
      error: error instanceof Error ? error.message : String(error),
      jobTitle: args.jobTitle,
      employer: args.employer,
    });
    return buildServiceFitUnavailableReport(args.jdServiceValueBrief);
  }
}

export function needsServiceFitRepair(report: ResumeServiceFitReport): boolean {
  return (
    report.status !== "pass" ||
    report.score < 82 ||
    report.missingOrWeakServiceValues.length > 0 ||
    report.oldFrameRisks.length > 0 ||
    report.unsupportedOrNeedsConfirmation.some(
      (item) => item.severity === "high",
    )
  );
}

export function formatJdServiceValueBriefForPrompt(
  brief: JdServiceValueBrief | null | undefined,
): string {
  if (!brief) return "Unavailable.";
  const targetStakeholders = Array.isArray(brief.targetStakeholders)
    ? brief.targetStakeholders
    : [];
  const businessDecisionsSupported = Array.isArray(
    brief.businessDecisionsSupported,
  )
    ? brief.businessDecisionsSupported
    : [];
  const expectedDeliverables = Array.isArray(brief.expectedDeliverables)
    ? brief.expectedDeliverables
    : [];
  const mustSignalConcepts = Array.isArray(brief.mustSignalConcepts)
    ? brief.mustSignalConcepts
    : [];
  const avoidDominantFrames = Array.isArray(brief.avoidDominantFrames)
    ? brief.avoidDominantFrames
    : [];
  const evidenceTranslationTargets = Array.isArray(
    brief.evidenceTranslationTargets,
  )
    ? brief.evidenceTranslationTargets
    : [];
  return [
    `Buyer need: ${brief.buyerNeed || "None listed."}`,
    `Target stakeholders: ${targetStakeholders.join("; ") || "None listed."}`,
    `Business decisions supported: ${
      businessDecisionsSupported.join("; ") || "None listed."
    }`,
    `Expected deliverables: ${expectedDeliverables.join("; ") || "None listed."}`,
    `Must signal: ${mustSignalConcepts.join("; ") || "None listed."}`,
    `Avoid dominant frames: ${
      avoidDominantFrames.join("; ") || "None listed."
    }`,
    `Candidate value proposition: ${brief.candidateValueProposition || "None listed."}`,
    "Evidence translation targets:",
    ...evidenceTranslationTargets.map(
      (item) =>
        `- ${item.jdNeed}: use ${item.resumeProofTheme}; acceptable wording: ${item.acceptableWording}; risk: ${item.overclaimRisk}`,
    ),
  ].join("\n");
}

export function buildServiceFitUnavailableReport(
  brief: JdServiceValueBrief,
): ResumeServiceFitReport {
  return {
    status: "needs_review",
    score: 50,
    targetBuyerNeed: brief.buyerNeed,
    resumeCurrentlySignals: [],
    matchedServiceValues: [],
    missingOrWeakServiceValues: [
      "Service-fit verifier was unavailable; resume may need manual review for JD value alignment.",
    ],
    oldFrameRisks: [],
    unsupportedOrNeedsConfirmation: [],
    manualFixSuggestions: [
      {
        section: "summary",
        issue:
          "Could not automatically verify whether the first impression matches the JD buyer need.",
        suggestedDirection:
          "Manually ensure the summary leads with the service value the employer is buying.",
      },
    ],
  };
}

export function sanitizeJdServiceValueBrief(
  value: unknown,
): JdServiceValueBrief | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<JdServiceValueBrief>;
  const buyerNeed = sanitizeText(input.buyerNeed);
  if (!buyerNeed) return null;
  return {
    buyerNeed,
    targetStakeholders: sanitizeStringList(input.targetStakeholders, 8),
    businessDecisionsSupported: sanitizeStringList(
      input.businessDecisionsSupported,
      8,
    ),
    expectedDeliverables: sanitizeStringList(input.expectedDeliverables, 8),
    mustSignalConcepts: sanitizeStringList(input.mustSignalConcepts, 12),
    avoidDominantFrames: sanitizeStringList(input.avoidDominantFrames, 10),
    candidateValueProposition: sanitizeText(input.candidateValueProposition),
    evidenceTranslationTargets: Array.isArray(input.evidenceTranslationTargets)
      ? input.evidenceTranslationTargets
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const entry =
              item as JdServiceValueBrief["evidenceTranslationTargets"][number];
            const jdNeed = sanitizeText(entry.jdNeed);
            if (!jdNeed) return null;
            return {
              jdNeed,
              resumeProofTheme: sanitizeText(entry.resumeProofTheme),
              acceptableWording: sanitizeText(entry.acceptableWording),
              overclaimRisk: sanitizeText(entry.overclaimRisk),
            };
          })
          .filter(
            (
              item,
            ): item is JdServiceValueBrief["evidenceTranslationTargets"][number] =>
              Boolean(item),
          )
          .slice(0, 8)
      : [],
  };
}

export function sanitizeResumeServiceFitReport(
  value: unknown,
  brief?: JdServiceValueBrief | null,
): ResumeServiceFitReport | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ResumeServiceFitReport>;
  const status =
    input.status === "pass" ||
    input.status === "needs_review" ||
    input.status === "weak_fit"
      ? input.status
      : "needs_review";
  const score =
    typeof input.score === "number"
      ? Math.max(0, Math.min(100, Math.round(input.score)))
      : status === "pass"
        ? 85
        : 60;
  const report: ResumeServiceFitReport = {
    status,
    score,
    targetBuyerNeed:
      sanitizeText(input.targetBuyerNeed) ||
      brief?.buyerNeed ||
      "Unknown buyer need.",
    resumeCurrentlySignals: sanitizeStringList(input.resumeCurrentlySignals, 8),
    matchedServiceValues: sanitizeStringList(input.matchedServiceValues, 8),
    missingOrWeakServiceValues: sanitizeStringList(
      input.missingOrWeakServiceValues,
      8,
    ),
    oldFrameRisks: sanitizeStringList(input.oldFrameRisks, 8),
    unsupportedOrNeedsConfirmation: Array.isArray(
      input.unsupportedOrNeedsConfirmation,
    )
      ? input.unsupportedOrNeedsConfirmation
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const entry =
              item as ResumeServiceFitReport["unsupportedOrNeedsConfirmation"][number];
            const claim = sanitizeText(entry.claim);
            if (!claim) return null;
            return {
              claim,
              severity:
                entry.severity === "high" ||
                entry.severity === "medium" ||
                entry.severity === "soft"
                  ? entry.severity
                  : "soft",
              recommendation: sanitizeText(entry.recommendation),
            };
          })
          .filter(
            (
              item,
            ): item is ResumeServiceFitReport["unsupportedOrNeedsConfirmation"][number] =>
              Boolean(item),
          )
          .slice(0, 8)
      : [],
    manualFixSuggestions: Array.isArray(input.manualFixSuggestions)
      ? input.manualFixSuggestions
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const entry =
              item as ResumeServiceFitReport["manualFixSuggestions"][number];
            const issue = sanitizeText(entry.issue);
            if (!issue) return null;
            return {
              section:
                entry.section === "skills" ||
                entry.section === "experience" ||
                entry.section === "education" ||
                entry.section === "summary"
                  ? entry.section
                  : "summary",
              issue,
              suggestedDirection: sanitizeText(entry.suggestedDirection),
            };
          })
          .filter(
            (
              item,
            ): item is ResumeServiceFitReport["manualFixSuggestions"][number] =>
              Boolean(item),
          )
          .slice(0, 8)
      : [],
  };
  return normalizeServiceFitReport(report, brief);
}

function normalizeServiceFitReport(
  report: ResumeServiceFitReport,
  brief?: JdServiceValueBrief | null,
): ResumeServiceFitReport {
  const signalText = report.resumeCurrentlySignals.join(" ").toLowerCase();
  const noClearSignal =
    signalText.includes("no clear") ||
    signalText.includes("not clear") ||
    signalText.includes("unclear") ||
    (report.status !== "pass" && report.resumeCurrentlySignals.length === 0);
  const needsReview = report.status !== "pass" || report.score < 82;
  const missingOrWeakServiceValues = [...report.missingOrWeakServiceValues];
  const oldFrameRisks = [...report.oldFrameRisks];
  const manualFixSuggestions = [...report.manualFixSuggestions];
  const targetBuyerNeed = brief?.buyerNeed || report.targetBuyerNeed;
  const mustSignal = brief?.mustSignalConcepts?.slice(0, 4).join(", ");
  const avoidFrames = brief?.avoidDominantFrames?.slice(0, 3).join(", ");

  if (needsReview && missingOrWeakServiceValues.length === 0 && noClearSignal) {
    missingOrWeakServiceValues.push(
      `Resume does not clearly signal the target buyer need: ${targetBuyerNeed}`,
    );
  }
  if (needsReview && missingOrWeakServiceValues.length === 0 && mustSignal) {
    missingOrWeakServiceValues.push(
      `Resume under-signals required service-value concepts: ${mustSignal}`,
    );
  }
  if (needsReview && oldFrameRisks.length === 0 && avoidFrames) {
    oldFrameRisks.push(
      `Old or adjacent frame may still dominate: ${avoidFrames}`,
    );
  }
  if (needsReview && manualFixSuggestions.length === 0) {
    manualFixSuggestions.push({
      section: "summary",
      issue:
        "The first impression does not clearly state the JD-specific service value.",
      suggestedDirection: brief?.candidateValueProposition
        ? `Lead with this value proposition: ${brief.candidateValueProposition}`
        : `Lead with the target buyer need: ${targetBuyerNeed}`,
    });
    manualFixSuggestions.push({
      section: "experience",
      issue:
        "Experience bullets are not translating older work into the JD buyer need strongly enough.",
      suggestedDirection: mustSignal
        ? `Rewrite lead bullets around these concepts where evidence supports them: ${mustSignal}`
        : "Rewrite lead bullets around the buyer's decisions, stakeholders, deliverables, and recommendations.",
    });
  }

  return {
    ...report,
    status:
      noClearSignal && report.status === "pass"
        ? "needs_review"
        : report.status,
    score: noClearSignal ? Math.min(report.score, 74) : report.score,
    missingOrWeakServiceValues,
    oldFrameRisks,
    manualFixSuggestions,
  };
}

function buildJdServiceValuePrompt(args: {
  jobDescription: string;
  jobTitle?: string | null;
  employer?: string | null;
  jdKeywordProfile: JdKeywordProfile;
  jdQualificationProfile: JdQualificationProfile;
  selectedEvidence: SelectedResumeEvidence[];
  experienceDigests: ExperienceCapabilityDigest[];
  contentPlan: ResumeContentPlan;
}): string {
  return [
    "You are a bounded JD service-value analyst for resume tailoring.",
    "Your job is to understand what service/value the employer is buying, not to rewrite the resume.",
    "Return JSON only.",
    "",
    "Rules:",
    "- Separate buyer intent from keyword extraction and qualification coverage.",
    "- Identify what decisions, stakeholders, and deliverables the role supports.",
    "- Translate candidate evidence into truthful service-value proof themes.",
    "- Name frames that should not dominate if the JD is buying a different value.",
    "- Do not invent tools, sectors, clients, ownership, TAM, forecasting, Salesforce, Asana, or direct venture-client work unless evidence supports it.",
    "",
    "JOB CONTEXT:",
    `Title: ${args.jobTitle ?? "unknown"}`,
    `Employer: ${args.employer ?? "unknown"}`,
    "",
    "JOB DESCRIPTION:",
    truncate(args.jobDescription, 8000),
    "",
    "JD KEYWORD PROFILE:",
    truncate(JSON.stringify(args.jdKeywordProfile, null, 2), 5000),
    "",
    "JD QUALIFICATION PROFILE:",
    truncate(JSON.stringify(args.jdQualificationProfile, null, 2), 5000),
    "",
    "SELECTED RESUME EVIDENCE:",
    truncate(JSON.stringify(args.selectedEvidence.slice(0, 10), null, 2), 6000),
    "",
    "EXPERIENCE DIGESTS:",
    truncate(JSON.stringify(args.experienceDigests.slice(0, 8), null, 2), 5000),
    "",
    "CONTENT PLAN:",
    truncate(JSON.stringify(args.contentPlan, null, 2), 5000),
  ].join("\n");
}

function buildResumeServiceFitPrompt(args: {
  jdServiceValueBrief: JdServiceValueBrief;
  resumePositioningPlan: ResumePositioningPlan | null;
  headline: string;
  summary: string;
  skills: Array<{ name: string; keywords: string[] }>;
  experience: TailoredExperienceItem[];
  selectedEvidence: SelectedResumeEvidence[];
  generationTrace: unknown;
}): string {
  return [
    "You are a bounded resume service-fit verifier.",
    "Verify whether the visible resume clearly sells the service/value described in the JD service-value brief.",
    "Return JSON only. This is advisory QA, not a blocking gate.",
    "",
    "Rules:",
    "- Check the first impression created by headline and summary.",
    "- Check whether experience bullets translate older domains into the JD value without overclaiming.",
    "- If the resume does not clearly signal the target buyer need, status must be needs_review or weak_fit and missingOrWeakServiceValues must name that gap.",
    "- If resumeCurrentlySignals says no clear signal, manualFixSuggestions must include summary and experience repair directions.",
    "- Do not return 'No major gaps reported' when the first impression is unclear or old frames dominate.",
    "- Treat unsupported claims as reportable issues, not fatal errors.",
    "- High-severity unsupported claims should recommend removal or softening.",
    "- Medium/soft unsupported claims can remain but must be flagged for user confirmation.",
    "",
    "JD SERVICE VALUE BRIEF:",
    formatJdServiceValueBriefForPrompt(args.jdServiceValueBrief),
    "",
    "RESUME POSITIONING PLAN:",
    args.resumePositioningPlan
      ? truncate(JSON.stringify(args.resumePositioningPlan, null, 2), 5000)
      : "Unavailable.",
    "",
    "VISIBLE RESUME:",
    truncate(
      JSON.stringify(
        {
          headline: args.headline,
          summary: args.summary,
          skills: args.skills,
          experience: args.experience,
        },
        null,
        2,
      ),
      8000,
    ),
    "",
    "SELECTED EVIDENCE:",
    truncate(JSON.stringify(args.selectedEvidence.slice(0, 10), null, 2), 6000),
    "",
    "GENERATION TRACE:",
    truncate(JSON.stringify(args.generationTrace, null, 2), 4000),
  ].join("\n");
}

function sanitizeStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map(sanitizeText)
        .filter(Boolean),
    ),
  ).slice(0, limit);
}

function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}
