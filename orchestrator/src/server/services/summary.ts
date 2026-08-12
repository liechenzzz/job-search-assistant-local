/**
 * Service for generating tailored resume content (Summary, Headline, Skills).
 */

import { createHash } from "node:crypto";
import { logger } from "@infra/logger";
import {
  buildResumePolicyInstructions,
  resolveDocumentPolicy,
} from "@shared/document-policy.js";
import {
  applyDomainGateToExperience,
  applyDomainGateToSkills,
  applyDomainGateToText,
  type DomainGateResidual,
} from "@shared/jd-domain-gate.js";
import { buildJdKeywordProfile } from "@shared/jd-keyword-profile.js";
import { buildJdQualificationProfile } from "@shared/jd-qualification-profile.js";
import { inferQualificationSemanticType } from "@shared/qualification-semantics.js";
import {
  buildEvidenceFitReport,
  buildResumeAlignmentReport,
  filterSkillsForQualificationEvidence,
} from "@shared/resume-alignment.js";
import {
  buildResumeCoveragePlan,
  formatResumeCoveragePlanInstructions,
  hasRepairableCoverageGap,
} from "@shared/resume-coverage-plan.js";
import {
  buildResumeGenerationDecision,
  type ResumeGenerationDecision,
} from "@shared/resume-generation-decision.js";
import type {
  ExperienceAnchorSummary,
  ExperienceBulletBundle,
  ExperienceCapabilityDigest,
  FramingJudgeResult,
  JdKeywordProfile,
  JdQualificationProfile,
  JdServiceValueBrief,
  ResumeAlignmentReport,
  ResumeContentPlan,
  ResumeCoveragePlan,
  ResumeGenerationTrace,
  ResumePositioningPlan,
  ResumeProfile,
  ResumeReferenceScanItem,
  ResumeServiceFitReport,
  SelectedResumeEvidence,
  TailoredExperienceItem,
} from "@shared/types";
import { buildApplicationWritingInstructionsForJob } from "./application-writing";
import {
  formatExperienceAnchorsForPrompt,
  selectExperienceAnchorsForGeneration,
} from "./experience-anchor-bank";
import {
  buildExperienceCapabilityDigests,
  formatExperienceCapabilityDigestsForPrompt,
} from "./experience-capability-digest";
import {
  buildFallbackBullet,
  extractClaims,
  generateFramingCandidates,
  isRepairBroken,
  judgeFramingCandidates,
  repairBlockedClaims,
} from "./framing-judge";
import { estimateLlmCostUsd } from "./llm/cost";
import type {
  JsonSchemaDefinition,
  LlmRequestOptions,
  LlmResponse,
  LlmUsage,
} from "./llm/types";
import { createConfiguredLlmService, resolveLlmModel } from "./modelSelection";
import {
  getWritingLanguageLabel,
  resolveWritingOutputLanguage,
} from "./output-language";
import {
  getEffectivePromptTemplate,
  renderPromptTemplate,
} from "./prompt-templates";
import {
  buildResumeContentPlan,
  formatResumeContentPlanForPrompt,
} from "./resume-content-plan";
import { rerankSelectedResumeEvidence } from "./resume-evidence-rerank";
import {
  buildResumeReferenceInstructions,
  buildSelectedResumeEvidence,
  findReferenceChunksForQualifications,
  findResumeReferenceEvidenceForQualifications,
  getExperienceAnchorSummaries,
  type ResumeReferenceKnowledgeHit,
  selectFormatReferenceSummaries,
  summarizeEvidenceReferenceHits,
} from "./resume-references";
import {
  formatJdServiceValueBriefForPrompt,
  generateJdServiceValueBrief,
  JD_SERVICE_VALUE_BRIEF_SCHEMA,
  needsServiceFitRepair,
  RESUME_SERVICE_FIT_SCHEMA,
  sanitizeJdServiceValueBrief,
  verifyResumeServiceFit,
} from "./resume-service-value";
import {
  getWritingStyle,
  stripKeywordLimitFromConstraints,
  stripLanguageDirectivesFromConstraints,
  stripWordLimitFromConstraints,
} from "./writing-style";

export const RESUME_POSITIONING_GENERATOR_VERSION = "repackaging-agent-v1.3";

type TailoringModelRouter = {
  pro: string;
  flash: string;
};

const TAILORING_PREPARATION_CACHE_TTL_MS = 30 * 60 * 1000;
const TAILORING_PREPARATION_CACHE_MAX_ENTRIES = 25;
const MAX_GENERATED_EXPERIENCE_ITEMS = 3;

type LlmTraceMetadata = Record<string, string | number | boolean | null>;

export interface TailoringLlmTraceEntry {
  stage: string;
  model: string;
  provider: string;
  usage?: LlmUsage;
  estimatedUsd?: number;
  elapsedMs: number;
  success: boolean;
  cacheHit: boolean;
  generatedVisibleContent: boolean;
  metadata?: LlmTraceMetadata;
}

function createTailoringModelRouter(model: string): TailoringModelRouter {
  const normalized = model.trim().toLowerCase();
  const isDeepSeekV4 =
    normalized === "deepseek-v4-pro" ||
    normalized === "deepseek-v4-flash" ||
    normalized === "deepseek-chat" ||
    normalized === "deepseek-reasoner";

  if (!isDeepSeekV4) {
    return { pro: model, flash: model };
  }

  return {
    pro: "deepseek-v4-pro",
    flash: "deepseek-v4-flash",
  };
}

export interface TailoredData {
  summary: string;
  headline: string;
  skills: Array<{ name: string; keywords: string[] }>;
  experience: TailoredExperienceItem[];
  jdKeywordProfile: JdKeywordProfile;
  jdQualificationProfile: JdQualificationProfile;
  selectedEvidence: SelectedResumeEvidence[];
  generationTrace: ResumeGenerationTrace;
  resumeAlignmentReport: ResumeAlignmentReport;
  jdServiceValueBrief: JdServiceValueBrief | null;
  resumeServiceFitReport: ResumeServiceFitReport | null;
  resumePositioningPlan: ResumePositioningPlan | null;
}

export interface TailoringResult {
  success: boolean;
  data?: TailoredData;
  error?: string;
  llmTrace?: TailoringLlmTraceEntry[];
  estimatedCostUsd?: number;
  llmCallCount?: number;
}

export interface TailoringContext {
  source?: string | null;
  jobTitle?: string | null;
  employer?: string | null;
  jobUrl?: string | null;
  applicationLink?: string | null;
  location?: string | null;
  resumeTargetPagesOverride?: 1 | 2 | null;
  repair?: {
    reason: "domain_gate_residuals";
    residuals: DomainGateResidual[];
    previousDraft?: {
      headline?: string | null;
      summary?: string | null;
      skills?: Array<{ name: string; keywords: string[] }> | null;
      experience?: TailoredExperienceItem[] | null;
    };
  };
}

type ExperienceEvidence = {
  id: string;
  sourceText: string;
};

type ExperienceEvidenceScope = {
  selectedEvidence: SelectedResumeEvidence[];
  allowedChunkIds: string[];
  allowedSections: string[];
  blockedChunkCount: number;
};

type TailoringEvidenceScopeName =
  | "summary"
  | "skills"
  | "experience"
  | "projects"
  | "education"
  | "general";

type TailoringEvidenceScopes = Record<
  TailoringEvidenceScopeName,
  SelectedResumeEvidence[]
>;

type TailoringPreparation = {
  jdKeywordProfile: JdKeywordProfile;
  jdQualificationProfile: JdQualificationProfile;
  referenceEvidence: ResumeReferenceScanItem[];
  referenceKnowledgeHits: ResumeReferenceKnowledgeHit[];
  selectedEvidence: SelectedResumeEvidence[];
  evidenceScopes: TailoringEvidenceScopes;
  experienceAnchors: ExperienceAnchorSummary[];
  experienceDigests: ExperienceCapabilityDigest[];
  sourceExperiences: ExperienceEvidence[];
  coveragePlan: ResumeCoveragePlan;
  generationDecision: ResumeGenerationDecision;
  contentPlan: ResumeContentPlan;
};

const tailoringPreparationCache = new Map<
  string,
  { expiresAt: number; value: TailoringPreparation }
>();

function createTailoringTraceRecorder(
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>,
): TailoringLlmTraceEntry[] {
  const trace: TailoringLlmTraceEntry[] = [];
  const provider = llm.getProvider();
  const originalCallJson = llm.callJson.bind(llm);

  llm.callJson = (async <T>(
    options: LlmRequestOptions<T>,
  ): Promise<LlmResponse<T>> => {
    const startedAt = Date.now();
    const result = await originalCallJson(options);
    const success = result.success;
    const meta = success ? result.meta : undefined;
    const usage = success ? result.usage : undefined;
    const resolvedProvider = meta?.provider ?? provider;
    const resolvedModel = meta?.model ?? options.model;
    trace.push({
      stage: options.stage ?? "unknown",
      model: resolvedModel,
      provider: resolvedProvider,
      usage,
      estimatedUsd: estimateLlmCostUsd({
        provider: resolvedProvider,
        model: resolvedModel,
        usage,
      }),
      elapsedMs: meta?.elapsedMs ?? Date.now() - startedAt,
      success,
      cacheHit: (usage?.promptCacheHitTokens ?? 0) > 0,
      generatedVisibleContent:
        options.metadata?.generatedVisibleContent === true,
      metadata: options.metadata,
    });
    return result;
  }) as typeof llm.callJson;

  return trace;
}

function summarizeTailoringTrace(trace: TailoringLlmTraceEntry[]): {
  estimatedCostUsd?: number;
  llmCallCount: number;
} {
  const estimatedValues = trace
    .map((entry) => entry.estimatedUsd)
    .filter((value): value is number => typeof value === "number");
  return {
    estimatedCostUsd:
      estimatedValues.length > 0
        ? estimatedValues.reduce((sum, value) => sum + value, 0)
        : undefined,
    llmCallCount: trace.filter((entry) => entry.provider !== "local").length,
  };
}

function buildTailoringPreparationCacheKey(args: {
  jobDescription: string;
  profile: ResumeProfile;
  context: TailoringContext;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        jobDescription: args.jobDescription,
        profile: args.profile,
        context: args.context,
        writingStyle: args.writingStyle,
      }),
    )
    .digest("hex");
}

function getCachedTailoringPreparation(
  key: string,
): TailoringPreparation | null {
  const cached = tailoringPreparationCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    tailoringPreparationCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedTailoringPreparation(
  key: string,
  value: TailoringPreparation,
): void {
  if (
    tailoringPreparationCache.size >= TAILORING_PREPARATION_CACHE_MAX_ENTRIES
  ) {
    const firstKey = tailoringPreparationCache.keys().next().value;
    if (typeof firstKey === "string")
      tailoringPreparationCache.delete(firstKey);
  }
  tailoringPreparationCache.set(key, {
    expiresAt: Date.now() + TAILORING_PREPARATION_CACHE_TTL_MS,
    value,
  });
}

type AiQualificationCoverageJudgement = {
  qualification: string;
  status: "covered" | "repairable" | "human_input_needed";
  sections: string[];
  evidenceSources: string[];
};

type AiCoverageJudgeResponse = {
  items: AiQualificationCoverageJudgement[];
};

type ResumePositioningPlanResponse = ResumePositioningPlan;

type SummaryAndSkillsResponse = {
  headline: string;
  summary: string;
  skills: Array<{ name: string; keywords: string[] }>;
};

type StructuredExperienceBulletResponse = {
  text: string;
  claimType: "direct" | "transferable" | "contextual";
  supportIds: string[];
  positioningIntent?: string;
  riskFlags?: string[];
};

type ResumeExperienceItemResponse = {
  id: string;
  bullets: Array<string | StructuredExperienceBulletResponse>;
};

type TailoringStrategyResponse = {
  jdServiceValueBrief: JdServiceValueBrief;
  resumePositioningPlan: ResumePositioningPlan;
};

type TailoringCompactJudgeResponse = {
  verdict: "pass" | "needs_patch";
  failedSections: Array<
    "summary" | "skills" | "experience" | "coverage" | "service_fit"
  >;
  failedExperienceIds: string[];
  reason: string;
  serviceFitReport: ResumeServiceFitReport;
};

type TailoringPatchResponse = {
  summarySkillsPatch?: Partial<SummaryAndSkillsResponse>;
  experiencePatches?: Array<{
    id: string;
    bullets?: string[];
    title?: string;
  }>;
  reason?: string;
};

type ResumePitchJudgeResponse = {
  verdict: "pass" | "fail";
  dominantPitchDetected: string;
  targetPitchMatched: boolean;
  sourcePitchDominating: boolean;
  failedSections: Array<"summary" | "skills" | "experience">;
  failedExperienceIds: string[];
  reasons: string[];
};

type VisibleExperienceGenerationContext = {
  id: string;
  index: number;
  label: string;
  company: string;
  position: string;
  date: string;
  sourceText: string;
};

/** JSON schema for resume tailoring response */
const TAILORING_SCHEMA: JsonSchemaDefinition = {
  name: "resume_tailoring",
  schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: "Job title headline matching the JD exactly",
      },
      summary: {
        type: "string",
        description: "Tailored resume summary paragraph",
      },
      skills: {
        type: "array",
        description: "Skills sections with keywords tailored to the job",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Specific master-style skill category name (e.g., Market & Audience Research, Data Analysis & Quality Control, Reporting & Analytics Tools)",
            },
            keywords: {
              type: "array",
              items: { type: "string" },
              description: "List of skills/technologies in this category",
            },
          },
          required: ["name", "keywords"],
          additionalProperties: false,
        },
      },
      experience: {
        type: "array",
        description:
          "Tailored experience bullets keyed by original experience id",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Original experience item id",
            },
            bullets: {
              type: "array",
              items: { type: "string" },
              description:
                "Rewritten bullets grounded in that original experience",
            },
          },
          required: ["id", "bullets"],
          additionalProperties: false,
        },
      },
    },
    required: ["headline", "summary", "skills", "experience"],
    additionalProperties: false,
  },
};

const SUMMARY_SKILLS_SCHEMA: JsonSchemaDefinition = {
  name: "resume_summary_skills",
  schema: {
    type: "object",
    properties: {
      headline: { type: "string" },
      summary: { type: "string" },
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            keywords: { type: "array", items: { type: "string" } },
          },
          required: ["name", "keywords"],
          additionalProperties: false,
        },
      },
    },
    required: ["headline", "summary", "skills"],
    additionalProperties: false,
  },
};

const EXPERIENCE_ITEM_SCHEMA: JsonSchemaDefinition = {
  name: "resume_experience_item",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      bullets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            claimType: {
              type: "string",
              enum: ["direct", "transferable", "contextual"],
            },
            supportIds: {
              type: "array",
              items: { type: "string" },
            },
            positioningIntent: { type: "string" },
            riskFlags: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["text", "claimType", "supportIds"],
          additionalProperties: false,
        },
      },
    },
    required: ["id", "bullets"],
    additionalProperties: false,
  },
};

const COVERAGE_JUDGE_SCHEMA: JsonSchemaDefinition = {
  name: "resume_alignment_coverage_judge",
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            qualification: { type: "string" },
            status: {
              type: "string",
              enum: ["covered", "repairable", "human_input_needed"],
            },
            sections: {
              type: "array",
              items: { type: "string" },
            },
            evidenceSources: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["qualification", "status", "sections", "evidenceSources"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

const RESUME_POSITIONING_SCHEMA: JsonSchemaDefinition = {
  name: "resume_positioning_plan",
  schema: {
    type: "object",
    properties: {
      candidateThesis: { type: "string" },
      targetPitch: { type: "string" },
      sourcePitch: { type: "string" },
      pitchDelta: { type: "string" },
      allowedTranslations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            claimType: {
              type: "string",
              enum: ["direct", "transferable", "contextual"],
            },
            limit: { type: "string" },
          },
          required: ["from", "to", "claimType", "limit"],
          additionalProperties: false,
        },
      },
      overclaimRisks: {
        type: "array",
        items: { type: "string" },
      },
      experienceUse: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            use: {
              type: "string",
              enum: ["primary", "supporting", "downplayed"],
            },
            reason: { type: "string" },
            rewriteGoal: { type: "string" },
          },
          required: ["id", "use", "reason", "rewriteGoal"],
          additionalProperties: false,
        },
      },
      targetFrame: { type: "string" },
      avoidFrame: {
        type: "array",
        items: { type: "string" },
      },
      primaryEvidenceRoles: {
        type: "array",
        items: { type: "string" },
      },
      supportingEvidenceRoles: {
        type: "array",
        items: { type: "string" },
      },
      downplayedRoles: {
        type: "array",
        items: { type: "string" },
      },
      translationMap: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sourceEvidence: { type: "string" },
            jdFrame: { type: "string" },
            claimType: {
              type: "string",
              enum: ["direct", "transferable", "contextual"],
            },
            limitations: { type: "string" },
          },
          required: ["sourceEvidence", "jdFrame", "claimType", "limitations"],
          additionalProperties: false,
        },
      },
      mustAppearConcepts: {
        type: "array",
        items: { type: "string" },
      },
      mustAvoidConcepts: {
        type: "array",
        items: { type: "string" },
      },
      readerExpectations: {
        type: "array",
        items: { type: "string" },
      },
      summaryStrategy: {
        type: "array",
        items: { type: "string" },
      },
      experienceStrategies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            experienceId: { type: "string" },
            currentRisk: { type: "string" },
            desiredFrame: { type: "string" },
            emphasize: {
              type: "array",
              items: { type: "string" },
            },
            deEmphasize: {
              type: "array",
              items: { type: "string" },
            },
            allowedTransferableClaims: {
              type: "array",
              items: { type: "string" },
            },
            forbiddenClaims: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: [
            "experienceId",
            "currentRisk",
            "desiredFrame",
            "emphasize",
            "deEmphasize",
            "allowedTransferableClaims",
            "forbiddenClaims",
          ],
          additionalProperties: false,
        },
      },
      skillsStrategy: {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                keywords: {
                  type: "array",
                  items: { type: "string" },
                },
                rationale: { type: "string" },
              },
              required: ["name", "keywords", "rationale"],
              additionalProperties: false,
            },
          },
        },
        required: ["groups"],
        additionalProperties: false,
      },
      gapStrategy: {
        type: "array",
        items: {
          type: "object",
          properties: {
            jdNeed: { type: "string" },
            evidenceStatus: {
              type: "string",
              enum: ["direct", "transferable", "weak", "none"],
            },
            wordingPolicy: { type: "string" },
          },
          required: ["jdNeed", "evidenceStatus", "wordingPolicy"],
          additionalProperties: false,
        },
      },
      polishChecks: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: [
      "candidateThesis",
      "targetPitch",
      "sourcePitch",
      "pitchDelta",
      "allowedTranslations",
      "overclaimRisks",
      "experienceUse",
      "targetFrame",
      "avoidFrame",
      "primaryEvidenceRoles",
      "supportingEvidenceRoles",
      "downplayedRoles",
      "translationMap",
      "mustAppearConcepts",
      "mustAvoidConcepts",
      "readerExpectations",
      "summaryStrategy",
      "experienceStrategies",
      "skillsStrategy",
      "gapStrategy",
      "polishChecks",
    ],
    additionalProperties: false,
  },
};

const TAILORING_STRATEGY_SCHEMA: JsonSchemaDefinition = {
  name: "resume_tailoring_strategy",
  schema: {
    type: "object",
    properties: {
      jdServiceValueBrief: JD_SERVICE_VALUE_BRIEF_SCHEMA.schema,
      resumePositioningPlan: RESUME_POSITIONING_SCHEMA.schema,
    },
    required: ["jdServiceValueBrief", "resumePositioningPlan"],
    additionalProperties: false,
  },
};

const TAILORING_COMPACT_JUDGE_SCHEMA: JsonSchemaDefinition = {
  name: "resume_tailoring_compact_judge",
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "needs_patch"] },
      failedSections: {
        type: "array",
        items: {
          type: "string",
          enum: ["summary", "skills", "experience", "coverage", "service_fit"],
        },
      },
      failedExperienceIds: {
        type: "array",
        items: { type: "string" },
      },
      reason: { type: "string" },
      serviceFitReport: RESUME_SERVICE_FIT_SCHEMA.schema,
    },
    required: [
      "verdict",
      "failedSections",
      "failedExperienceIds",
      "reason",
      "serviceFitReport",
    ],
    additionalProperties: false,
  },
};

const TAILORING_PATCH_SCHEMA: JsonSchemaDefinition = {
  name: "resume_tailoring_patch",
  schema: {
    type: "object",
    properties: {
      summarySkillsPatch: {
        type: "object",
        properties: {
          headline: { type: "string" },
          summary: { type: "string" },
          skills: SUMMARY_SKILLS_SCHEMA.schema.properties.skills,
        },
        required: [],
        additionalProperties: false,
      },
      experiencePatches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            bullets: { type: "array", items: { type: "string" } },
            title: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      reason: { type: "string" },
    },
    required: ["summarySkillsPatch", "experiencePatches", "reason"],
    additionalProperties: false,
  },
};

const PITCH_JUDGE_SCHEMA: JsonSchemaDefinition = {
  name: "resume_pitch_judge",
  schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "fail"],
      },
      dominantPitchDetected: { type: "string" },
      targetPitchMatched: { type: "boolean" },
      sourcePitchDominating: { type: "boolean" },
      failedSections: {
        type: "array",
        items: {
          type: "string",
          enum: ["summary", "skills", "experience"],
        },
      },
      failedExperienceIds: {
        type: "array",
        items: { type: "string" },
      },
      reasons: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: [
      "verdict",
      "dominantPitchDetected",
      "targetPitchMatched",
      "sourcePitchDominating",
      "failedSections",
      "failedExperienceIds",
      "reasons",
    ],
    additionalProperties: false,
  },
};

/**
 * Generate tailored resume content (summary, headline, skills) for a job.
 */
export async function generateTailoring(
  jobDescription: string,
  profile: ResumeProfile,
  context: TailoringContext = {},
): Promise<TailoringResult> {
  const [model, writingStyle] = await Promise.all([
    resolveLlmModel("tailoring"),
    getWritingStyle(),
  ]);
  const models = createTailoringModelRouter(model);
  const llm = await createConfiguredLlmService();
  const llmTrace = createTailoringTraceRecorder(llm);
  const preparationCacheKey = buildTailoringPreparationCacheKey({
    jobDescription,
    profile,
    context,
    writingStyle,
  });
  let preparation = getCachedTailoringPreparation(preparationCacheKey);
  if (preparation) {
    llmTrace.push({
      stage: "preparation_cache",
      model: "local",
      provider: "local",
      elapsedMs: 0,
      success: true,
      cacheHit: true,
      generatedVisibleContent: false,
      metadata: { cacheKey: preparationCacheKey.slice(0, 12) },
    });
  } else {
    preparation = await prepareTailoring({
      profile,
      jobDescription,
      context,
      llm,
      model: models.flash,
    });
    setCachedTailoringPreparation(preparationCacheKey, preparation);
  }
  const strategy = await generateTailoringStrategy({
    llm,
    model: models.pro,
    profile,
    jobDescription,
    context,
    preparation,
  });
  const jdServiceValueBrief = strategy.jdServiceValueBrief;
  const resumePositioningPlan = strategy.resumePositioningPlan;
  const framingCandidates = generateFramingCandidates({
    selectedEvidence: preparation.selectedEvidence,
    experienceAnchors: preparation.experienceAnchors,
    experienceDigests: preparation.experienceDigests,
    coveragePlan: preparation.coveragePlan,
    jdRequirements: preparation.jdQualificationProfile.requirements ?? [],
  });
  const hasAnyCandidates =
    framingCandidates.activationCandidates.length > 0 ||
    framingCandidates.blockCheckCandidates.length > 0;
  const shouldRunFramingJudge = hasAnyCandidates && !resumePositioningPlan;
  const framingJudgeResult: FramingJudgeResult | undefined =
    shouldRunFramingJudge
      ? await judgeFramingCandidates({
          llm,
          model: models.flash,
          input: {
            selectedEvidence: preparation.selectedEvidence,
            experienceAnchors: preparation.experienceAnchors,
            experienceDigests: preparation.experienceDigests,
            coveragePlan: preparation.coveragePlan,
            jdRequirements:
              preparation.jdQualificationProfile.requirements ?? [],
          },
          candidates: framingCandidates,
        })
      : undefined;
  const prompt = await buildTailoringPrompt(
    profile,
    jobDescription,
    writingStyle,
    context,
    preparation,
    resumePositioningPlan,
    jdServiceValueBrief,
  );
  const draft = await generateSectionedTailoringDraft({
    llm,
    model: models.pro,
    profile,
    jobDescription,
    writingStyle,
    context,
    preparation,
    resumePositioningPlan,
    jdServiceValueBrief,
    basePrompt: prompt,
    framingJudgeResult,
  });

  let tailoredData = buildTailoredData({
    raw: draft,
    profile,
    writingStyle,
    preparation,
    resumePositioningPlan,
    jdServiceValueBrief,
  });
  const compactJudge = await judgeTailoringCompact({
    llm,
    model: models.flash,
    tailoredData,
    profile,
    preparation,
    resumePositioningPlan,
    jdServiceValueBrief,
  });
  tailoredData = attachServiceFitReport(
    tailoredData,
    compactJudge?.serviceFitReport ??
      buildCompactServiceFitFallback(jdServiceValueBrief, tailoredData),
  );

  if (compactJudge?.verdict === "needs_patch") {
    const patched = await repairTailoringWithPatch({
      llm,
      model: models.pro,
      tailoredData,
      profile,
      writingStyle,
      preparation,
      resumePositioningPlan,
      jdServiceValueBrief,
      compactJudge,
      basePrompt: prompt,
    });
    if (patched) {
      const recheck = await judgeTailoringCompact({
        llm,
        model: models.flash,
        tailoredData: patched,
        profile,
        preparation,
        resumePositioningPlan,
        jdServiceValueBrief,
        force: true,
      });
      const rechecked = attachServiceFitReport(
        patched,
        recheck?.serviceFitReport ??
          buildCompactServiceFitFallback(jdServiceValueBrief, patched),
      );
      if (
        recheck?.verdict === "pass" ||
        isBetterTailoredData({
          next: rechecked,
          current: tailoredData,
          densityRepairRequested: hasDensityRepairGap(
            tailoredData.generationTrace,
          ),
          positioningRepairRequested: hasPositioningQualityGap(tailoredData),
        })
      ) {
        tailoredData = markAutoRewriteAttempted(rechecked);
      } else {
        tailoredData = markAutoRewriteAttempted(tailoredData);
      }
    } else {
      tailoredData = markAutoRewriteAttempted(tailoredData);
    }
  }

  const traceSummary = summarizeTailoringTrace(llmTrace);
  logger.info("Resume tailoring LLM usage", {
    jobTitle: context.jobTitle,
    employer: context.employer,
    llmCallCount: traceSummary.llmCallCount,
    estimatedCostUsd: traceSummary.estimatedCostUsd,
    stages: llmTrace.map((entry) => ({
      stage: entry.stage,
      model: entry.model,
      success: entry.success,
      elapsedMs: entry.elapsedMs,
      estimatedUsd: entry.estimatedUsd,
    })),
  });

  return {
    success: true,
    data: tailoredData,
    llmTrace,
    estimatedCostUsd: traceSummary.estimatedCostUsd,
    llmCallCount: traceSummary.llmCallCount,
  };
}

/**
 * Backwards compatibility wrapper if needed, or alias.
 */
export async function generateSummary(
  jobDescription: string,
  profile: ResumeProfile,
): Promise<{ success: boolean; summary?: string; error?: string }> {
  // If we just need summary, we can discard the rest (or cache it? but here we just return summary)
  const result = await generateTailoring(jobDescription, profile);
  return {
    success: result.success,
    summary: result.data?.summary,
    error: result.error,
  };
}

async function prepareTailoring(args: {
  profile: ResumeProfile;
  jobDescription: string;
  context: TailoringContext;
  llm?: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model?: string;
}): Promise<TailoringPreparation> {
  const jdKeywordProfile = buildJdKeywordProfile({
    title: args.context.jobTitle,
    employer: args.context.employer,
    jobDescription: args.jobDescription,
  });
  const jdQualificationProfile = buildJdQualificationProfile({
    title: args.context.jobTitle,
    employer: args.context.employer,
    jobDescription: args.jobDescription,
  });
  const documentPolicy = resolveDocumentPolicy({
    source: args.context.source,
    title: args.context.jobTitle,
    employer: args.context.employer,
    jobDescription: args.jobDescription,
    jobUrl: args.context.jobUrl,
    applicationLink: args.context.applicationLink,
    location: args.context.location,
    resumeTargetPagesOverride: args.context.resumeTargetPagesOverride,
  });
  const baseDecision = buildResumeGenerationDecision({
    policy: documentPolicy,
    keywordProfile: jdKeywordProfile,
  });
  const formatReferences = await selectFormatReferenceSummaries({
    referenceRoleFamilies: baseDecision.referenceRoleFamilies,
    targetPages: baseDecision.targetPages,
    maxItems: 2,
  });
  const referenceEvidence = await findResumeReferenceEvidenceForQualifications({
    qualificationProfile: jdQualificationProfile,
    maxItems: 5,
  });
  const referenceKnowledgeHits = await findReferenceChunksForQualifications({
    qualificationProfile: jdQualificationProfile,
    keywordProfile: jdKeywordProfile,
    maxChunksPerQualification: 16,
  });
  const fallbackSelectedEvidence = buildSelectedResumeEvidence({
    qualificationProfile: jdQualificationProfile,
    knowledgeHits: referenceKnowledgeHits,
    maxChunksPerRequirement: 3,
  });
  const rerankLlm = args.llm ?? (await createConfiguredLlmService());
  const rerankModel = args.model ?? (await resolveLlmModel("tailoring"));
  const selectedEvidence = await rerankSelectedResumeEvidence({
    llm: rerankLlm,
    model: rerankModel,
    qualificationProfile: jdQualificationProfile,
    knowledgeHits: referenceKnowledgeHits,
    fallbackSelectedEvidence,
  });
  const allExperienceAnchors = await getExperienceAnchorSummaries();
  const experienceAnchors = selectExperienceAnchorsForGeneration({
    anchors: allExperienceAnchors,
    qualificationProfile: jdQualificationProfile,
    selectedEvidence,
    maxAnchors: 8,
  });
  const evidenceReferences = summarizeEvidenceReferenceHits(
    referenceKnowledgeHits,
  );
  const generationDecision = buildResumeGenerationDecision({
    policy: documentPolicy,
    keywordProfile: jdKeywordProfile,
    formatReferences,
    evidenceReferences,
  });
  const referenceItemsForCoverage = mergeReferenceItemsForCoverage(
    referenceEvidence,
    referenceKnowledgeHits,
  );
  const sourceExperiences = getExperienceEvidence(args.profile);
  const coveragePlan = buildResumeCoveragePlan({
    qualificationProfile: jdQualificationProfile,
    resumeSections: buildSourceResumeSections(args.profile),
    referenceItems: referenceItemsForCoverage,
  });
  const evidenceScopes = buildTailoringEvidenceScopes({
    selectedEvidence,
    coveragePlan,
  });
  const experienceDigests = await buildExperienceCapabilityDigests({
    profile: args.profile,
    sourceExperiences,
    qualificationProfile: jdQualificationProfile,
    selectedEvidence: evidenceScopes.experience,
    experienceAnchors,
    llm: rerankLlm,
    model: rerankModel,
  });
  const contentPlan = buildResumeContentPlan({
    profile: args.profile,
    qualificationProfile: jdQualificationProfile,
    keywordProfile: jdKeywordProfile,
    selectedEvidence: evidenceScopes.experience,
    sourceExperiences,
    experienceDigests,
    generationDecision,
  });
  return {
    jdKeywordProfile,
    jdQualificationProfile,
    referenceEvidence,
    referenceKnowledgeHits,
    selectedEvidence,
    evidenceScopes,
    experienceAnchors,
    experienceDigests,
    sourceExperiences,
    coveragePlan,
    generationDecision,
    contentPlan,
  };
}

async function generateTailoringStrategy(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  profile: ResumeProfile;
  jobDescription: string;
  context: TailoringContext;
  preparation: TailoringPreparation;
}): Promise<{
  jdServiceValueBrief: JdServiceValueBrief | null;
  resumePositioningPlan: ResumePositioningPlan | null;
}> {
  const result = await args.llm.callJson<TailoringStrategyResponse>({
    model: args.model,
    messages: [
      {
        role: "user",
        content: buildTailoringStrategyPrompt(args),
      },
    ],
    jsonSchema: TAILORING_STRATEGY_SCHEMA,
    stage: "tailoring_strategy",
    metadata: { generatedVisibleContent: false },
  });
  if (result.success) {
    return {
      jdServiceValueBrief: sanitizeJdServiceValueBrief(
        result.data.jdServiceValueBrief,
      ),
      resumePositioningPlan: sanitizeResumePositioningPlan(
        result.data.resumePositioningPlan,
      ),
    };
  }

  logger.warn("Combined resume tailoring strategy failed; falling back", {
    error: result.error,
    jobTitle: args.context.jobTitle,
    employer: args.context.employer,
  });
  const jdServiceValueBrief = await generateJdServiceValueBrief({
    llm: args.llm,
    model: args.model,
    jobDescription: args.jobDescription,
    jobTitle: args.context.jobTitle,
    employer: args.context.employer,
    jdKeywordProfile: args.preparation.jdKeywordProfile,
    jdQualificationProfile: args.preparation.jdQualificationProfile,
    selectedEvidence: args.preparation.selectedEvidence,
    experienceDigests: args.preparation.experienceDigests,
    contentPlan: args.preparation.contentPlan,
  });
  const resumePositioningPlan = await generateResumePositioningPlan({
    ...args,
    jdServiceValueBrief,
  });
  return { jdServiceValueBrief, resumePositioningPlan };
}

function buildTailoringStrategyPrompt(args: {
  profile: ResumeProfile;
  jobDescription: string;
  context: TailoringContext;
  preparation: TailoringPreparation;
}): string {
  return [
    "You are planning a high-quality JD-tailored resume before any visible writing happens.",
    "Return one JSON object with jdServiceValueBrief and resumePositioningPlan.",
    "Do not write resume bullets. Keep strategy concise, truthful, and grounded in evidence.",
    "",
    "SERVICE-VALUE BRIEF REQUIREMENTS:",
    "- Identify what operational/business/research value the role needs.",
    "- Identify stakeholder needs, deliverables, concepts to signal, and frames to avoid.",
    "- Translate resume proof themes only where evidence supports the claim.",
    "",
    "POSITIONING PLAN REQUIREMENTS:",
    buildResumePositioningPrompt({
      ...args,
      jdServiceValueBrief: null,
    }),
  ].join("\n");
}

async function generateResumePositioningPlan(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  profile: ResumeProfile;
  jobDescription: string;
  context: TailoringContext;
  preparation: TailoringPreparation;
  jdServiceValueBrief: JdServiceValueBrief | null;
  framingJudgeResult?: FramingJudgeResult;
}): Promise<ResumePositioningPlan | null> {
  try {
    const result = await args.llm.callJson<ResumePositioningPlanResponse>({
      model: args.model,
      messages: [
        {
          role: "user",
          content: buildResumePositioningPrompt(args),
        },
      ],
      jsonSchema: RESUME_POSITIONING_SCHEMA,
      stage: "positioning_plan",
      metadata: { generatedVisibleContent: false },
    });
    if (!result.success) {
      logger.warn("Resume positioning plan generation failed", {
        error: result.error,
        jobTitle: args.context.jobTitle,
        employer: args.context.employer,
      });
      return null;
    }
    return sanitizeResumePositioningPlan(result.data);
  } catch (error) {
    logger.warn("Resume positioning plan generation threw", {
      error: error instanceof Error ? error.message : String(error),
      jobTitle: args.context.jobTitle,
      employer: args.context.employer,
    });
    return null;
  }
}

function buildResumePositioningPrompt(args: {
  profile: ResumeProfile;
  jobDescription: string;
  context: TailoringContext;
  preparation: TailoringPreparation;
  jdServiceValueBrief: JdServiceValueBrief | null;
  framingJudgeResult?: FramingJudgeResult;
}): string {
  const {
    jdKeywordProfile,
    jdQualificationProfile,
    coveragePlan,
    selectedEvidence,
    sourceExperiences,
    experienceDigests,
    contentPlan,
  } = args.preparation;
  return [
    "You are planning how to position a resume before rewriting it.",
    "Return a concise JSON strategy only. Do not write resume bullets here.",
    "Goal: reframe the candidate toward the JD reader's expected profile while preserving facts, section order, employer order, dates, credentials, and evidence limits.",
    "Do not invent direct experience for weak/no-evidence requirements. For weak/no-evidence gaps, recommend transferable or interest wording only, or omission.",
    "",
    "JOB CONTEXT:",
    `Title: ${args.context.jobTitle ?? "unknown"}`,
    `Employer: ${args.context.employer ?? "unknown"}`,
    "",
    "JD KEYWORD PROFILE:",
    JSON.stringify(jdKeywordProfile, null, 2),
    "",
    "JD QUALIFICATION PROFILE:",
    JSON.stringify(jdQualificationProfile, null, 2),
    "",
    "QUALIFICATION COVERAGE BRIEF:",
    formatResumeCoveragePlanInstructions(coveragePlan),
    "",
    "CURRENT RESUME EXPERIENCE ORDER:",
    sourceExperiences
      .slice(0, 8)
      .map((item, index) => {
        const digest = experienceDigests.find(
          (entry) =>
            entry.experienceId === item.id ||
            comparableExperienceId(entry.experienceId) ===
              comparableExperienceId(item.id),
        );
        return [
          `- ${item.id || `experience-${index}`}`,
          `  source: ${item.sourceText.slice(0, 900) || "No source text."}`,
          digest ? `  digest: ${digest.capabilitySummary}` : "",
          digest?.blockedClaims?.length
            ? `  blocked claims: ${digest.blockedClaims.slice(0, 6).join("; ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n") || "No visible experience entries.",
    "",
    "CONTENT PLAN:",
    formatResumeContentPlanForPrompt(contentPlan),
    "",
    "SELECTED EVIDENCE:",
    formatSelectedEvidenceForPrompt(selectedEvidence) ||
      "No selected evidence. Keep recommendations conservative.",
    "",
    args.framingJudgeResult
      ? formatFramingBoundariesForPrompt(args.framingJudgeResult)
      : "",
    "JD SERVICE VALUE BRIEF:",
    formatJdServiceValueBriefForPrompt(args.jdServiceValueBrief),
    "",
    "POSITIONING REQUIREMENTS:",
    "- candidateThesis: one concise sentence explaining the JD-specific candidate story.",
    "- targetPitch: the one-sentence first-impression pitch the final resume should project for this JD.",
    "- sourcePitch: the stale or default pitch implied by the source resume if left unrepackaged.",
    "- pitchDelta: the truthful transformation from sourcePitch to targetPitch.",
    "- allowedTranslations: allowed source-to-JD reframings. MUST only contain entries from the ALLOWED list in FRAMING BOUNDARIES above, applied to the correct experience. A framing allowed for one experience MUST NOT be used for a different experience.",
    "- overclaimRisks: concrete claims the final resume must not make. MUST include all entries from the BLOCKED list in FRAMING BOUNDARIES above, plus any additional risks.",
    "- experienceUse: visible experience ids grouped only as primary/supporting/downplayed, with a short rewriteGoal. Do not force every role into targetPitch.",
    "- targetFrame: one sentence naming the candidate profile the final resume should project.",
    "- avoidFrame: frames that would make the resume feel misaligned with the JD, including stale source-resume frames when the JD is buying a different profile.",
    "- primaryEvidenceRoles/supportingEvidenceRoles/downplayedRoles: experience ids grouped by how much they should drive the final resume narrative.",
    "- translationMap: dynamic allowed mappings from source evidence to JD framing. Do not hard-code industries; derive these from this JD and this candidate evidence.",
    "- mustAppearConcepts: 3-6 JD-specific positioning concepts that should visibly appear in the summary/lead narrative if evidence allows.",
    "- mustAvoidConcepts: old or unsupported concepts that must not dominate the final resume.",
    "- readerExpectations: what the JD reader likely wants to see first.",
    "- summaryStrategy: themes the final summary must foreground.",
    "- experienceStrategies: one item per important experience id; preserve current order but define how each should be framed, emphasized, or compressed.",
    "- skillsStrategy.groups: exactly three functional skill groups when possible, using JD language only when evidence-backed or transferable.",
    "- gapStrategy: list important JD needs with direct/transferable/weak/none evidence status and truthful wording policy.",
    "- polishChecks: concise checks for final resume QA.",
  ].join("\n");
}

function formatFramingBoundariesForPrompt(result: FramingJudgeResult): string {
  const lines: string[] = [
    "FRAMING BOUNDARIES (per-experience, evidence-grounded):",
    "",
  ];
  const allExperienceIds = new Set([
    ...Object.keys(result.activeFramingsByExperience),
    ...Object.keys(result.blockedByExperience),
  ]);
  for (const expId of allExperienceIds) {
    const active = result.activeFramingsByExperience[expId] ?? [];
    const blocked = result.blockedByExperience[expId] ?? [];
    if (active.length > 0) {
      lines.push(
        `${expId} ALLOWED: [${active.map((d) => d.framing).join(", ")}]`,
      );
    }
    if (blocked.length > 0) {
      lines.push(
        `${expId} BLOCKED: [${blocked.map((d) => d.framing).join(", ")}]`,
      );
    }
  }
  lines.push("");
  lines.push(
    "RULES: allowedTranslations must only use ALLOWED framings applied to the correct experience. BLOCKED claims must not appear anywhere.",
  );
  return lines.join("\n");
}

function sanitizeResumePositioningPlan(
  value: Partial<ResumePositioningPlan> | null | undefined,
): ResumePositioningPlan | null {
  if (!value || typeof value !== "object") return null;
  const targetFrame = sanitizeText(value.targetFrame ?? "");
  if (!targetFrame) return null;
  const translationMap = Array.isArray(value.translationMap)
    ? value.translationMap
        .map((item) => {
          const claimType = item?.claimType;
          return {
            sourceEvidence: sanitizeText(item?.sourceEvidence ?? ""),
            jdFrame: sanitizeText(item?.jdFrame ?? ""),
            claimType:
              claimType === "direct" ||
              claimType === "transferable" ||
              claimType === "contextual"
                ? claimType
                : "transferable",
            limitations: sanitizeText(item?.limitations ?? ""),
          };
        })
        .filter((item) => item.sourceEvidence && item.jdFrame)
        .slice(0, 12)
    : [];
  const allowedTranslations = Array.isArray(value.allowedTranslations)
    ? value.allowedTranslations
        .map((item) => {
          const claimType = item?.claimType;
          return {
            from: sanitizeText(item?.from ?? ""),
            to: sanitizeText(item?.to ?? ""),
            claimType:
              claimType === "direct" ||
              claimType === "transferable" ||
              claimType === "contextual"
                ? claimType
                : "transferable",
            limit: sanitizeText(item?.limit ?? ""),
          };
        })
        .filter((item) => item.from && item.to)
        .slice(0, 12)
    : [];
  const experienceUse = Array.isArray(value.experienceUse)
    ? value.experienceUse
        .map((item) => {
          const use = item?.use;
          return {
            id: sanitizeText(item?.id ?? ""),
            use:
              use === "primary" || use === "supporting" || use === "downplayed"
                ? use
                : "supporting",
            reason: sanitizeText(item?.reason ?? ""),
            rewriteGoal: sanitizeText(item?.rewriteGoal ?? ""),
          };
        })
        .filter((item) => item.id && item.rewriteGoal)
        .slice(0, 10)
    : [];
  const experienceStrategies = Array.isArray(value.experienceStrategies)
    ? value.experienceStrategies
        .map((item) => ({
          experienceId: sanitizeText(item?.experienceId ?? ""),
          currentRisk: sanitizeText(item?.currentRisk ?? ""),
          desiredFrame: sanitizeText(item?.desiredFrame ?? ""),
          emphasize: sanitizeStringList(item?.emphasize, 8),
          deEmphasize: sanitizeStringList(item?.deEmphasize, 8),
          allowedTransferableClaims: sanitizeStringList(
            item?.allowedTransferableClaims,
            8,
          ),
          forbiddenClaims: sanitizeStringList(item?.forbiddenClaims, 8),
        }))
        .filter((item) => item.experienceId && item.desiredFrame)
        .slice(0, 8)
    : [];
  const skillGroups = Array.isArray(value.skillsStrategy?.groups)
    ? value.skillsStrategy.groups
        .map((group) => ({
          name: sanitizeText(group?.name ?? ""),
          keywords: sanitizeStringList(group?.keywords, 12),
          rationale: sanitizeText(group?.rationale ?? ""),
        }))
        .filter((group) => group.name && group.keywords.length > 0)
        .slice(0, 3)
    : [];
  const gapStrategy = Array.isArray(value.gapStrategy)
    ? value.gapStrategy
        .map((item) => {
          const evidenceStatus = item?.evidenceStatus;
          return {
            jdNeed: sanitizeText(item?.jdNeed ?? ""),
            evidenceStatus:
              evidenceStatus === "direct" ||
              evidenceStatus === "transferable" ||
              evidenceStatus === "weak" ||
              evidenceStatus === "none"
                ? evidenceStatus
                : "none",
            wordingPolicy: sanitizeText(item?.wordingPolicy ?? ""),
          };
        })
        .filter((item) => item.jdNeed && item.wordingPolicy)
        .slice(0, 12)
    : [];
  return {
    generatorVersion: RESUME_POSITIONING_GENERATOR_VERSION,
    candidateThesis: sanitizeText(value.candidateThesis ?? ""),
    targetPitch: sanitizeText(value.targetPitch ?? ""),
    sourcePitch: sanitizeText(value.sourcePitch ?? ""),
    pitchDelta: sanitizeText(value.pitchDelta ?? ""),
    allowedTranslations,
    overclaimRisks: sanitizeStringList(value.overclaimRisks, 12),
    experienceUse,
    targetFrame,
    avoidFrame: sanitizeStringList(value.avoidFrame, 8),
    primaryEvidenceRoles: sanitizeStringList(value.primaryEvidenceRoles, 8),
    supportingEvidenceRoles: sanitizeStringList(
      value.supportingEvidenceRoles,
      8,
    ),
    downplayedRoles: sanitizeStringList(value.downplayedRoles, 8),
    translationMap,
    mustAppearConcepts: sanitizeStringList(value.mustAppearConcepts, 12),
    mustAvoidConcepts: sanitizeStringList(value.mustAvoidConcepts, 12),
    readerExpectations: sanitizeStringList(value.readerExpectations, 8),
    summaryStrategy: sanitizeStringList(value.summaryStrategy, 8),
    experienceStrategies,
    skillsStrategy: { groups: skillGroups },
    gapStrategy,
    polishChecks: sanitizeStringList(value.polishChecks, 8),
  };
}

function sanitizeStringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? uniqueStrings(
        value
          .filter((item): item is string => typeof item === "string")
          .map(sanitizeText)
          .filter(Boolean),
      ).slice(0, limit)
    : [];
}

async function generateSectionedTailoringDraft(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  profile: ResumeProfile;
  jobDescription: string;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  context: TailoringContext;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  basePrompt: string;
  framingJudgeResult?: FramingJudgeResult;
}): Promise<Partial<TailoredData>> {
  const summaryAndSkills = await generateSummaryAndSkills(args);
  const experience = await generateExperienceItems(args);
  return {
    ...summaryAndSkills,
    experience,
  };
}

async function generateSummaryAndSkills(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  profile: ResumeProfile;
  jobDescription: string;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  context: TailoringContext;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  basePrompt: string;
}): Promise<SummaryAndSkillsResponse> {
  const fallback = buildFallbackSummaryAndSkills(args);
  try {
    const result = await args.llm.callJson<SummaryAndSkillsResponse>({
      model: args.model,
      messages: [
        {
          role: "user",
          content: buildSummaryAndSkillsPrompt(args),
        },
      ],
      jsonSchema: SUMMARY_SKILLS_SCHEMA,
      stage: "summary_skills",
      metadata: { generatedVisibleContent: true },
    });
    if (!result.success) {
      logger.warn("Sectioned resume summary/skills generation failed", {
        error: result.error,
        jobTitle: args.context.jobTitle,
        employer: args.context.employer,
      });
      return fallback;
    }
    const sanitized = sanitizeSummaryAndSkills(result.data);
    return sanitized.summary || sanitized.headline ? sanitized : fallback;
  } catch (error) {
    logger.warn("Sectioned resume summary/skills generation threw", {
      error: error instanceof Error ? error.message : String(error),
      jobTitle: args.context.jobTitle,
      employer: args.context.employer,
    });
    return fallback;
  }
}

async function generateExperienceItems(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  profile: ResumeProfile;
  jobDescription: string;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  framingJudgeResult?: FramingJudgeResult;
  context: TailoringContext;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
}): Promise<TailoredExperienceItem[]> {
  const experiences = getVisibleExperienceGenerationContexts(
    args.profile,
    args.preparation.sourceExperiences,
  );
  const selectedExperiences = selectExperienceContextsForGeneration(
    experiences,
    args.preparation.experienceDigests,
    args.resumePositioningPlan,
  );
  const generated: TailoredExperienceItem[] = [];
  for (const experience of selectedExperiences) {
    const item = await generateExperienceItem(args, experience);
    if (item.bullets.length > 0) generated.push(item);
  }
  return generated;
}

function selectExperienceContextsForGeneration(
  experiences: VisibleExperienceGenerationContext[],
  digests: ExperienceCapabilityDigest[],
  plan: ResumePositioningPlan | null,
): VisibleExperienceGenerationContext[] {
  const digestRank = new Map(
    digests.map((digest) => [
      comparableExperienceId(digest.experienceId),
      digest.fitLevel === "primary"
        ? 0
        : digest.fitLevel === "relevant"
          ? 1
          : 2,
    ]),
  );
  const planRank = new Map(
    (plan?.experienceUse ?? []).map((item) => [
      comparableExperienceId(item.id),
      item.use === "primary" ? 0 : item.use === "supporting" ? 1 : 2,
    ]),
  );
  return [...experiences]
    .sort((a, b) => {
      const aId = comparableExperienceId(a.id);
      const bId = comparableExperienceId(b.id);
      const aRank = Math.min(planRank.get(aId) ?? 2, digestRank.get(aId) ?? 2);
      const bRank = Math.min(planRank.get(bId) ?? 2, digestRank.get(bId) ?? 2);
      return aRank - bRank || a.index - b.index;
    })
    .slice(0, MAX_GENERATED_EXPERIENCE_ITEMS);
}

async function generateExperienceItem(
  args: {
    llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
    model: string;
    profile: ResumeProfile;
    jobDescription: string;
    writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
    context: TailoringContext;
    preparation: TailoringPreparation;
    resumePositioningPlan: ResumePositioningPlan | null;
    jdServiceValueBrief: JdServiceValueBrief | null;
    framingJudgeResult?: FramingJudgeResult;
  },
  experience: VisibleExperienceGenerationContext,
): Promise<TailoredExperienceItem> {
  try {
    const evidenceScope = buildExperienceEvidenceScope(args, experience);
    const result = await args.llm.callJson<ResumeExperienceItemResponse>({
      model: args.model,
      messages: [
        {
          role: "user",
          content: buildExperienceItemPrompt(args, experience, evidenceScope),
        },
      ],
      jsonSchema: EXPERIENCE_ITEM_SCHEMA,
      stage: "experience_item",
      metadata: {
        generatedVisibleContent: true,
        experienceId: experience.id,
        allowedChunkCount: evidenceScope.allowedChunkIds.length,
        allowedSections: evidenceScope.allowedSections.join(","),
        blockedChunkCount: evidenceScope.blockedChunkCount,
      },
    });
    if (!result.success) {
      logger.warn("Sectioned resume experience generation failed", {
        error: result.error,
        experienceId: experience.id,
      });
      return { id: experience.id, bullets: [] };
    }
    const sanitized = sanitizeExperience([result.data])[0];
    if (!sanitized) return { id: experience.id, bullets: [] };
    const item = {
      ...sanitized,
      id: sanitized.id || experience.id,
    };
    return verifyExperienceItemBoundary(args, experience, item);
  } catch (error) {
    logger.warn("Sectioned resume experience generation threw", {
      error: error instanceof Error ? error.message : String(error),
      experienceId: experience.id,
    });
    return { id: experience.id, bullets: [] };
  }
}

function verifyExperienceItemBoundary(
  args: {
    preparation: TailoringPreparation;
    resumePositioningPlan: ResumePositioningPlan | null;
    framingJudgeResult?: FramingJudgeResult;
  },
  experience: VisibleExperienceGenerationContext,
  item: TailoredExperienceItem,
): TailoredExperienceItem {
  const allocation = findContentPlanExperienceAllocation(
    args.preparation.contentPlan,
    experience.id,
  );
  const digest = findExperienceDigest(
    args.preparation.experienceDigests,
    experience.id,
  );
  const strategy = findExperienceStrategy(
    args.resumePositioningPlan,
    experience.id,
  );
  const bundles = getExperienceBulletBundles(
    args.preparation.contentPlan,
    experience.id,
  );
  const evidenceScope = buildExperienceEvidenceScope(args, experience);
  const selectedEvidence = evidenceScope.selectedEvidence;
  const scopedBundles = scopeExperienceBulletBundles(
    bundles,
    evidenceScope.allowedChunkIds,
  );
  const bundleById = new Map(
    scopedBundles.map((bundle) => [bundle.bundleId, bundle]),
  );
  const chunkIds = new Set([
    ...(allocation?.evidenceChunkIds ?? []),
    ...(digest?.sourceChunkIds ?? []),
    ...scopedBundles.flatMap((bundle) => bundle.sourceChunkIds),
    ...selectedEvidence.flatMap((evidence) =>
      evidence.chunks.map((chunk) => chunk.chunkId),
    ),
  ]);
  const blockedClaims = uniqueStrings([
    ...(digest?.blockedClaims ?? []),
    ...(strategy?.forbiddenClaims ?? []),
    ...scopedBundles.flatMap((bundle) => bundle.blockedClaims),
    ...selectedEvidence.flatMap((evidence) => evidence.blockedClaims ?? []),
  ]);
  const bullets: string[] = [];
  const bulletTrace: NonNullable<TailoredExperienceItem["bulletTrace"]> = [];
  for (let index = 0; index < item.bullets.length; index += 1) {
    const original = item.bullets[index];
    const trace = item.bulletTrace?.[index];
    // v1c-1: Extract claims on original bullet before any repair
    const claimVerdicts = args.framingJudgeResult
      ? extractClaims(original, args.framingJudgeResult, experience.id)
      : undefined;
    // v1c-2: Targeted repair of blocked framing/audience claims
    let repairResult:
      | {
          repaired: string;
          repairMode: "targeted" | "fallback" | "fallback_failed" | "none";
          repairs: string[];
        }
      | undefined;
    if (claimVerdicts?.some((c) => c.verdict === "blocked")) {
      repairResult = repairBlockedClaims(original, claimVerdicts);
    }
    let workingBullet =
      repairResult?.repairMode === "targeted"
        ? repairResult.repaired
        : original;
    // v1c-3: If targeted repair broke the bullet, try fallback
    if (
      repairResult?.repairMode === "targeted" &&
      args.framingJudgeResult &&
      isRepairBroken(
        original,
        repairResult.repaired,
        claimVerdicts ?? [],
        args.framingJudgeResult,
        experience.id,
      )
    ) {
      const digest = findExperienceDigest(
        args.preparation.experienceDigests,
        experience.id,
      );
      const anchor = args.preparation.experienceAnchors.find(
        (a) => a.experienceAnchorId === experience.id,
      );
      const fallbackResult = buildFallbackBullet({
        original,
        claims: claimVerdicts ?? [],
        framingJudgeResult: args.framingJudgeResult,
        experienceId: experience.id,
        experienceAnchor: anchor
          ? {
              responsibilityAreas: anchor.responsibilityAreas.map(
                (a) => a.text,
              ),
              toolsAndMethods: anchor.toolsAndMethods.map((a) => a.text),
              stakeholders: anchor.stakeholders.map((a) => a.text),
            }
          : undefined,
        experienceDigest: digest
          ? { coreClaims: digest.coreClaims }
          : undefined,
      });
      if (fallbackResult.source !== "none" && fallbackResult.bullet) {
        // Validate fallback
        const fallbackClaims = args.framingJudgeResult
          ? extractClaims(
              fallbackResult.bullet,
              args.framingJudgeResult,
              experience.id,
            )
          : [];
        if (!fallbackClaims.some((c) => c.verdict === "blocked")) {
          workingBullet = fallbackResult.bullet;
          repairResult = {
            repaired: fallbackResult.bullet,
            repairMode: "fallback",
            repairs: [
              ...(repairResult?.repairs ?? []),
              `fallback: ${fallbackResult.source} — ${fallbackResult.reasons.join("; ")}`,
            ],
          };
        } else {
          repairResult = {
            repaired: repairResult.repaired,
            repairMode: "fallback_failed",
            repairs: [
              ...(repairResult?.repairs ?? []),
              "fallback discarded — still contains blocked claims",
            ],
          };
        }
      }
    }
    if (!trace?.claimType) {
      bullets.push(workingBullet);
      bulletTrace.push({
        ...(trace ?? { claimSource: "ai_generated" }),
        boundaryVerdict: trace?.boundaryVerdict ?? "legacy",
        claimVerdicts,
        repairMode: repairResult?.repairMode,
        repairs: repairResult?.repairs,
      });
      continue;
    }
    const supportIds = trace.evidenceChunkIds ?? [];
    const supportChunks = new Set<string>();
    const supportBundles: string[] = [];
    const unknownSupportIds: string[] = [];
    for (const supportId of supportIds) {
      const bundle = bundleById.get(supportId);
      if (bundle) {
        supportBundles.push(bundle.bundleId);
        for (const chunkId of bundle.sourceChunkIds) supportChunks.add(chunkId);
        continue;
      }
      if (chunkIds.has(supportId)) {
        supportChunks.add(supportId);
        continue;
      }
      unknownSupportIds.push(supportId);
    }
    const reasons = buildBoundaryReasons({
      bullet: workingBullet,
      claimType: trace.claimType,
      supportChunks: [...supportChunks],
      unknownSupportIds,
      blockedClaims,
      coveragePlan: args.preparation.coveragePlan,
    });
    const hasHardFailure = reasons.some((reason) =>
      /blocked|unknown support|no support|weak\/none/i.test(reason),
    );
    if (hasHardFailure && trace.claimType === "direct") {
      const softened = softenDirectBullet(workingBullet);
      bullets.push(softened);
      bulletTrace.push({
        ...trace,
        claimType: "transferable",
        bundleId: trace.bundleId ?? supportBundles[0],
        evidenceChunkIds: [...supportChunks].slice(0, 5),
        boundaryVerdict: "softened",
        boundaryReasons: reasons,
        claimVerdicts,
        repairMode: repairResult?.repairMode,
        repairs: repairResult?.repairs,
      });
      continue;
    }
    if (hasHardFailure && trace.claimType !== "contextual") {
      bulletTrace.push({
        ...trace,
        bundleId: trace.bundleId ?? supportBundles[0],
        evidenceChunkIds: [...supportChunks].slice(0, 5),
        boundaryVerdict: "dropped",
        boundaryReasons: reasons,
        claimVerdicts,
        repairMode: repairResult?.repairMode,
        repairs: repairResult?.repairs,
      });
      continue;
    }
    bullets.push(workingBullet);
    bulletTrace.push({
      ...trace,
      bundleId: trace.bundleId ?? supportBundles[0],
      evidenceChunkIds: [...supportChunks].slice(0, 5),
      boundaryVerdict: reasons.length ? "softened" : "pass",
      boundaryReasons: reasons,
      claimVerdicts,
      repairMode: repairResult?.repairMode,
      repairs: repairResult?.repairs,
    });
  }
  return {
    ...item,
    bullets,
    bulletTrace,
  };
}

function buildBoundaryReasons(args: {
  bullet: string;
  claimType: "direct" | "transferable" | "contextual";
  supportChunks: string[];
  unknownSupportIds: string[];
  blockedClaims: string[];
  coveragePlan: ResumeCoveragePlan;
}): string[] {
  const reasons: string[] = [];
  const bulletText = normalizeComparable(args.bullet);
  if (args.unknownSupportIds.length > 0) {
    reasons.push(`unknown support ids: ${args.unknownSupportIds.join(", ")}`);
  }
  if (args.claimType === "direct" && args.supportChunks.length === 0) {
    reasons.push("direct claim has no same-experience evidence support");
  }
  for (const blocked of args.blockedClaims) {
    if (blocked && bulletText.includes(normalizeComparable(blocked))) {
      reasons.push(`blocked claim: ${blocked}`);
    }
  }
  const weakDirectGaps = args.coveragePlan.items.filter(
    (item) =>
      (item.evidenceStatus === "none" ||
        item.evidenceStatus === "transferable") &&
      item.allowedWordingHints.some((hint) =>
        bulletText.includes(normalizeComparable(hint)),
      ),
  );
  if (args.claimType === "direct" && weakDirectGaps.length > 0) {
    reasons.push(
      `weak/none JD need used as direct claim: ${weakDirectGaps
        .slice(0, 2)
        .map((item) => item.qualification)
        .join("; ")}`,
    );
  }
  return uniqueStrings(reasons).slice(0, 5);
}

function softenDirectBullet(text: string): string {
  const softened = text
    .replace(/\b(Led|Owned|Directed|Advised|Managed)\b/g, "Contributed to")
    .replace(/\b(lead|own|direct|advise|manage)\b/gi, "support")
    .replace(/\bdirect experience\b/gi, "transferable experience");
  return sanitizeText(
    /^Applied transferable/.test(softened)
      ? softened
      : `Applied transferable ${softened.charAt(0).toLowerCase()}${softened.slice(1)}`,
  );
}

function buildSummaryAndSkillsPrompt(args: {
  profile: ResumeProfile;
  jobDescription: string;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  context: TailoringContext;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  basePrompt: string;
}): string {
  const plan = formatResumePositioningPlanForPrompt(args.resumePositioningPlan);
  const skillsBrief = buildSkillsBrief({
    profile: args.profile,
    jdKeywordProfile: args.preparation.jdKeywordProfile,
    coveragePlan: args.preparation.coveragePlan,
    selectedEvidence: args.preparation.evidenceScopes.skills,
  });
  const summaryBrief = buildSummaryBrief({
    coveragePlan: args.preparation.coveragePlan,
  });
  const summarySkillsEvidence = mergeSelectedEvidenceScopes(
    args.preparation.evidenceScopes.summary,
    args.preparation.evidenceScopes.skills,
  );
  const selectedEvidence = formatSelectedEvidenceForPrompt(
    summarySkillsEvidence,
  );
  return [
    args.basePrompt,
    "",
    "SECTIONED GENERATION PASS: SUMMARY AND SKILLS ONLY.",
    "Return JSON with exactly: headline, summary, skills. Do not return experience.",
    "SECTION EVIDENCE POLICY: headline/summary may use Summary, Profile, Objective, Experience, Projects, Skills, and General chunks only; skills may use Skills, Experience, Projects, and General chunks only. Do not use Education, Certifications, Cover Letter, or unrelated section chunks as support for new summary or skills claims unless the text is already present in the master resume.",
    "The final summary must project the candidateThesis/targetFrame when a positioning plan is available.",
    "The first sentence or first summary bullet must visibly include at least one mustAppearConcept or a short targetFrame phrase. Do not bury the target positioning only in skills or later experience.",
    "When a JD service-value brief is available, the first summary sentence must visibly sell the candidateValueProposition or buyerNeed using evidence-backed language. Generic research/strategy/workforce/public-sector framing is not enough unless that is the buyerNeed.",
    "Use mustSignalConcepts as the summary spine where evidence allows, and keep avoidDominantFrames out of the headline and first summary sentence.",
    "If the source resume has older framing listed in avoidFrame or mustAvoidConcepts, do not use that framing in the headline, summary, or lead bullets unless the JD itself asks for it.",
    "Prefer 3-4 compact qualification-style summary bullets separated by semicolons or short sentences; if the existing template renders a paragraph, keep the same content tight enough to merge cleanly.",
    "The skills section must use exactly 3 functional groups unless the content plan explicitly allows fewer.",
    "Prefer skillsStrategy.groups names and JD/ATS keywords, but only when supported by master skills, selected evidence, or truthful transferable capability.",
    "Do not turn weak/no-evidence gaps into direct skills or direct experience claims.",
    "",
    "POSITIONING PLAN:",
    plan ||
      "No positioning plan. Use the existing conservative generator behavior.",
    "",
    "JD SERVICE VALUE BRIEF:",
    formatJdServiceValueBriefForPrompt(args.jdServiceValueBrief),
    "",
    "SUMMARY TARGETS:",
    summaryBrief,
    "",
    "SKILLS TARGETS:",
    skillsBrief,
    selectedEvidence ? `\nSELECTED EVIDENCE:\n${selectedEvidence}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildExperienceItemPrompt(
  args: {
    profile: ResumeProfile;
    jobDescription: string;
    writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
    context: TailoringContext;
    preparation: TailoringPreparation;
    resumePositioningPlan: ResumePositioningPlan | null;
    jdServiceValueBrief: JdServiceValueBrief | null;
  },
  experience: VisibleExperienceGenerationContext,
  evidenceScope = buildExperienceEvidenceScope(args, experience),
): string {
  const allocation = findContentPlanExperienceAllocation(
    args.preparation.contentPlan,
    experience.id,
  );
  const digest = findExperienceDigest(
    args.preparation.experienceDigests,
    experience.id,
  );
  const strategy = findExperienceStrategy(
    args.resumePositioningPlan,
    experience.id,
  );
  const bundles = getExperienceBulletBundles(
    args.preparation.contentPlan,
    experience.id,
  );
  const coverageTargets = buildExperienceCoverageTargets({
    preparation: args.preparation,
    experience,
    allocation,
  });
  const targetBudget = allocation?.bulletBudget ?? 3;
  const maxBudget =
    allocation?.maxBulletBudget ?? Math.min(6, Math.max(3, targetBudget + 1));
  return [
    "SECTIONED GENERATION PASS: ONE EXPERIENCE ITEM ONLY.",
    "Return JSON with exactly: id, bullets. Each bullet must be an object with text, claimType, supportIds, positioningIntent, and riskFlags.",
    `Use id exactly: ${experience.id}`,
    `Output ${Math.max(1, targetBudget - 1)}-${maxBudget} bullets based on this role's relevance and evidence. Strong/direct fit can be denser; weak/background fit should be concise.`,
    "Preserve facts. Do not invent employers, tools, credentials, dates, metrics, industries, clients, or direct responsibilities.",
    "Use only this experience's source text, digest, ALLOWED evidence, and bullet bundles. Do not borrow claims from other experiences.",
    "supportIds must name source-backed chunk ids or bundle ids shown below. Chunk supportIds must come from ALLOWED_EVIDENCE_IDS. Use direct only when this role directly supports the wording. Use transferable for adjacent methods/tools/deliverables. Use contextual only for interest/exposure without claiming performed experience.",
    "If a requirement is weak/no-evidence, use transferable/interest wording only or omit it. Never state it as direct experience.",
    "When the JD service-value brief is available and this role has relevant evidence, at least one lead bullet should translate the work into the buyerNeed, expectedDeliverables, or businessDecisionsSupported. Do not leave the role framed only as its old domain.",
    "For market intelligence / market research JDs, source-backed labour-market, sector, policy, stakeholder, Excel/Python/SAS data, dashboard, memo, and deck evidence may be translated into market intelligence, market research, or business/data analytics wording when the supportIds prove the underlying work.",
    "Do not claim direct health sector expertise, consumer insights, CPG category strategy, healthcare market expertise, or venture portfolio ownership unless this experience source or selected evidence explicitly supports that exact claim.",
    "",
    "JOB CONTEXT:",
    `Title: ${args.context.jobTitle ?? "unknown"}`,
    `Employer: ${args.context.employer ?? "unknown"}`,
    "",
    "POSITIONING PLAN:",
    formatResumePositioningPlanForPrompt(args.resumePositioningPlan) ||
      "No positioning plan. Keep wording conservative and evidence-bound.",
    "",
    "JD SERVICE VALUE BRIEF:",
    formatJdServiceValueBriefForPrompt(args.jdServiceValueBrief),
    "",
    "THIS EXPERIENCE STRATEGY:",
    strategy
      ? JSON.stringify(strategy, null, 2)
      : "No specific strategy; follow digest and coverage targets.",
    "",
    "THIS EXPERIENCE SOURCE:",
    JSON.stringify(
      {
        id: experience.id,
        label: experience.label,
        company: experience.company,
        position: experience.position,
        date: experience.date,
        sourceText: experience.sourceText || "No source text.",
      },
      null,
      2,
    ),
    "",
    "THIS EXPERIENCE DIGEST:",
    digest ? JSON.stringify(digest, null, 2) : "No digest.",
    "",
    "CONTENT PLAN ALLOCATION:",
    allocation ? JSON.stringify(allocation, null, 2) : "No allocation.",
    "",
    "EXPERIENCE COVERAGE TARGETS:",
    coverageTargets || "No explicit coverage targets. Keep continuity concise.",
    "",
    "THIS EXPERIENCE BULLET BUNDLES:",
    formatExperienceBulletBundlesForPrompt(
      scopeExperienceBulletBundles(bundles, evidenceScope.allowedChunkIds),
    ),
    "",
    "ALLOWED_EVIDENCE_IDS:",
    evidenceScope.allowedChunkIds.length
      ? evidenceScope.allowedChunkIds.join(", ")
      : "None. Use source text, digest, and bullet bundles only.",
    "",
    "BLOCKED_EVIDENCE_POLICY:",
    [
      "Do not use Education, Certifications, Cover Letter, or unrelated role chunks as supportIds for this experience.",
      "Do not use globally selected chunks that are absent from ALLOWED_EVIDENCE_IDS.",
      "Projects chunks are usable only when shown below as allowed fallback evidence.",
    ].join(" "),
    "",
    "THIS EXPERIENCE SCOPED EVIDENCE:",
    formatSelectedEvidenceForPrompt(evidenceScope.selectedEvidence) ||
      "No selected evidence for this experience. Use source text and digest only.",
  ].join("\n");
}

function sanitizeSummaryAndSkills(
  value: Partial<SummaryAndSkillsResponse> | null | undefined,
): SummaryAndSkillsResponse {
  const skills = Array.isArray(value?.skills)
    ? value.skills
        .map((group) => ({
          name: sanitizeText(group?.name ?? ""),
          keywords: sanitizeStringList(group?.keywords, 12),
        }))
        .filter((group) => group.name && group.keywords.length > 0)
        .slice(0, 4)
    : [];
  return {
    headline: sanitizeText(value?.headline ?? ""),
    summary: sanitizeText(value?.summary ?? ""),
    skills,
  };
}

function buildFallbackSummaryAndSkills(args: {
  profile: ResumeProfile;
  context: TailoringContext;
}): SummaryAndSkillsResponse {
  const skillItems =
    (
      args.profile.sections?.skills as unknown as {
        items?: Array<{
          name?: string;
          keywords?: string[];
          visible?: boolean;
        }>;
      }
    )?.items ?? [];
  return {
    headline: sanitizeText(
      args.context.jobTitle ?? args.profile.basics?.label ?? "Candidate",
    ),
    summary: sanitizeText(args.profile.basics?.summary ?? ""),
    skills: skillItems
      .filter((group) => group.visible !== false)
      .map((group) => ({
        name: sanitizeText(group.name ?? ""),
        keywords: sanitizeStringList(group.keywords, 12),
      }))
      .filter((group) => group.name && group.keywords.length > 0)
      .slice(0, 3),
  };
}

function getVisibleExperienceGenerationContexts(
  profile: ResumeProfile,
  sourceExperiences: ExperienceEvidence[],
): VisibleExperienceGenerationContext[] {
  return (
    profile.sections?.experience?.items
      ?.filter((item) => {
        const record = item as typeof item & { hidden?: boolean };
        return item.visible !== false && record.hidden !== true;
      })
      .map((item, index) => {
        const record = item as typeof item & {
          description?: string;
          period?: string;
        };
        const id = item.id || `experience-${index}`;
        const sourceText =
          sourceExperiences.find((source) => source.id === id)?.sourceText ??
          sanitizeText(
            stripHtml(
              [item.summary, record.description]
                .filter((value): value is string => Boolean(value))
                .join("\n"),
            ),
          );
        const position = sanitizeText(item.position ?? "");
        const company = sanitizeText(item.company ?? "");
        return {
          id,
          index,
          label: [position, company].filter(Boolean).join(" at ") || id,
          company,
          position,
          date: sanitizeText(item.date || record.period || ""),
          sourceText,
        };
      }) ?? []
  );
}

function findContentPlanExperienceAllocation(
  contentPlan: ResumeContentPlan,
  experienceId: string,
): ResumeContentPlan["experienceAllocations"][number] | undefined {
  const comparableId = comparableExperienceId(experienceId);
  return contentPlan.experienceAllocations.find(
    (item) =>
      item.experienceId === experienceId ||
      comparableExperienceId(item.experienceId) === comparableId,
  );
}

function findExperienceDigest(
  digests: ExperienceCapabilityDigest[],
  experienceId: string,
): ExperienceCapabilityDigest | undefined {
  const comparableId = comparableExperienceId(experienceId);
  return digests.find(
    (item) =>
      item.experienceId === experienceId ||
      comparableExperienceId(item.experienceId) === comparableId,
  );
}

function findExperienceStrategy(
  plan: ResumePositioningPlan | null,
  experienceId: string,
): ResumePositioningPlan["experienceStrategies"][number] | undefined {
  const comparableId = comparableExperienceId(experienceId);
  return plan?.experienceStrategies.find(
    (item) =>
      item.experienceId === experienceId ||
      comparableExperienceId(item.experienceId) === comparableId,
  );
}

function getExperienceBulletBundles(
  contentPlan: ResumeContentPlan,
  experienceId: string,
): ExperienceBulletBundle[] {
  const comparableId = comparableExperienceId(experienceId);
  return (contentPlan.bulletBundleCandidates ?? [])
    .filter(
      (bundle) =>
        bundle.experienceId === experienceId ||
        comparableExperienceId(bundle.experienceId) === comparableId,
    )
    .slice(0, 12);
}

function buildExperienceEvidenceScope(
  args: {
    preparation: TailoringPreparation;
  },
  experience: VisibleExperienceGenerationContext,
): ExperienceEvidenceScope {
  const allocation = findContentPlanExperienceAllocation(
    args.preparation.contentPlan,
    experience.id,
  );
  const digest = findExperienceDigest(
    args.preparation.experienceDigests,
    experience.id,
  );
  const bundles = getExperienceBulletBundles(
    args.preparation.contentPlan,
    experience.id,
  );
  const selectedEvidence = selectEvidenceForExperience({
    selectedEvidence: args.preparation.selectedEvidence,
    experience,
    allocation,
    digest,
    bundles,
  });
  const allowedChunkIds = uniqueStrings(
    selectedEvidence.flatMap((item) =>
      item.chunks.map((chunk) => chunk.chunkId),
    ),
  );
  const allowedChunkIdSet = new Set(allowedChunkIds);
  const allowedSections = uniqueStrings(
    selectedEvidence.flatMap((item) =>
      item.chunks.map((chunk) => chunk.section),
    ),
  ).sort();
  const blockedChunkCount = uniqueStrings(
    args.preparation.selectedEvidence
      .flatMap((item) => item.chunks.map((chunk) => chunk.chunkId))
      .filter((chunkId) => !allowedChunkIdSet.has(chunkId)),
  ).length;
  return {
    selectedEvidence,
    allowedChunkIds,
    allowedSections,
    blockedChunkCount,
  };
}

function buildTailoringEvidenceScopes(args: {
  selectedEvidence: SelectedResumeEvidence[];
  coveragePlan: ResumeCoveragePlan;
}): TailoringEvidenceScopes {
  return {
    summary: filterSelectedEvidenceForSectionScope({
      ...args,
      target: "summary",
      sourceSections: [
        "summary",
        "profile",
        "objective",
        "experience",
        "projects",
        "skills",
        "general",
      ],
      compatibleTargets: ["summary", "experience", "projects", "skills"],
    }),
    skills: filterSelectedEvidenceForSectionScope({
      ...args,
      target: "skills",
      sourceSections: [
        "skills",
        "technical skills",
        "core competencies",
        "experience",
        "projects",
        "general",
      ],
      compatibleTargets: ["skills"],
    }),
    experience: filterSelectedEvidenceForSectionScope({
      ...args,
      target: "experience",
      sourceSections: ["experience", "projects", "general"],
      compatibleTargets: ["experience"],
    }),
    projects: filterSelectedEvidenceForSectionScope({
      ...args,
      target: "projects",
      sourceSections: ["projects", "portfolio", "experience", "general"],
      compatibleTargets: ["projects"],
    }),
    education: filterSelectedEvidenceForSectionScope({
      ...args,
      target: "education",
      sourceSections: [
        "education",
        "academic",
        "certifications",
        "credentials",
        "general",
      ],
      compatibleTargets: ["education"],
    }),
    general: filterSelectedEvidenceForSectionScope({
      ...args,
      target: "general",
      sourceSections: ["general"],
      compatibleTargets: [
        "summary",
        "skills",
        "experience",
        "projects",
        "education",
      ],
    }),
  };
}

function filterSelectedEvidenceForSectionScope(args: {
  selectedEvidence: SelectedResumeEvidence[];
  coveragePlan: ResumeCoveragePlan;
  target: TailoringEvidenceScopeName;
  sourceSections: string[];
  compatibleTargets: string[];
}): SelectedResumeEvidence[] {
  const sourceSections = new Set(
    args.sourceSections.map(normalizeEvidenceSectionName),
  );
  return args.selectedEvidence
    .map((item) => {
      const targetSections = getEvidenceTargetSections(item, args.coveragePlan);
      const compatible =
        targetSections.length === 0 ||
        targetSections.some((section) =>
          args.compatibleTargets.includes(
            normalizeEvidenceSectionName(section),
          ),
        );
      const chunks = item.chunks.filter((chunk) =>
        sourceSections.has(normalizeEvidenceSectionName(chunk.section)),
      );
      if (chunks.length > 0 && compatible) return { ...item, chunks };
      if (isUnsupportedSelectedEvidence(item) && compatible)
        return { ...item, chunks: [] };
      return null;
    })
    .filter((item): item is SelectedResumeEvidence => Boolean(item));
}

function getEvidenceTargetSections(
  item: SelectedResumeEvidence,
  coveragePlan: ResumeCoveragePlan,
): string[] {
  const comparableRequirementId = normalizeComparable(item.requirementId ?? "");
  const comparableRequirement = normalizeComparable(item.requirement);
  const planItem = coveragePlan.items.find((candidate) => {
    const candidateId = normalizeComparable(candidate.qualification);
    return (
      (comparableRequirementId && comparableRequirementId === candidateId) ||
      normalizeComparable(candidate.qualification) === comparableRequirement ||
      comparableRequirement.includes(
        normalizeComparable(candidate.qualification),
      ) ||
      normalizeComparable(candidate.qualification).includes(
        comparableRequirement,
      )
    );
  });
  return planItem?.targetSections ?? [];
}

function isUnsupportedSelectedEvidence(item: SelectedResumeEvidence): boolean {
  return (
    item.status === "no_evidence" ||
    item.status === "weak_evidence" ||
    item.chunks.length === 0 ||
    (item.blockedClaims?.length ?? 0) > 0
  );
}

function normalizeEvidenceSectionName(section: string): string {
  const normalized = normalizeComparable(section);
  if (/(technical skills|core competencies|skills?)/.test(normalized))
    return "skills";
  if (/(professional experience|work history|experience)/.test(normalized))
    return "experience";
  if (
    /(selected projects|project experience|portfolio|projects?)/.test(
      normalized,
    )
  )
    return "projects";
  if (/(academic|education)/.test(normalized)) return "education";
  if (/(certifications?|credentials?)/.test(normalized))
    return "certifications";
  if (/(profile|objective|summary)/.test(normalized)) return "summary";
  if (normalized === "general") return "general";
  return normalized;
}

function mergeSelectedEvidenceScopes(
  ...scopes: SelectedResumeEvidence[][]
): SelectedResumeEvidence[] {
  const merged = new Map<string, SelectedResumeEvidence>();
  for (const scope of scopes) {
    for (const item of scope) {
      const key = item.requirementId ?? normalizeComparable(item.requirement);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...item, chunks: [...item.chunks] });
        continue;
      }
      const chunksById = new Map(
        existing.chunks.map((chunk) => [chunk.chunkId, chunk] as const),
      );
      for (const chunk of item.chunks) chunksById.set(chunk.chunkId, chunk);
      merged.set(key, {
        ...existing,
        chunks: Array.from(chunksById.values()),
        blockedClaims: uniqueStrings([
          ...(existing.blockedClaims ?? []),
          ...(item.blockedClaims ?? []),
        ]),
        allowedClaims: uniqueStrings([
          ...(existing.allowedClaims ?? []),
          ...(item.allowedClaims ?? []),
        ]),
      });
    }
  }
  return Array.from(merged.values());
}

function scopeExperienceBulletBundles(
  bundles: ExperienceBulletBundle[],
  allowedChunkIds: string[],
): ExperienceBulletBundle[] {
  const allowed = new Set(allowedChunkIds);
  return bundles.filter((bundle) => {
    if (bundle.sourceChunkIds.length === 0) return true;
    return bundle.sourceChunkIds.every((chunkId) => allowed.has(chunkId));
  });
}

function selectEvidenceForExperience(args: {
  selectedEvidence: SelectedResumeEvidence[];
  experience: VisibleExperienceGenerationContext;
  allocation?: ResumeContentPlan["experienceAllocations"][number];
  digest?: ExperienceCapabilityDigest;
  bundles: ExperienceBulletBundle[];
}): SelectedResumeEvidence[] {
  const evidenceChunkIds = new Set([
    ...(args.allocation?.evidenceChunkIds ?? []),
    ...(args.digest?.sourceChunkIds ?? []),
  ]);
  const matchedRequirementIds = new Set([
    ...(args.allocation?.coveredRequirementIds ?? []),
    ...(args.digest?.matchedRequirementIds ?? []),
    ...args.bundles.flatMap((bundle) => bundle.matchedRequirementIds),
  ]);
  return args.selectedEvidence
    .map((item) => {
      const chunks = item.chunks.filter((chunk) =>
        isExperienceEvidenceChunkAllowed({
          chunk,
          experience: args.experience,
          explicitChunkIds: evidenceChunkIds,
        }),
      );
      if (
        chunks.length === 0 &&
        item.requirementId &&
        !matchedRequirementIds.has(item.requirementId)
      ) {
        return null;
      }
      return { ...item, chunks };
    })
    .filter((item): item is SelectedResumeEvidence => Boolean(item))
    .slice(0, 8);
}

function isExperienceEvidenceChunkAllowed(args: {
  chunk: SelectedResumeEvidence["chunks"][number];
  experience: VisibleExperienceGenerationContext;
  explicitChunkIds: Set<string>;
}): boolean {
  if (isBlockedExperienceEvidenceSection(args.chunk.section)) return false;
  const section = normalizeComparable(args.chunk.section);
  const explicit = args.explicitChunkIds.has(args.chunk.chunkId);
  const sameAnchor = chunkMatchesExperienceAnchor(
    args.chunk,
    args.experience.id,
  );
  const matchesExperience = chunkMatchesExperience(
    [
      args.chunk.rawText,
      args.chunk.sourceFile,
      args.chunk.relativePath,
      args.chunk.evidenceGroupLabel,
    ]
      .filter(Boolean)
      .join(" "),
    args.experience,
  );
  if (sameAnchor) return true;
  if (section === "experience") return explicit || matchesExperience;
  if (section === "projects") return explicit || matchesExperience;
  if (section === "general") return explicit;
  return false;
}

function isBlockedExperienceEvidenceSection(section: string): boolean {
  const normalized = normalizeComparable(section);
  return (
    normalized.includes("education") ||
    normalized.includes("certification") ||
    normalized.includes("credential") ||
    normalized.includes("cover")
  );
}

function chunkMatchesExperienceAnchor(
  chunk: SelectedResumeEvidence["chunks"][number],
  experienceId: string,
): boolean {
  if (!chunk.experienceAnchorId) return false;
  return (
    comparableExperienceId(chunk.experienceAnchorId) ===
    comparableExperienceId(experienceId)
  );
}

function buildExperienceCoverageTargets(args: {
  preparation: TailoringPreparation;
  experience: VisibleExperienceGenerationContext;
  allocation?: ResumeContentPlan["experienceAllocations"][number];
}): string {
  const coveredRequirementIds = new Set(
    args.allocation?.coveredRequirementIds ?? [],
  );
  const experienceText = normalizeComparable(
    [
      args.experience.label,
      args.experience.company,
      args.experience.position,
      args.experience.sourceText,
    ].join(" "),
  );
  return args.preparation.coveragePlan.items
    .filter((item) => {
      if (!item.targetSections.includes("experience")) return false;
      if (coveredRequirementIds.has(normalizeComparable(item.qualification))) {
        return true;
      }
      const qualificationText = normalizeComparable(item.qualification);
      return qualificationText
        .split(/\s+/)
        .some((term) => term.length > 4 && experienceText.includes(term));
    })
    .slice(0, 6)
    .map((item) => {
      const hints = item.allowedWordingHints.length
        ? ` | allowed wording: ${item.allowedWordingHints.slice(0, 5).join(", ")}`
        : "";
      return `- [${item.evidenceStatus}; ${item.status}] ${item.qualification}${hints}`;
    })
    .join("\n");
}

function chunkMatchesExperience(
  rawText: string,
  experience: VisibleExperienceGenerationContext,
): boolean {
  const chunkText = normalizeComparable(rawText);
  if (!chunkText) return false;
  if (
    experience.company &&
    chunkText.includes(normalizeComparable(experience.company))
  ) {
    return true;
  }
  if (
    experience.position &&
    chunkText.includes(normalizeComparable(experience.position))
  ) {
    return true;
  }
  const terms = normalizeComparable(
    [experience.label, experience.sourceText].join(" "),
  )
    .split(/\s+/)
    .filter((term) => term.length >= 5)
    .slice(0, 30);
  return terms.filter((term) => chunkText.includes(term)).length >= 3;
}

function buildTailoredData(args: {
  raw: Partial<TailoredData>;
  profile: ResumeProfile;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
}): TailoredData {
  const {
    jdKeywordProfile,
    jdQualificationProfile,
    referenceEvidence,
    referenceKnowledgeHits,
    selectedEvidence,
  } = args.preparation;
  const referenceItemsForCoverage = mergeReferenceItemsForCoverage(
    referenceEvidence,
    referenceKnowledgeHits,
  );
  const summaryGate = applyDomainGateToText(
    args.raw.summary || "",
    jdKeywordProfile,
  );
  const skillGate = applyDomainGateToSkills(
    Array.isArray(args.raw.skills) ? args.raw.skills : [],
    jdKeywordProfile,
  );
  const budgetedExperience = enforceExperienceBulletBudgets({
    experience: mergeExperienceWithFallback({
      generated: sanitizeExperience(args.raw.experience),
      sourceExperiences: args.preparation.sourceExperiences,
      experienceDigests: args.preparation.experienceDigests,
      jdKeywordProfile,
    }),
    contentPlan: args.preparation.contentPlan,
    experienceDigests: args.preparation.experienceDigests,
    jdKeywordProfile,
  });
  const experienceGate = applyDomainGateToExperience(
    budgetedExperience,
    jdKeywordProfile,
  );
  const gatedExperienceWithTrace = restoreExperienceTraceAfterGate(
    experienceGate.experience,
    budgetedExperience,
  );
  const experienceWithEvidence = attachEvidenceTraceToExperience({
    experience: gatedExperienceWithTrace,
    selectedEvidence: args.preparation.evidenceScopes.experience,
    experienceDigests: args.preparation.experienceDigests,
    experienceAnchors: args.preparation.experienceAnchors,
    sourceExperiences: args.preparation.sourceExperiences,
  });
  const plannedSkills = trimSkillsToContentPlanBudget(
    skillGate.skills,
    args.preparation.contentPlan,
    args.profile,
  );
  const evidenceFilteredSkills = filterSkillsForQualificationEvidence(
    plannedSkills,
    {
      qualificationProfile: jdQualificationProfile,
      evidenceText: buildEvidenceText(args.profile, referenceItemsForCoverage),
      maxKeywordsPerGroup: args.writingStyle.maxKeywordsPerSkill,
    },
  );
  const filteredSkills =
    evidenceFilteredSkills.length >=
      args.preparation.contentPlan.sectionBudgets.skillGroups.min ||
    !hasProfileSkillGroups(args.profile)
      ? evidenceFilteredSkills
      : plannedSkills;
  const alignmentReport = buildResumeAlignmentReport({
    qualificationProfile: jdQualificationProfile,
    resumeSections: buildGeneratedResumeSections({
      profile: args.profile,
      summary: summaryGate.text,
      skills: filteredSkills,
      experience: experienceWithEvidence,
    }),
    referenceItems: referenceItemsForCoverage,
    coveragePlan: args.preparation.coveragePlan,
  });
  const generationTrace = buildGenerationTrace({
    selectedEvidence,
    contentPlan: args.preparation.contentPlan,
    experienceAnchors: args.preparation.experienceAnchors,
    experienceDigests: args.preparation.experienceDigests,
    experience: experienceWithEvidence,
    resumePositioningPlan: args.resumePositioningPlan,
  });

  return {
    summary: sanitizeText(summaryGate.text),
    headline: sanitizeText(args.raw.headline || ""),
    skills: filteredSkills,
    experience: experienceWithEvidence,
    jdKeywordProfile,
    jdQualificationProfile,
    selectedEvidence,
    generationTrace,
    resumeAlignmentReport: {
      ...alignmentReport,
      generationTrace,
    },
    jdServiceValueBrief: args.jdServiceValueBrief,
    resumeServiceFitReport: null,
    resumePositioningPlan: args.resumePositioningPlan,
  };
}

function enforceExperienceBulletBudgets(args: {
  experience: TailoredExperienceItem[];
  contentPlan: ResumeContentPlan;
  experienceDigests: ExperienceCapabilityDigest[];
  jdKeywordProfile: JdKeywordProfile;
}): TailoredExperienceItem[] {
  const digestById = new Map(
    args.experienceDigests.map((digest) => [digest.experienceId, digest]),
  );
  const digestByComparableId = new Map(
    args.experienceDigests.map((digest) => [
      comparableExperienceId(digest.experienceId),
      digest,
    ]),
  );
  const bundlesByComparableExperienceId = groupBulletBundlesByExperience(
    args.contentPlan.bulletBundleCandidates ?? [],
  );
  return args.experience
    .map((item): TailoredExperienceItem | null => {
      const allocation = findExperienceAllocation(
        item,
        args.contentPlan.experienceAllocations,
      );
      const budget = allocation?.bulletBudget ?? item.bullets.length;
      if (budget <= 0) return null;
      const digest =
        digestById.get(item.id) ??
        digestByComparableId.get(comparableExperienceId(item.id));
      const bundles =
        bundlesByComparableExperienceId.get(comparableExperienceId(item.id)) ??
        [];
      const minBulletTarget = Math.min(
        Math.max(0, allocation?.minBulletBudget ?? 0),
        Math.max(budget, bundles.length, item.bullets.length),
      );
      const filled = fillExperienceBulletsToBudget({
        item,
        budget: minBulletTarget,
        digest,
        bundles,
        jdKeywordProfile: args.jdKeywordProfile,
      });
      const out: TailoredExperienceItem = {
        ...filled,
      };
      return out;
    })
    .filter((item): item is TailoredExperienceItem => Boolean(item));
}

function groupBulletBundlesByExperience(
  bundles: ExperienceBulletBundle[],
): Map<string, ExperienceBulletBundle[]> {
  const grouped = new Map<string, ExperienceBulletBundle[]>();
  for (const bundle of bundles) {
    const key = comparableExperienceId(bundle.experienceId);
    grouped.set(key, [...(grouped.get(key) ?? []), bundle]);
  }
  return grouped;
}

function findExperienceAllocation(
  item: TailoredExperienceItem,
  allocations: ResumeContentPlan["experienceAllocations"],
): ResumeContentPlan["experienceAllocations"][number] | undefined {
  const exact = allocations.find(
    (planItem) => planItem.experienceId === item.id,
  );
  if (exact) return exact;
  const itemComparableId = comparableExperienceId(item.id);
  return allocations.find(
    (planItem) =>
      comparableExperienceId(planItem.experienceId) === itemComparableId,
  );
}

function restoreExperienceTraceAfterGate(
  gated: TailoredExperienceItem[],
  beforeGate: TailoredExperienceItem[],
): TailoredExperienceItem[] {
  const beforeById = new Map(
    beforeGate.map((item) => [comparableExperienceId(item.id), item]),
  );
  return gated.map((item) => {
    const previous = beforeById.get(comparableExperienceId(item.id));
    if (!previous?.bulletTrace?.length) return item;
    const traceByBullet = new Map(
      previous.bullets.map((bullet, index) => [
        normalizeComparable(bullet),
        previous.bulletTrace?.[index],
      ]),
    );
    return {
      ...item,
      bulletTrace: item.bullets.map((_, index) => ({
        ...(traceByBullet.get(normalizeComparable(item.bullets[index])) ??
          previous.bulletTrace?.[index] ?? { claimSource: "ai_generated" }),
      })),
    };
  });
}

function comparableExperienceId(id: string | undefined): string {
  return sanitizeText(id ?? "")
    .toLowerCase()
    .replace(/^(?:experience|exp)[-_]/, "");
}

function fillExperienceBulletsToBudget(args: {
  item: TailoredExperienceItem;
  budget: number;
  digest?: ExperienceCapabilityDigest;
  bundles?: ExperienceBulletBundle[];
  jdKeywordProfile: JdKeywordProfile;
}): TailoredExperienceItem {
  const bullets = args.item.bullets.map(sanitizeText).filter(Boolean);
  const trace = bullets.map((_, index) => ({
    ...(args.item.bulletTrace?.[index] ?? {}),
    claimSource: args.item.bulletTrace?.[index]?.claimSource ?? "ai_generated",
    evidenceChunkIds:
      args.item.bulletTrace?.[index]?.evidenceChunkIds ??
      args.digest?.sourceChunkIds ??
      [],
  }));
  const existing = new Set(
    bullets.map((bullet) => normalizeComparable(bullet)),
  );
  const bundleClaims = buildBundleFallbackBullets(args.bundles ?? []).map(
    (entry) => ({
      ...entry,
      bullet: applyDomainGateToText(entry.bullet, args.jdKeywordProfile).text,
    }),
  );
  for (
    let index = 0;
    bullets.length < args.budget && index < bundleClaims.length;
    index += 1
  ) {
    const entry = bundleClaims[index];
    const bullet = sanitizeText(entry.bullet);
    if (!bullet) continue;
    const key = normalizeComparable(bullet);
    if (existing.has(key)) continue;
    existing.add(key);
    bullets.push(bullet);
    trace.push({
      claimSource: "bundle_fallback",
      bundleId: entry.bundle.bundleId,
      theme: entry.bundle.theme,
      anchorId: entry.bundle.anchorId,
      matchedRequirementIds: entry.bundle.matchedRequirementIds,
      evidenceChunkIds: entry.bundle.sourceChunkIds,
      fallbackGenerated: true,
      densityRepairGenerated: true,
    });
  }
  const fallbackClaims = buildDigestFallbackBullets(args.digest).map(
    (claim) => applyDomainGateToText(claim, args.jdKeywordProfile).text,
  );
  for (
    let index = 0;
    bullets.length < args.budget && index < fallbackClaims.length;
    index += 1
  ) {
    const bullet = sanitizeText(fallbackClaims[index]);
    if (!bullet) continue;
    const key = normalizeComparable(bullet);
    if (existing.has(key)) continue;
    existing.add(key);
    bullets.push(bullet);
    trace.push({
      claimSource: "digest_fallback",
      digestClaimId: args.digest
        ? `${args.digest.experienceId}:fallback:${index}`
        : undefined,
      evidenceChunkIds: args.digest?.sourceChunkIds ?? [],
      fallbackGenerated: true,
    });
  }
  return {
    ...args.item,
    bullets,
    bulletTrace: trace,
  };
}

function buildBundleFallbackBullets(
  bundles: ExperienceBulletBundle[],
): Array<{ bundle: ExperienceBulletBundle; bullet: string }> {
  return bundles
    .filter(
      (bundle) => bundle.fit === "direct" || bundle.fit === "transferable",
    )
    .flatMap((bundle) => {
      const claims = uniqueStrings(bundle.requiredClaims).slice(0, 3);
      const firstClaim = claims[0] ?? bundle.theme;
      const secondClaim = claims.find(
        (claim) =>
          normalizeComparable(claim) !== normalizeComparable(firstClaim),
      );
      const softenedPrefix =
        bundle.fit === "transferable"
          ? "Applied related experience in"
          : "Delivered";
      const bullet =
        secondClaim && bundle.recommendedDepth !== "concise"
          ? `${softenedPrefix} ${firstClaim.replace(/[.;:]$/, "")}, using ${secondClaim.replace(/[.;:]$/, "")} to support ${bundle.theme.replace(/[.;:]$/, "")}.`
          : `${softenedPrefix} ${firstClaim.replace(/[.;:]$/, "")} to support ${bundle.theme.replace(/[.;:]$/, "")}.`;
      return [{ bundle, bullet }];
    });
}

function buildDigestFallbackBullets(
  digest: ExperienceCapabilityDigest | undefined,
): string[] {
  if (!digest) return [];
  const base = uniqueStrings([
    ...digest.recommendedBulletThemes,
    ...digest.coreClaims,
    ...digest.transferableClaims,
  ]);
  const expanded = uniqueStrings([
    ...base,
    ...base.flatMap((claim) => expandSourceBackedClaim(claim)),
    ...buildSparseDigestContinuityClaims(digest, base[0]),
  ]);
  return expanded.slice(0, 12);
}

function expandSourceBackedClaim(claim: string): string[] {
  const cleaned = sanitizeText(claim).replace(/[.;:]$/, "");
  const parts = cleaned
    .split(/\s+and\s+/i)
    .map(sanitizeText)
    .filter(Boolean);
  if (parts.length < 2) return [];
  const firstWords = parts[0].split(/\s+/);
  const verb = firstWords[0] ?? "";
  if (!verb || verb.length < 3) return [];
  return parts.slice(1).map((part) => `${verb} ${part}.`);
}

function buildSparseDigestContinuityClaims(
  digest: ExperienceCapabilityDigest,
  seed: string | undefined,
): string[] {
  const source = sanitizeText(seed ?? digest.capabilitySummary).replace(
    /[.;:]$/,
    "",
  );
  if (!source) return [];
  return [
    `Applied source-backed ${digest.label} experience across ${source}.`,
    `Supported recurring ${source} through role deliverables documented in the master resume.`,
    `Maintained continuity of ${source} responsibilities without adding unsupported tools, metrics, or credentials.`,
  ];
}

function trimSkillsToContentPlanBudget(
  skills: Array<{ name: string; keywords: string[] }>,
  contentPlan: ResumeContentPlan,
  profile?: ResumeProfile,
): Array<{ name: string; keywords: string[] }> {
  const maxGroups = contentPlan.sectionBudgets.skillGroups.max;
  const masterGroupNames = getMasterSkillGroupNames(profile);
  const allowedTerms = new Set(
    contentPlan.requirementTiers
      .filter((item) => item.tier !== "blocked")
      .flatMap((item) =>
        [item.requirement, ...item.allowedClaims]
          .join(" ")
          .toLowerCase()
          .split(/[^a-z0-9+#.-]+/)
          .filter((term) => term.length >= 3),
      ),
  );
  const grouped = new Map<string, string[]>();
  for (const group of skills) {
    const name = normalizeSkillGroupName(
      group.name,
      group.keywords,
      masterGroupNames,
    );
    const keywords = group.keywords.filter((keyword) => {
      const normalized = keyword.toLowerCase();
      return (
        allowedTerms.size === 0 ||
        [...allowedTerms].some(
          (term) => normalized.includes(term) || term.includes(normalized),
        )
      );
    });
    if (keywords.length === 0) continue;
    grouped.set(
      name,
      uniqueStrings([...(grouped.get(name) ?? []), ...keywords]).slice(0, 10),
    );
  }
  return Array.from(grouped.entries())
    .map(([name, keywords]) => ({
      name,
      keywords,
    }))
    .filter((group) => group.keywords.length > 0)
    .sort((a, b) => skillGroupPriority(b.name) - skillGroupPriority(a.name))
    .slice(0, maxGroups);
}

function getMasterSkillGroupNames(profile?: ResumeProfile): string[] {
  const items = (
    profile?.sections?.skills as unknown as {
      items?: Array<{ name?: string }>;
    }
  )?.items;
  const names = items
    ?.map((item) => sanitizeText(item.name ?? ""))
    .filter(Boolean)
    .slice(0, 3);
  return names?.length ? names : MASTER_STYLE_SKILL_GROUP_NAMES;
}

function hasProfileSkillGroups(profile?: ResumeProfile): boolean {
  return getMasterSkillGroupNames(profile) !== MASTER_STYLE_SKILL_GROUP_NAMES;
}

function normalizeSkillGroupName(
  name: string,
  keywords: string[],
  masterGroupNames: string[],
): string {
  const cleaned = sanitizeText(name);
  const haystack = [cleaned, ...keywords].join(" ").toLowerCase();
  const matchingMaster = masterGroupNames.find((group) =>
    group
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 5)
      .some((term) => haystack.includes(term)),
  );
  if (matchingMaster && !isGenericSkillGroupName(cleaned))
    return matchingMaster;
  if (
    /\b(report|powerpoint|presentation|dashboard|visual|qgis|arcgis|datawrapper|brief|deck|communication)\b/.test(
      haystack,
    )
  ) {
    return pickMasterSkillName(masterGroupNames, "reporting");
  }
  if (
    /\b(data|excel|python|r\b|sas|spss|statistics|cleaning|quality|dataset|analysis)\b/.test(
      haystack,
    )
  ) {
    return pickMasterSkillName(masterGroupNames, "data");
  }
  if (
    /\b(research|interview|survey|audience|market|jurisdiction|stakeholder|literature)\b/.test(
      haystack,
    )
  ) {
    return pickMasterSkillName(masterGroupNames, "research");
  }
  return matchingMaster ?? masterGroupNames[0] ?? cleaned;
}

function pickMasterSkillName(
  masterGroupNames: string[],
  kind: "research" | "data" | "reporting",
): string {
  const matcher =
    kind === "research"
      ? /\b(research|market|audience|stakeholder)\b/i
      : kind === "data"
        ? /\b(data|analysis|quality|technical)\b/i
        : /\b(report|analytics|tool|presentation|communication|visual)\b/i;
  return (
    masterGroupNames.find((name) => matcher.test(name)) ??
    DEFAULT_SKILL_GROUP_BY_KIND[kind]
  );
}

function isGenericSkillGroupName(name: string): boolean {
  return /^(strategy|analysis|strategy & analysis|technical skills|tools|communication|soft skills|research|data|analytics|other)$/i.test(
    name.trim(),
  );
}

function skillGroupPriority(name: string): number {
  if (/\b(research|market|audience|stakeholder)\b/i.test(name)) return 3;
  if (/\b(data|analysis|quality|technical)\b/i.test(name)) return 2;
  if (
    /\b(report|analytics|tool|presentation|communication|visual)\b/i.test(name)
  )
    return 1;
  return 0;
}

const MASTER_STYLE_SKILL_GROUP_NAMES = [
  "Market & Audience Research",
  "Data Analysis & Quality Control",
  "Reporting & Analytics Tools",
];

const DEFAULT_SKILL_GROUP_BY_KIND = {
  research: "Market & Audience Research",
  data: "Data Analysis & Quality Control",
  reporting: "Reporting & Analytics Tools",
} as const;

function attachEvidenceTraceToExperience(args: {
  experience: TailoredExperienceItem[];
  selectedEvidence: SelectedResumeEvidence[];
  experienceDigests: ExperienceCapabilityDigest[];
  experienceAnchors: ExperienceAnchorSummary[];
  sourceExperiences: ExperienceEvidence[];
}): TailoredExperienceItem[] {
  const selectedChunks = args.selectedEvidence.flatMap((item) => item.chunks);
  const digestById = new Map(
    args.experienceDigests.map((digest) => [digest.experienceId, digest]),
  );
  const digestByComparableId = new Map(
    args.experienceDigests.map((digest) => [
      comparableExperienceId(digest.experienceId),
      digest,
    ]),
  );
  const anchorIdByChunkId = new Map([
    ...selectedChunks
      .map((chunk) =>
        chunk.experienceAnchorId
          ? ([chunk.chunkId, chunk.experienceAnchorId] as const)
          : null,
      )
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
    ...args.experienceAnchors.flatMap((anchor) =>
      anchor.sourceChunkIds.map(
        (chunkId) => [chunkId, anchor.experienceAnchorId] as const,
      ),
    ),
  ]);
  const fallbackChunkIds = selectedChunks
    .slice(0, 3)
    .map((chunk) => chunk.chunkId);
  const sourceByComparableId = new Map(
    args.sourceExperiences.map((source) => [
      comparableExperienceId(source.id),
      normalizeComparable(source.sourceText),
    ]),
  );
  return args.experience.map((item) => {
    const digest =
      digestById.get(item.id) ??
      digestByComparableId.get(comparableExperienceId(item.id));
    const itemText = normalizeComparable([item.id, ...item.bullets].join(" "));
    const matched = selectedChunks
      .filter((chunk) => {
        const keywordMatch = chunk.keywords.some((keyword) =>
          itemText.includes(normalizeComparable(keyword)),
        );
        const chunkTerms = normalizeComparable(chunk.rawText)
          .split(/[^a-z0-9+#.-]+/)
          .filter((term) => term.length >= 5)
          .slice(0, 24);
        const overlap = chunkTerms.filter((term) =>
          itemText.includes(term),
        ).length;
        return keywordMatch || overlap >= 2;
      })
      .map((chunk) => chunk.chunkId);
    const evidenceChunkIds = Array.from(
      new Set([
        ...(matched.length ? matched : []),
        ...(digest?.sourceChunkIds ?? []),
        ...(!matched.length && !digest?.sourceChunkIds.length
          ? fallbackChunkIds
          : []),
      ]),
    ).slice(0, 5);
    const bulletTrace = item.bullets.map((bullet, index) => {
      const existing = item.bulletTrace?.[index];
      const bulletText = normalizeComparable(bullet);
      const bulletMatched = selectedChunks
        .filter((chunk) => {
          const keywordMatch = chunk.keywords.some((keyword) =>
            bulletText.includes(normalizeComparable(keyword)),
          );
          const chunkTerms = normalizeComparable(chunk.rawText)
            .split(/[^a-z0-9+#.-]+/)
            .filter((term) => term.length >= 5)
            .slice(0, 18);
          const overlap = chunkTerms.filter((term) =>
            bulletText.includes(term),
          ).length;
          return keywordMatch || overlap >= 2;
        })
        .map((chunk) => chunk.chunkId);
      const traceChunkIds = Array.from(
        new Set([
          ...(existing?.evidenceChunkIds ?? []),
          ...bulletMatched,
          ...(digest?.sourceChunkIds ?? []),
        ]),
      ).slice(0, 5);
      const sourceText =
        sourceByComparableId.get(comparableExperienceId(item.id)) ?? "";
      const copiedFromSource = Boolean(
        sourceText && sourceText.includes(bulletText),
      );
      return {
        claimSource: existing?.claimSource ?? "ai_generated",
        digestClaimId: existing?.digestClaimId,
        bundleId: existing?.bundleId,
        theme: existing?.theme,
        anchorId:
          existing?.anchorId ??
          traceChunkIds
            .map((chunkId) => anchorIdByChunkId.get(chunkId))
            .find((id): id is string => Boolean(id)),
        matchedRequirementIds: existing?.matchedRequirementIds,
        evidenceChunkIds: traceChunkIds,
        claimType: existing?.claimType,
        positioningIntent: existing?.positioningIntent,
        riskFlags: existing?.riskFlags,
        boundaryVerdict: existing?.boundaryVerdict,
        boundaryReasons: existing?.boundaryReasons,
        repairGenerated: existing?.repairGenerated,
        fallbackGenerated: existing?.fallbackGenerated ?? copiedFromSource,
        densityRepairGenerated: existing?.densityRepairGenerated,
      };
    });
    return {
      ...item,
      evidenceChunkIds,
      bulletTrace,
    };
  });
}

function buildGenerationTrace(args: {
  selectedEvidence: SelectedResumeEvidence[];
  contentPlan: ResumeContentPlan;
  experienceAnchors: ExperienceAnchorSummary[];
  experienceDigests: ExperienceCapabilityDigest[];
  experience: TailoredExperienceItem[];
  resumePositioningPlan: ResumePositioningPlan | null;
}): ResumeGenerationTrace {
  const chunksById = new Map(
    args.selectedEvidence.flatMap((item) =>
      item.chunks.map((chunk) => [chunk.chunkId, chunk] as const),
    ),
  );
  const bulletBundlesUsed = collectBulletBundlesUsed(args.experience);
  return {
    selectedEvidence: args.selectedEvidence,
    contentPlan: args.contentPlan,
    bulletBundleCandidates: args.contentPlan.bulletBundleCandidates ?? [],
    bulletBundlesUsed,
    densityWarnings: buildDensityWarnings({
      experience: args.experience,
      contentPlan: args.contentPlan,
      bulletBundlesUsed,
    }),
    experienceDigests: args.experienceDigests,
    experienceAnchors: args.experienceAnchors,
    anchorEvidenceMap: buildAnchorEvidenceMap(args.selectedEvidence),
    anchorWarnings: args.experienceAnchors.flatMap((anchor) =>
      [
        ...anchor.diagnostics.warnings,
        ...(anchor.confidence === "low"
          ? [`${anchor.experienceAnchorId} is low-confidence.`]
          : []),
      ].map((warning) => `${anchor.experienceAnchorId}: ${warning}`),
    ),
    experience: args.experience.map((item) => {
      const evidenceChunkIds = item.evidenceChunkIds ?? [];
      const sourceFiles = Array.from(
        new Set(
          evidenceChunkIds
            .map((chunkId) => chunksById.get(chunkId)?.sourceFile)
            .filter((file): file is string => Boolean(file)),
        ),
      );
      return {
        experienceId: item.id,
        bulletCount: item.bullets.length,
        evidenceChunkIds,
        sourceFiles,
        missingEvidence: evidenceChunkIds.length === 0,
        bullets: item.bullets.map((bullet, index) => {
          const trace = item.bulletTrace?.[index];
          const traceChunkIds = trace?.evidenceChunkIds ?? evidenceChunkIds;
          return {
            text: bullet,
            claimSource: trace?.claimSource ?? "ai_generated",
            digestClaimId: trace?.digestClaimId,
            bundleId: trace?.bundleId,
            theme: trace?.theme,
            anchorId: trace?.anchorId,
            matchedRequirementIds: trace?.matchedRequirementIds,
            evidenceChunkIds: traceChunkIds,
            claimType: trace?.claimType,
            positioningIntent: trace?.positioningIntent,
            riskFlags: trace?.riskFlags,
            boundaryVerdict: trace?.boundaryVerdict,
            boundaryReasons: trace?.boundaryReasons,
            repairGenerated: trace?.repairGenerated,
            fallbackGenerated: trace?.fallbackGenerated,
            densityRepairGenerated: trace?.densityRepairGenerated,
            missingEvidence: traceChunkIds.length === 0,
          };
        }),
      };
    }),
    repackagingVerifier: buildRepackagingVerifierTrace({
      resumePositioningPlan: args.resumePositioningPlan,
      experience: args.experience,
    }),
    uncoveredRequirements: args.selectedEvidence
      .filter(
        (item) =>
          item.status === "no_evidence" || item.status === "weak_evidence",
      )
      .map((item) => item.requirement),
  };
}

function collectBulletBundlesUsed(
  experience: TailoredExperienceItem[],
): NonNullable<ResumeGenerationTrace["bulletBundlesUsed"]> {
  const byId = new Map<
    string,
    NonNullable<ResumeGenerationTrace["bulletBundlesUsed"]>[number]
  >();
  for (const item of experience) {
    for (const trace of item.bulletTrace ?? []) {
      if (!trace.bundleId) continue;
      const existing = byId.get(trace.bundleId);
      byId.set(trace.bundleId, {
        bundleId: trace.bundleId,
        experienceId: item.id,
        theme: trace.theme ?? existing?.theme ?? "",
        sourceChunkIds: uniqueStrings([
          ...(existing?.sourceChunkIds ?? []),
          ...(trace.evidenceChunkIds ?? []),
        ]),
        matchedRequirementIds: uniqueStrings([
          ...(existing?.matchedRequirementIds ?? []),
          ...(trace.matchedRequirementIds ?? []),
        ]),
      });
    }
  }
  return [...byId.values()];
}

function buildRepackagingVerifierTrace(args: {
  resumePositioningPlan: ResumePositioningPlan | null;
  experience: TailoredExperienceItem[];
}): NonNullable<ResumeGenerationTrace["repackagingVerifier"]> {
  const plan = args.resumePositioningPlan;
  const primary = new Set(
    (plan?.primaryEvidenceRoles ?? []).map(comparableExperienceId),
  );
  const supporting = new Set(
    (plan?.supportingEvidenceRoles ?? []).map(comparableExperienceId),
  );
  const downplayed = new Set(
    (plan?.downplayedRoles ?? []).map(comparableExperienceId),
  );
  for (const item of plan?.experienceUse ?? []) {
    const key = comparableExperienceId(item.id);
    if (item.use === "primary") primary.add(key);
    if (item.use === "supporting") supporting.add(key);
    if (item.use === "downplayed") downplayed.add(key);
  }
  const bulletVerdicts = args.experience.flatMap((item) =>
    (item.bulletTrace ?? []).map((trace, index) => ({
      experienceId: item.id,
      bulletIndex: index,
      claimType: trace.claimType,
      verdict: trace.boundaryVerdict ?? "legacy",
      reasons: trace.boundaryReasons ?? [],
    })),
  );
  return {
    generatorVersion: RESUME_POSITIONING_GENERATOR_VERSION,
    targetFrame: plan?.targetFrame,
    candidateThesis: plan?.candidateThesis,
    targetPitch: plan?.targetPitch,
    sourcePitch: plan?.sourcePitch,
    roleEmphasis: args.experience.map((item) => {
      const key = comparableExperienceId(item.id);
      const category = primary.has(key)
        ? "primary"
        : supporting.has(key)
          ? "supporting"
          : downplayed.has(key)
            ? "downplayed"
            : "unspecified";
      return { experienceId: item.id, category };
    }),
    bulletVerdicts,
    softenedBullets: bulletVerdicts.filter(
      (item) => item.verdict === "softened",
    ).length,
    droppedBullets: bulletVerdicts.filter((item) => item.verdict === "dropped")
      .length,
    unsupportedClaimReasons: uniqueStrings(
      bulletVerdicts.flatMap((item) => item.reasons),
    ).slice(0, 12),
  };
}

function buildDensityWarnings(args: {
  experience: TailoredExperienceItem[];
  contentPlan: ResumeContentPlan;
  bulletBundlesUsed: NonNullable<ResumeGenerationTrace["bulletBundlesUsed"]>;
}): string[] {
  const target = args.contentPlan.densityTargets;
  if (!target) return [];
  const bullets = args.experience.flatMap((item) => item.bullets);
  const experienceWords = countWords(bullets.join(" "));
  const avgBulletWords =
    bullets.length > 0
      ? Math.round((experienceWords / bullets.length) * 10) / 10
      : 0;
  const warnings: string[] = [];
  if (experienceWords < target.minExperienceWords) {
    warnings.push(
      `Experience section is underdeveloped: ${experienceWords} words, target minimum ${target.minExperienceWords}.`,
    );
  }
  if (bullets.length > 0 && avgBulletWords < target.minAverageBulletWords) {
    warnings.push(
      `Experience bullet density is low: ${avgBulletWords} words/bullet, target minimum ${target.minAverageBulletWords}.`,
    );
  }
  const candidates = args.contentPlan.bulletBundleCandidates ?? [];
  if (candidates.length < target.minRelevantBundleCandidates) {
    warnings.push(
      `Evidence gap: only ${candidates.length} relevant/tailorable bundle candidates found, diagnostic target ${target.minRelevantBundleCandidates}.`,
    );
  }
  const usedIds = new Set(args.bulletBundlesUsed.map((item) => item.bundleId));
  const unusedHighValue = candidates.filter(
    (bundle) =>
      !usedIds.has(bundle.bundleId) &&
      bundle.fit === "direct" &&
      (bundle.confidence === "high" || bundle.recommendedDepth === "deep"),
  );
  if (
    unusedHighValue.length > 0 &&
    experienceWords < target.targetExperienceWords
  ) {
    warnings.push(
      `Unused high-value evidence remains while the resume is sparse: ${unusedHighValue
        .slice(0, 5)
        .map((bundle) => bundle.bundleId)
        .join(", ")}.`,
    );
  }
  return warnings;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

function buildAnchorEvidenceMap(
  selectedEvidence: SelectedResumeEvidence[],
): NonNullable<ResumeGenerationTrace["anchorEvidenceMap"]> {
  const byAnchor = new Map<
    string,
    { selectedChunkIds: Set<string>; matchedRequirementIds: Set<string> }
  >();
  for (const evidence of selectedEvidence) {
    for (const chunk of evidence.chunks) {
      if (!chunk.experienceAnchorId) continue;
      const entry = byAnchor.get(chunk.experienceAnchorId) ?? {
        selectedChunkIds: new Set<string>(),
        matchedRequirementIds: new Set<string>(),
      };
      entry.selectedChunkIds.add(chunk.chunkId);
      if (evidence.requirementId) {
        entry.matchedRequirementIds.add(evidence.requirementId);
      }
      byAnchor.set(chunk.experienceAnchorId, entry);
    }
  }
  return Array.from(byAnchor.entries()).map(([experienceAnchorId, entry]) => ({
    experienceAnchorId,
    selectedChunkIds: Array.from(entry.selectedChunkIds),
    matchedRequirementIds: Array.from(entry.matchedRequirementIds),
  }));
}

async function judgeTailoringCompact(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  tailoredData: TailoredData;
  profile: ResumeProfile;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  force?: boolean;
}): Promise<TailoringCompactJudgeResponse | null> {
  if (!args.jdServiceValueBrief) return null;
  const serviceValueGaps = findServiceValueFramingGaps(args);
  if (
    !args.force &&
    serviceValueGaps.length === 0 &&
    args.tailoredData.resumeAlignmentReport.status === "pass" &&
    args.tailoredData.resumeAlignmentReport.score >= 92 &&
    !hasDensityRepairGap(args.tailoredData.generationTrace) &&
    !hasPositioningQualityGap(args.tailoredData)
  ) {
    return {
      verdict: "pass",
      failedSections: [],
      failedExperienceIds: [],
      reason: "Local alignment checks passed.",
      serviceFitReport: buildCompactServiceFitFallback(
        args.jdServiceValueBrief,
        args.tailoredData,
      ),
    };
  }

  const result = await args.llm.callJson<TailoringCompactJudgeResponse>({
    model: args.model,
    messages: [
      {
        role: "user",
        content: buildTailoringCompactJudgePrompt(args),
      },
    ],
    jsonSchema: TAILORING_COMPACT_JUDGE_SCHEMA,
    stage: "compact_judge",
    metadata: { generatedVisibleContent: false },
  });
  if (!result.success) return null;
  return applyServiceValueFramingGaps(
    sanitizeTailoringCompactJudge(result.data, {
      jdServiceValueBrief: args.jdServiceValueBrief,
      tailoredData: args.tailoredData,
    }),
    serviceValueGaps,
    args.jdServiceValueBrief,
    args.tailoredData,
  );
}

type ServiceValueFramingGap = {
  reason: string;
  failedExperienceIds: string[];
};

const MARKET_INTELLIGENCE_SIGNALS = [
  "market intelligence",
  "market research",
  "business analytics",
  "business/data analytics",
  "market opportunity",
];

const OLD_DOMAIN_FRAME_SIGNALS = [
  "workforce development",
  "regional policy",
  "public-sector workforce",
  "public sector workforce",
  "labour-market",
  "labor-market",
  "labour market",
  "labor market",
];

function findServiceValueFramingGaps(args: {
  tailoredData: TailoredData;
  preparation: TailoringPreparation;
  jdServiceValueBrief: JdServiceValueBrief | null;
}): ServiceValueFramingGap[] {
  const gaps: ServiceValueFramingGap[] = [];
  if (
    hasMarketIntelligenceNeed(args.preparation) &&
    !containsAnySignal(buildGeneratedResumeSignalText(args.tailoredData), [
      ...MARKET_INTELLIGENCE_SIGNALS,
      ...(args.jdServiceValueBrief?.mustSignalConcepts ?? []),
    ])
  ) {
    gaps.push({
      reason:
        "JD asks for market intelligence / market research, but visible resume content does not signal an equivalent framing.",
      failedExperienceIds: args.tailoredData.experience[0]?.id
        ? [args.tailoredData.experience[0].id]
        : [],
    });
  }

  const leadExperience = args.tailoredData.experience[0];
  if (leadExperience) {
    const leadText = leadExperience.bullets.slice(0, 2).join(" ");
    const serviceValueSignals = [
      ...(args.jdServiceValueBrief?.expectedDeliverables ?? []),
      ...(args.jdServiceValueBrief?.businessDecisionsSupported ?? []),
      ...(args.jdServiceValueBrief?.mustSignalConcepts ?? []),
      args.jdServiceValueBrief?.buyerNeed ?? "",
    ];
    if (
      containsAnySignal(leadText, OLD_DOMAIN_FRAME_SIGNALS) &&
      !containsAnySignal(leadText, [
        ...MARKET_INTELLIGENCE_SIGNALS,
        ...serviceValueSignals,
      ])
    ) {
      gaps.push({
        reason:
          "Lead experience still reads as the old workforce / regional policy frame instead of translating source-backed work into the JD service value.",
        failedExperienceIds: [leadExperience.id],
      });
    }
  }

  return gaps;
}

function hasMarketIntelligenceNeed(preparation: TailoringPreparation): boolean {
  return containsAnySignal(
    [
      preparation.jdKeywordProfile.requiredKeywords,
      preparation.jdKeywordProfile.experienceFocus,
      preparation.jdKeywordProfile.domainKeywordsPresent,
      preparation.jdQualificationProfile.required,
      preparation.jdQualificationProfile.preferred,
      preparation.jdQualificationProfile.keywords,
    ]
      .flat()
      .filter((value): value is string => typeof value === "string")
      .join(" "),
    ["market intelligence", "market research"],
  );
}

function buildGeneratedResumeSignalText(data: TailoredData): string {
  return [
    data.headline,
    data.summary,
    ...data.skills.flatMap((group) => [group.name, ...group.keywords]),
    ...data.experience.slice(0, 2).flatMap((item) => item.bullets.slice(0, 2)),
  ].join(" ");
}

function containsAnySignal(text: string, signals: string[]): boolean {
  const normalized = normalizeComparable(text);
  return signals.some((signal) => {
    const normalizedSignal = normalizeComparable(signal);
    return normalizedSignal.length > 0 && normalized.includes(normalizedSignal);
  });
}

function applyServiceValueFramingGaps(
  judge: TailoringCompactJudgeResponse,
  gaps: ServiceValueFramingGap[],
  jdServiceValueBrief: JdServiceValueBrief,
  tailoredData: TailoredData,
): TailoringCompactJudgeResponse {
  if (gaps.length === 0) return judge;
  const failedExperienceIds = Array.from(
    new Set([
      ...judge.failedExperienceIds,
      ...gaps.flatMap((gap) => gap.failedExperienceIds),
    ]),
  );
  const failedSections = Array.from(
    new Set<TailoringCompactJudgeResponse["failedSections"][number]>([
      ...judge.failedSections,
      "service_fit",
      ...(failedExperienceIds.length > 0 ? ["experience" as const] : []),
    ]),
  );
  return {
    ...judge,
    verdict: "needs_patch",
    failedSections,
    failedExperienceIds,
    reason: [judge.reason, ...gaps.map((gap) => gap.reason)]
      .filter(Boolean)
      .join(" "),
    serviceFitReport: {
      ...buildCompactServiceFitFallback(jdServiceValueBrief, tailoredData),
      status: "needs_review",
      score: Math.min(78, tailoredData.resumeAlignmentReport.score),
      missingOrWeakServiceValues: [
        ...gaps.map((gap) => gap.reason),
        ...judge.serviceFitReport.missingOrWeakServiceValues,
      ].slice(0, 8),
    },
  };
}

function buildTailoringCompactJudgePrompt(args: {
  tailoredData: TailoredData;
  profile: ResumeProfile;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
}): string {
  return [
    "You are a compact resume tailoring judge.",
    "Decide whether the generated resume already fits the JD and positioning plan or needs a small patch.",
    "Prefer pass when the content is truthful, on-pitch, and materially covers the required qualifications.",
    "Use needs_patch only for visible wording problems that can be fixed by editing summary, skills, or specific experience bullets.",
    "",
    "JD SERVICE VALUE:",
    formatJdServiceValueBriefForPrompt(args.jdServiceValueBrief),
    "",
    "POSITIONING PLAN:",
    formatResumePositioningPlanForPrompt(args.resumePositioningPlan),
    "",
    "LOCAL ALIGNMENT REPORT:",
    JSON.stringify({
      status: args.tailoredData.resumeAlignmentReport.status,
      score: args.tailoredData.resumeAlignmentReport.score,
      missingRequired: args.tailoredData.resumeAlignmentReport.missingRequired,
      partialRequired: args.tailoredData.resumeAlignmentReport.partialRequired,
      repairableRequired:
        args.tailoredData.resumeAlignmentReport.repairableRequired,
      humanInputNeeded:
        args.tailoredData.resumeAlignmentReport.humanInputNeeded,
    }),
    "",
    "GENERATED RESUME:",
    JSON.stringify({
      headline: args.tailoredData.headline,
      summary: args.tailoredData.summary,
      skills: args.tailoredData.skills,
      experience: args.tailoredData.experience.map((item) => ({
        id: item.id,
        bullets: item.bullets,
      })),
    }),
    "",
    "Return serviceFitReport using the required schema. Keep reason concise.",
  ].join("\n");
}

function sanitizeTailoringCompactJudge(
  value: TailoringCompactJudgeResponse,
  args: {
    jdServiceValueBrief: JdServiceValueBrief;
    tailoredData: TailoredData;
  },
): TailoringCompactJudgeResponse {
  const failedSections = Array.isArray(value.failedSections)
    ? value.failedSections.filter((section) =>
        ["summary", "skills", "experience", "coverage", "service_fit"].includes(
          section,
        ),
      )
    : [];
  const failedExperienceIds = Array.isArray(value.failedExperienceIds)
    ? value.failedExperienceIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  const serviceFitReport =
    value.serviceFitReport ??
    buildCompactServiceFitFallback(args.jdServiceValueBrief, args.tailoredData);
  return {
    verdict: value.verdict === "needs_patch" ? "needs_patch" : "pass",
    failedSections,
    failedExperienceIds,
    reason: typeof value.reason === "string" ? truncate(value.reason, 500) : "",
    serviceFitReport,
  };
}

function buildCompactServiceFitFallback(
  jdServiceValueBrief: JdServiceValueBrief | null,
  tailoredData: TailoredData,
): ResumeServiceFitReport {
  const status =
    tailoredData.resumeAlignmentReport.status === "pass"
      ? "pass"
      : "needs_review";
  return {
    status,
    score: tailoredData.resumeAlignmentReport.score,
    targetBuyerNeed: jdServiceValueBrief?.buyerNeed ?? "Unavailable.",
    resumeCurrentlySignals: [
      tailoredData.headline,
      ...tailoredData.skills.flatMap((group) => group.keywords.slice(0, 3)),
    ]
      .filter(Boolean)
      .slice(0, 8),
    matchedServiceValues:
      jdServiceValueBrief?.mustSignalConcepts.slice(0, 8) ?? [],
    missingOrWeakServiceValues:
      tailoredData.resumeAlignmentReport.repairableRequired?.slice(0, 8) ?? [],
    oldFrameRisks: jdServiceValueBrief?.avoidDominantFrames.slice(0, 6) ?? [],
    unsupportedOrNeedsConfirmation: [],
    manualFixSuggestions: [],
  };
}

async function repairTailoringWithPatch(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  tailoredData: TailoredData;
  profile: ResumeProfile;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  compactJudge: TailoringCompactJudgeResponse;
  basePrompt: string;
}): Promise<TailoredData | null> {
  const result = await args.llm.callJson<TailoringPatchResponse>({
    model: args.model,
    messages: [
      {
        role: "user",
        content: buildTailoringPatchPrompt(args),
      },
    ],
    jsonSchema: TAILORING_PATCH_SCHEMA,
    stage: "repair_patch",
    metadata: { generatedVisibleContent: true },
  });
  if (!result.success) return null;
  const raw = applyTailoringPatch(args.tailoredData, result.data);
  return buildTailoredData({
    raw,
    profile: args.profile,
    writingStyle: args.writingStyle,
    preparation: args.preparation,
    resumePositioningPlan: args.resumePositioningPlan,
    jdServiceValueBrief: args.jdServiceValueBrief,
  });
}

function buildTailoringPatchPrompt(args: {
  tailoredData: TailoredData;
  preparation: TailoringPreparation;
  compactJudge: TailoringCompactJudgeResponse;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  basePrompt: string;
}): string {
  const scopedEvidence = formatSelectedEvidenceForPrompt(
    buildPatchEvidenceScope(args.preparation, args.compactJudge),
  );
  return [
    "Patch only the failing resume fields. Do not return a full resume.",
    "Keep all claims grounded in the existing evidence and positioning plan.",
    "If an experience item is not listed as failed, do not patch it.",
    "",
    "ORIGINAL GENERATION INSTRUCTIONS:",
    truncate(args.basePrompt, 6000),
    "",
    "JUDGE RESULT:",
    JSON.stringify(args.compactJudge),
    scopedEvidence
      ? [
          "",
          "PATCH SCOPED EVIDENCE:",
          "Use only these section-appropriate chunks for new patch claims. Do not use Education, Certifications, Cover Letter, or unrelated section chunks as support for patched experience bullets.",
          scopedEvidence,
        ].join("\n")
      : "",
    "",
    "CURRENT RESUME:",
    JSON.stringify({
      headline: args.tailoredData.headline,
      summary: args.tailoredData.summary,
      skills: args.tailoredData.skills,
      experience: args.tailoredData.experience.map((item) => ({
        id: item.id,
        bullets: item.bullets,
      })),
    }),
    "",
    "Return only summarySkillsPatch, experiencePatches, and reason.",
  ].join("\n");
}

function buildPatchEvidenceScope(
  preparation: TailoringPreparation,
  compactJudge: TailoringCompactJudgeResponse,
): SelectedResumeEvidence[] {
  const scopes: SelectedResumeEvidence[][] = [];
  if (compactJudge.failedSections.includes("summary")) {
    scopes.push(preparation.evidenceScopes.summary);
  }
  if (compactJudge.failedSections.includes("skills")) {
    scopes.push(preparation.evidenceScopes.skills);
  }
  if (compactJudge.failedSections.includes("experience")) {
    scopes.push(preparation.evidenceScopes.experience);
  }
  if (scopes.length === 0) {
    scopes.push(
      preparation.evidenceScopes.summary,
      preparation.evidenceScopes.skills,
      preparation.evidenceScopes.experience,
    );
  }
  return mergeSelectedEvidenceScopes(...scopes);
}

function applyTailoringPatch(
  current: TailoredData,
  patch: TailoringPatchResponse,
): Partial<TailoredData> {
  const summarySkillsPatch = patch.summarySkillsPatch ?? {};
  const patchById = new Map(
    (patch.experiencePatches ?? [])
      .filter((item) => item.id)
      .map((item) => [item.id, item]),
  );
  return {
    headline: summarySkillsPatch.headline ?? current.headline,
    summary: summarySkillsPatch.summary ?? current.summary,
    skills: Array.isArray(summarySkillsPatch.skills)
      ? summarySkillsPatch.skills
      : current.skills,
    experience: current.experience.map((item) => {
      const experiencePatch = patchById.get(item.id);
      if (!experiencePatch?.bullets?.length) return item;
      return {
        ...item,
        bullets: experiencePatch.bullets,
      };
    }),
  };
}

async function calibrateTailoredDataWithAi(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  tailoredData: TailoredData;
  profile: ResumeProfile;
  preparation: TailoringPreparation;
  force?: boolean;
}): Promise<TailoredData> {
  if (
    args.preparation.jdQualificationProfile.required.length === 0 ||
    (!args.force &&
      args.tailoredData.resumeAlignmentReport.status === "pass" &&
      args.tailoredData.resumeAlignmentReport.score >= 90)
  ) {
    return args.tailoredData;
  }

  const judgeResult = await args.llm.callJson<AiCoverageJudgeResponse>({
    model: args.model,
    messages: [
      {
        role: "user",
        content: buildCoverageJudgePrompt({
          tailoredData: args.tailoredData,
          profile: args.profile,
          preparation: args.preparation,
        }),
      },
    ],
    jsonSchema: COVERAGE_JUDGE_SCHEMA,
  });

  if (!judgeResult.success) return args.tailoredData;
  const judgement = sanitizeCoverageJudgement(judgeResult.data);
  if (judgement.items.length === 0) return args.tailoredData;

  return {
    ...args.tailoredData,
    resumeAlignmentReport: calibrateResumeAlignmentReport({
      baseReport: args.tailoredData.resumeAlignmentReport,
      qualificationProfile: args.preparation.jdQualificationProfile,
      judgement,
      coveragePlan: args.preparation.coveragePlan,
    }),
  };
}

async function repairPitchIfNeeded(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  tailoredData: TailoredData;
  profile: ResumeProfile;
  jobDescription: string;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  context: TailoringContext;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  basePrompt: string;
}): Promise<TailoredData> {
  const initialJudge = await judgeResumePitch({
    llm: args.llm,
    model: args.model,
    tailoredData: args.tailoredData,
    resumePositioningPlan: args.resumePositioningPlan,
  });
  if (!initialJudge) return args.tailoredData;
  if (initialJudge.verdict === "pass") {
    return attachPitchJudgeTrace(args.tailoredData, initialJudge);
  }

  const rewriteRaw: Partial<TailoredData> = {
    headline: args.tailoredData.headline,
    summary: args.tailoredData.summary,
    skills: args.tailoredData.skills,
    experience: args.tailoredData.experience,
  };
  let rewriteAttempted = false;

  if (
    initialJudge.failedSections.includes("summary") ||
    initialJudge.failedSections.includes("skills")
  ) {
    const rewrittenSummarySkills = await rewriteSummaryAndSkillsForPitch({
      ...args,
      judge: initialJudge,
    });
    if (rewrittenSummarySkills) {
      rewriteAttempted = true;
      rewriteRaw.headline = rewrittenSummarySkills.headline;
      rewriteRaw.summary = rewrittenSummarySkills.summary;
      rewriteRaw.skills = rewrittenSummarySkills.skills;
    }
  }

  if (initialJudge.failedSections.includes("experience")) {
    const rewrittenExperience = await rewriteExperienceForPitch({
      ...args,
      judge: initialJudge,
    });
    if (rewrittenExperience) {
      rewriteAttempted = true;
      rewriteRaw.experience = rewrittenExperience;
    }
  }

  if (!rewriteAttempted) {
    return attachPitchJudgeTrace(args.tailoredData, initialJudge, {
      repairAttempted: false,
      repairFailed: true,
    });
  }

  let rewritten = buildTailoredData({
    raw: rewriteRaw,
    profile: args.profile,
    writingStyle: args.writingStyle,
    preparation: args.preparation,
    resumePositioningPlan: args.resumePositioningPlan,
    jdServiceValueBrief: args.jdServiceValueBrief,
  });
  rewritten = await calibrateTailoredDataWithAi({
    llm: args.llm,
    model: args.model,
    tailoredData: rewritten,
    profile: args.profile,
    preparation: args.preparation,
    force: true,
  });

  const secondJudge = await judgeResumePitch({
    llm: args.llm,
    model: args.model,
    tailoredData: rewritten,
    resumePositioningPlan: args.resumePositioningPlan,
  });
  if (secondJudge?.verdict === "pass") {
    return attachPitchJudgeTrace(rewritten, secondJudge, {
      repairAttempted: true,
      repairFailed: false,
    });
  }

  return attachPitchJudgeTrace(args.tailoredData, secondJudge ?? initialJudge, {
    repairAttempted: true,
    repairFailed: true,
  });
}

async function repairServiceFitIfNeeded(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  tailoredData: TailoredData;
  profile: ResumeProfile;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  context: TailoringContext;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  basePrompt: string;
}): Promise<TailoredData> {
  if (!args.jdServiceValueBrief) return args.tailoredData;

  let currentReport = await verifyResumeServiceFit({
    llm: args.llm,
    model: args.model,
    jobTitle: args.context.jobTitle,
    employer: args.context.employer,
    jdServiceValueBrief: args.jdServiceValueBrief,
    resumePositioningPlan: args.resumePositioningPlan,
    headline: args.tailoredData.headline,
    summary: args.tailoredData.summary,
    skills: args.tailoredData.skills,
    experience: args.tailoredData.experience,
    selectedEvidence: args.preparation.selectedEvidence,
    generationTrace: args.tailoredData.generationTrace,
  });
  let current = attachServiceFitReport(args.tailoredData, currentReport);
  if (
    !needsServiceFitRepair(currentReport) ||
    isVerifierUnavailable(currentReport)
  ) {
    return current;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repairResult = await args.llm.callJson<Partial<TailoredData>>({
      model: args.model,
      messages: [
        {
          role: "user",
          content: buildServiceFitRepairPrompt({
            basePrompt: args.basePrompt,
            draft: current,
            report: currentReport,
            jdServiceValueBrief: args.jdServiceValueBrief,
            resumePositioningPlan: args.resumePositioningPlan,
            attempt: attempt + 1,
          }),
        },
      ],
      jsonSchema: TAILORING_SCHEMA,
    });
    if (!repairResult.success) {
      logger.warn("Resume service-fit repair failed", {
        error: repairResult.error,
        attempt: attempt + 1,
        jobTitle: args.context.jobTitle,
        employer: args.context.employer,
      });
      return current;
    }

    let repaired = buildTailoredData({
      raw: {
        headline: current.headline,
        summary: current.summary,
        skills: current.skills,
        experience: current.experience,
        ...repairResult.data,
      },
      profile: args.profile,
      writingStyle: args.writingStyle,
      preparation: args.preparation,
      resumePositioningPlan: args.resumePositioningPlan,
      jdServiceValueBrief: args.jdServiceValueBrief,
    });
    repaired = await calibrateTailoredDataWithAi({
      llm: args.llm,
      model: args.model,
      tailoredData: repaired,
      profile: args.profile,
      preparation: args.preparation,
      force: true,
    });
    const repairedReport = await verifyResumeServiceFit({
      llm: args.llm,
      model: args.model,
      jobTitle: args.context.jobTitle,
      employer: args.context.employer,
      jdServiceValueBrief: args.jdServiceValueBrief,
      resumePositioningPlan: args.resumePositioningPlan,
      headline: repaired.headline,
      summary: repaired.summary,
      skills: repaired.skills,
      experience: repaired.experience,
      selectedEvidence: args.preparation.selectedEvidence,
      generationTrace: repaired.generationTrace,
    });
    repaired = attachServiceFitReport(repaired, repairedReport);
    if (isBetterServiceFitReport(repairedReport, currentReport)) {
      current = repaired;
      currentReport = repairedReport;
    }
    if (
      !needsServiceFitRepair(currentReport) ||
      isVerifierUnavailable(currentReport)
    ) {
      break;
    }
  }

  return current;
}

function attachServiceFitReport(
  data: TailoredData,
  report: ResumeServiceFitReport,
): TailoredData {
  return {
    ...data,
    resumeServiceFitReport: report,
  };
}

function isBetterServiceFitReport(
  next: ResumeServiceFitReport,
  current: ResumeServiceFitReport,
): boolean {
  const statusValue = (status: ResumeServiceFitReport["status"]) =>
    status === "pass" ? 3 : status === "needs_review" ? 2 : 1;
  if (statusValue(next.status) > statusValue(current.status)) return true;
  if (statusValue(next.status) < statusValue(current.status)) return false;
  const nextIssues =
    next.missingOrWeakServiceValues.length +
    next.oldFrameRisks.length +
    next.unsupportedOrNeedsConfirmation.filter(
      (item) => item.severity === "high",
    ).length;
  const currentIssues =
    current.missingOrWeakServiceValues.length +
    current.oldFrameRisks.length +
    current.unsupportedOrNeedsConfirmation.filter(
      (item) => item.severity === "high",
    ).length;
  return next.score > current.score + 3 || nextIssues < currentIssues;
}

function isVerifierUnavailable(report: ResumeServiceFitReport): boolean {
  return report.missingOrWeakServiceValues.some((item) =>
    item.toLowerCase().includes("verifier was unavailable"),
  );
}

function buildServiceFitRepairPrompt(args: {
  basePrompt: string;
  draft: TailoredData;
  report: ResumeServiceFitReport;
  jdServiceValueBrief: JdServiceValueBrief;
  resumePositioningPlan: ResumePositioningPlan | null;
  attempt: number;
}): string {
  const sections = Array.from(
    new Set(args.report.manualFixSuggestions.map((item) => item.section)),
  );
  const sectionText = sections.length
    ? sections.join(", ")
    : "summary, skills, experience";
  return [
    args.basePrompt,
    "",
    `SERVICE-FIT TARGETED REPAIR PASS ${args.attempt} OF 2.`,
    "Return the same JSON shape: headline, summary, skills, experience.",
    `Only change these sections unless a high-severity unsupported claim forces softening elsewhere: ${sectionText}.`,
    "Preserve facts, dates, employers, section order, and evidence boundaries.",
    "Do not invent Salesforce, Asana, TAM, forecast models, health-sector depth, direct venture-client ownership, metrics, tools, industries, clients, credentials, or certifications.",
    "High-severity unsupported claims must be removed or softened. Medium/soft claims may be softened and left for user confirmation.",
    "This repair is mandatory when the report says the service-value signal is unclear. Rewrite the headline/summary and the strongest relevant experience bullets so the target buyer need is visible in the actual resume text.",
    "If SERVICE-FIT REPORT TO FIX is under-specified, use the JD SERVICE VALUE BRIEF directly: summary must lead with candidateValueProposition or buyerNeed, skills must include evidence-backed mustSignalConcepts, and lead experience bullets must translate old-domain evidence into expectedDeliverables/businessDecisionsSupported.",
    "Do not merely add keywords. The rewritten wording must explain what service the candidate can provide to this employer and what decisions or deliverables that supports.",
    "",
    "JD SERVICE VALUE BRIEF:",
    formatJdServiceValueBriefForPrompt(args.jdServiceValueBrief),
    "",
    "RESUME POSITIONING PLAN:",
    formatResumePositioningPlanForPrompt(args.resumePositioningPlan) ||
      "No positioning plan.",
    "",
    "SERVICE-FIT REPORT TO FIX:",
    JSON.stringify(args.report, null, 2),
    "",
    "CURRENT RESUME JSON:",
    JSON.stringify(
      {
        headline: args.draft.headline,
        summary: args.draft.summary,
        skills: args.draft.skills,
        experience: args.draft.experience,
      },
      null,
      2,
    ),
  ].join("\n");
}

async function judgeResumePitch(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  tailoredData: TailoredData;
  resumePositioningPlan: ResumePositioningPlan | null;
}): Promise<ResumePitchJudgeResponse | null> {
  if (!args.resumePositioningPlan) return null;
  try {
    const result = await args.llm.callJson<ResumePitchJudgeResponse>({
      model: args.model,
      messages: [
        {
          role: "user",
          content: buildPitchJudgePrompt({
            tailoredData: args.tailoredData,
            resumePositioningPlan: args.resumePositioningPlan,
          }),
        },
      ],
      jsonSchema: PITCH_JUDGE_SCHEMA,
    });
    if (!result.success) {
      logger.warn("Resume pitch judge failed", { error: result.error });
      return null;
    }
    return sanitizePitchJudge(result.data);
  } catch (error) {
    logger.warn("Resume pitch judge threw", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function rewriteSummaryAndSkillsForPitch(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  tailoredData: TailoredData;
  profile: ResumeProfile;
  jobDescription: string;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  context: TailoringContext;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  basePrompt: string;
  judge: ResumePitchJudgeResponse;
}): Promise<SummaryAndSkillsResponse | null> {
  try {
    const result = await args.llm.callJson<SummaryAndSkillsResponse>({
      model: args.model,
      messages: [
        {
          role: "user",
          content: buildPitchSummarySkillsRewritePrompt(args),
        },
      ],
      jsonSchema: SUMMARY_SKILLS_SCHEMA,
    });
    if (!result.success) {
      logger.warn("Pitch summary/skills rewrite failed", {
        error: result.error,
      });
      return null;
    }
    const sanitized = sanitizeSummaryAndSkills(result.data);
    return sanitized.summary || sanitized.headline ? sanitized : null;
  } catch (error) {
    logger.warn("Pitch summary/skills rewrite threw", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function rewriteExperienceForPitch(args: {
  llm: Awaited<ReturnType<typeof createConfiguredLlmService>>;
  model: string;
  tailoredData: TailoredData;
  profile: ResumeProfile;
  jobDescription: string;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  context: TailoringContext;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  judge: ResumePitchJudgeResponse;
}): Promise<TailoredExperienceItem[] | null> {
  const failedIds = new Set(
    args.judge.failedExperienceIds.map(comparableExperienceId),
  );
  if (failedIds.size === 0) return null;
  const contexts = getVisibleExperienceGenerationContexts(
    args.profile,
    args.preparation.sourceExperiences,
  );
  const next = [...args.tailoredData.experience];
  let changed = false;
  for (const experience of contexts) {
    if (!failedIds.has(comparableExperienceId(experience.id))) continue;
    try {
      const result = await args.llm.callJson<ResumeExperienceItemResponse>({
        model: args.model,
        messages: [
          {
            role: "user",
            content: buildPitchExperienceRewritePrompt(args, experience),
          },
        ],
        jsonSchema: EXPERIENCE_ITEM_SCHEMA,
      });
      if (!result.success) {
        logger.warn("Pitch experience rewrite failed", {
          error: result.error,
          experienceId: experience.id,
        });
        continue;
      }
      const sanitized = sanitizeExperience([result.data])[0];
      if (!sanitized) continue;
      const verified = markExperienceRepairGenerated(
        verifyExperienceItemBoundary(args, experience, {
          ...sanitized,
          id: sanitized.id || experience.id,
        }),
      );
      const index = next.findIndex(
        (item) =>
          comparableExperienceId(item.id) ===
          comparableExperienceId(experience.id),
      );
      if (index >= 0) next[index] = verified;
      else next.push(verified);
      changed = true;
    } catch (error) {
      logger.warn("Pitch experience rewrite threw", {
        error: error instanceof Error ? error.message : String(error),
        experienceId: experience.id,
      });
    }
  }
  return changed ? next : null;
}

function sanitizePitchJudge(
  value: Partial<ResumePitchJudgeResponse>,
): ResumePitchJudgeResponse {
  const failedSections = Array.isArray(value.failedSections)
    ? value.failedSections.filter(
        (item): item is "summary" | "skills" | "experience" =>
          item === "summary" || item === "skills" || item === "experience",
      )
    : [];
  return {
    verdict: value.verdict === "fail" ? "fail" : "pass",
    dominantPitchDetected: sanitizeText(value.dominantPitchDetected ?? ""),
    targetPitchMatched: Boolean(value.targetPitchMatched),
    sourcePitchDominating: Boolean(value.sourcePitchDominating),
    failedSections: uniqueStrings(failedSections).slice(0, 3) as Array<
      "summary" | "skills" | "experience"
    >,
    failedExperienceIds: sanitizeStringList(value.failedExperienceIds, 10),
    reasons: sanitizeStringList(value.reasons, 8),
  };
}

function attachPitchJudgeTrace(
  data: TailoredData,
  judge: ResumePitchJudgeResponse,
  flags: { repairAttempted?: boolean; repairFailed?: boolean } = {},
): TailoredData {
  const repackagingVerifier = {
    ...data.generationTrace.repackagingVerifier,
    generatorVersion:
      data.generationTrace.repackagingVerifier?.generatorVersion ??
      RESUME_POSITIONING_GENERATOR_VERSION,
    roleEmphasis: data.generationTrace.repackagingVerifier?.roleEmphasis ?? [],
    bulletVerdicts:
      data.generationTrace.repackagingVerifier?.bulletVerdicts ?? [],
    softenedBullets:
      data.generationTrace.repackagingVerifier?.softenedBullets ?? 0,
    droppedBullets:
      data.generationTrace.repackagingVerifier?.droppedBullets ?? 0,
    unsupportedClaimReasons:
      data.generationTrace.repackagingVerifier?.unsupportedClaimReasons ?? [],
    targetPitch: data.resumePositioningPlan?.targetPitch,
    sourcePitch: data.resumePositioningPlan?.sourcePitch,
    pitchJudge: {
      ...judge,
      ...flags,
    },
  };
  const generationTrace = {
    ...data.generationTrace,
    repackagingVerifier,
  };
  return {
    ...data,
    generationTrace,
    resumeAlignmentReport: {
      ...data.resumeAlignmentReport,
      generationTrace,
    },
  };
}

function markExperienceRepairGenerated(
  item: TailoredExperienceItem,
): TailoredExperienceItem {
  return {
    ...item,
    bulletTrace: item.bulletTrace?.map((trace) => ({
      ...trace,
      repairGenerated: true,
    })),
  };
}

function buildPitchJudgePrompt(args: {
  tailoredData: TailoredData;
  resumePositioningPlan: ResumePositioningPlan;
}): string {
  const plan = args.resumePositioningPlan;
  const leadExperience = args.tailoredData.experience.map((item) => ({
    id: item.id,
    bullets: item.bullets.slice(0, 2),
  }));
  const boundarySummary = args.tailoredData.generationTrace.repackagingVerifier
    ? {
        softenedBullets:
          args.tailoredData.generationTrace.repackagingVerifier.softenedBullets,
        droppedBullets:
          args.tailoredData.generationTrace.repackagingVerifier.droppedBullets,
        unsupportedClaimReasons:
          args.tailoredData.generationTrace.repackagingVerifier
            .unsupportedClaimReasons,
      }
    : {};
  return [
    "You are a constrained pitch judge for resume repackaging.",
    "Return JSON only. Judge whether the generated resume's first impression matches the target pitch. Do not rewrite.",
    "Do not judge factual support here; evidence boundary diagnostics are provided separately.",
    "",
    "REPACKAGING BRIEF:",
    JSON.stringify(
      {
        targetPitch:
          plan.targetPitch || plan.candidateThesis || plan.targetFrame,
        sourcePitch: plan.sourcePitch,
        pitchDelta: plan.pitchDelta,
        allowedTranslations: plan.allowedTranslations,
        overclaimRisks: plan.overclaimRisks,
        experienceUse: plan.experienceUse,
        targetFrame: plan.targetFrame,
        avoidFrame: plan.avoidFrame,
        mustAppearConcepts: plan.mustAppearConcepts,
        mustAvoidConcepts: plan.mustAvoidConcepts,
      },
      null,
      2,
    ),
    "",
    "GENERATED LEAD RESUME:",
    JSON.stringify(
      {
        headline: args.tailoredData.headline,
        summary: args.tailoredData.summary,
        skills: args.tailoredData.skills.map((group) => ({
          name: group.name,
          keywords: group.keywords.slice(0, 8),
        })),
        leadExperience,
      },
      null,
      2,
    ),
    "",
    "BOUNDARY DIAGNOSTICS SUMMARY:",
    JSON.stringify(boundarySummary, null, 2),
    "",
    "JUDGE RULES:",
    "- Fail summary when headline/summary still primarily reads as sourcePitch rather than targetPitch.",
    "- Fail skills when group names stay generic or source-pitch oriented instead of target-pitch oriented.",
    "- Fail experience only for primary experienceUse items whose lead bullets do not support their rewriteGoal, or when downplayed experience dominates the target pitch.",
    "- Do not fail supporting/downplayed experiences merely because they do not use targetPitch language.",
    "- Old source-pitch terms may appear as factual context, but fail if they dominate headline, summary, skills, or primary lead bullets.",
  ].join("\n");
}

function buildPitchSummarySkillsRewritePrompt(args: {
  tailoredData: TailoredData;
  profile: ResumeProfile;
  jobDescription: string;
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
  context: TailoringContext;
  preparation: TailoringPreparation;
  resumePositioningPlan: ResumePositioningPlan | null;
  jdServiceValueBrief: JdServiceValueBrief | null;
  basePrompt: string;
  judge: ResumePitchJudgeResponse;
}): string {
  return [
    buildSummaryAndSkillsPrompt(args),
    "",
    "TARGETED PITCH REWRITE: SUMMARY/SKILLS ONLY.",
    "Return the same JSON shape: headline, summary, skills.",
    "Rewrite only to fix the pitch judge failures. Do not add unsupported tools, industries, metrics, clients, credentials, or certifications.",
    "Preserve evidence boundaries. Use weak/no-evidence requirements only as transferable capability, interest, or omit.",
    "",
    "PITCH JUDGE FAILURE:",
    JSON.stringify(args.judge, null, 2),
    "",
    "CURRENT SUMMARY/SKILLS:",
    JSON.stringify(
      {
        headline: args.tailoredData.headline,
        summary: args.tailoredData.summary,
        skills: args.tailoredData.skills,
      },
      null,
      2,
    ),
    "",
    "REPACKAGING BRIEF:",
    formatResumePositioningPlanForPrompt(args.resumePositioningPlan),
    "",
    "SOURCE-BACKED EVIDENCE:",
    formatSelectedEvidenceForPrompt(args.preparation.selectedEvidence) ||
      "No selected evidence; keep wording conservative.",
  ].join("\n");
}

function buildPitchExperienceRewritePrompt(
  args: {
    tailoredData: TailoredData;
    profile: ResumeProfile;
    jobDescription: string;
    writingStyle: Awaited<ReturnType<typeof getWritingStyle>>;
    context: TailoringContext;
    preparation: TailoringPreparation;
    resumePositioningPlan: ResumePositioningPlan | null;
    jdServiceValueBrief: JdServiceValueBrief | null;
    judge: ResumePitchJudgeResponse;
  },
  experience: VisibleExperienceGenerationContext,
): string {
  const current = args.tailoredData.experience.find(
    (item) =>
      comparableExperienceId(item.id) === comparableExperienceId(experience.id),
  );
  const experienceUse = args.resumePositioningPlan?.experienceUse?.find(
    (item) =>
      comparableExperienceId(item.id) === comparableExperienceId(experience.id),
  );
  return [
    buildExperienceItemPrompt(args, experience),
    "",
    "TARGETED PITCH REWRITE: THIS EXPERIENCE ONLY.",
    "Return the same JSON shape: id, bullets.",
    "Fix only this experience's pitch failure. Do not rewrite other roles or borrow claims from them.",
    "If this role is supporting/downplayed, do not force it into the target pitch; keep it concise and truthful.",
    "Preserve facts and evidence boundaries. Do not add unsupported tools, industries, metrics, clients, credentials, or certifications.",
    "",
    "PITCH JUDGE FAILURE:",
    JSON.stringify(args.judge, null, 2),
    "",
    "THIS EXPERIENCE USE:",
    experienceUse
      ? JSON.stringify(experienceUse, null, 2)
      : "No explicit use item.",
    "",
    "CURRENT BULLETS:",
    JSON.stringify(current?.bullets ?? [], null, 2),
  ].join("\n");
}

function buildCoverageJudgePrompt(args: {
  tailoredData: TailoredData;
  profile: ResumeProfile;
  preparation: TailoringPreparation;
}): string {
  const resumeSections = buildGeneratedResumeSections({
    profile: args.profile,
    summary: args.tailoredData.summary,
    skills: args.tailoredData.skills,
    experience: args.tailoredData.experience,
  });
  const selectedEvidence = formatSelectedEvidenceForPrompt(
    args.preparation.selectedEvidence,
  );
  return [
    "You are a concise resume qualification coverage judge.",
    "Judge only whether the visible generated resume content covers each required JD qualification.",
    "Respect each coverage brief semantic type and allowed evidence sections. Education requirements must be judged from education evidence, not experience bullets, unless the JD explicitly allows an education-and-experience equivalency.",
    "Ignore non-scored boilerplate such as values statements, company descriptions, website links, education equivalency policy notes, position equivalency codes, hours, wage, salary/base salary, compensation factors, bargaining unit, benefits, and application logistics.",
    "Use reference/master evidence only to decide whether an uncovered gap is repairable. Do not mark a requirement covered unless the generated resume visibly says it or a truthful transferable wording clearly covers it.",
    "Statuses:",
    "- covered: visible resume content covers the qualification without inventing facts.",
    "- repairable: master/reference evidence supports the qualification, but visible resume wording is missing or too weak.",
    "- human_input_needed: neither visible resume nor evidence supports it; do not invent it.",
    "Return one item for every required qualification. Keep sections and evidenceSources short.",
    "",
    "REQUIRED QUALIFICATIONS:",
    args.preparation.jdQualificationProfile.required
      .slice(0, 8)
      .map((item) => `- ${item}`)
      .join("\n"),
    "",
    "VISIBLE GENERATED RESUME SECTIONS:",
    JSON.stringify(resumeSections, null, 2),
    "",
    "QUALIFICATION COVERAGE BRIEF:",
    formatResumeCoveragePlanInstructions(args.preparation.coveragePlan),
    selectedEvidence ? `\nSELECTED EVIDENCE GATE:\n${selectedEvidence}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function sanitizeCoverageJudgement(
  value: Partial<AiCoverageJudgeResponse> | undefined,
): AiCoverageJudgeResponse {
  const items = Array.isArray(value?.items) ? value.items : [];
  return {
    items: items
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const qualification =
          typeof record.qualification === "string"
            ? record.qualification.trim()
            : "";
        const status = record.status;
        if (
          !qualification ||
          (status !== "covered" &&
            status !== "repairable" &&
            status !== "human_input_needed")
        ) {
          return null;
        }
        const sections = Array.isArray(record.sections)
          ? record.sections
              .filter(
                (section): section is string => typeof section === "string",
              )
              .map((section) => section.trim())
              .filter(Boolean)
              .slice(0, 5)
          : [];
        const evidenceSources = Array.isArray(record.evidenceSources)
          ? record.evidenceSources
              .filter((source): source is string => typeof source === "string")
              .map((source) => source.trim())
              .filter(Boolean)
              .slice(0, 5)
          : [];
        return { qualification, status, sections, evidenceSources };
      })
      .filter((item): item is AiQualificationCoverageJudgement => Boolean(item))
      .slice(0, 8),
  };
}

function calibrateResumeAlignmentReport(args: {
  baseReport: ResumeAlignmentReport;
  qualificationProfile: JdQualificationProfile;
  judgement: AiCoverageJudgeResponse;
  coveragePlan: ResumeCoveragePlan;
}): ResumeAlignmentReport {
  const byQualification = new Map(
    args.judgement.items.map((item) => [
      normalizeComparable(item.qualification),
      item,
    ]),
  );
  const matchedSections: Record<string, number> = {
    ...args.baseReport.matchedSections,
  };
  const missingRequired: string[] = [];
  const partialRequired: string[] = [];
  const repairableRequired: string[] = [];
  const humanInputNeeded: string[] = [];
  const referenceUsed = [...(args.baseReport.referenceUsed ?? [])].slice(0, 5);
  let covered = 0;
  let partial = 0;

  for (const qualification of args.qualificationProfile.required.slice(0, 8)) {
    const item = byQualification.get(normalizeComparable(qualification));
    const semanticType = inferQualificationSemanticType(qualification);
    if (semanticType === "admin/non_scored") continue;
    const baseMissing = includesComparable(
      args.baseReport.missingRequired,
      qualification,
    );
    const basePartial = includesComparable(
      args.baseReport.partialRequired,
      qualification,
    );
    if (!item) {
      if (baseMissing) {
        missingRequired.push(qualification);
        humanInputNeeded.push(qualification);
      } else if (basePartial) {
        partialRequired.push(qualification);
        repairableRequired.push(qualification);
        partial += 1;
      } else {
        covered += 1;
      }
      continue;
    }

    if (item.status === "covered") {
      covered += 1;
      for (const section of item.sections) {
        matchedSections[section] = (matchedSections[section] ?? 0) + 1;
      }
      collectReferenceSources(referenceUsed, item.evidenceSources);
      continue;
    }

    if (semanticType === "education" && !baseMissing && !basePartial) {
      covered += 1;
      matchedSections.education = (matchedSections.education ?? 0) + 1;
      collectReferenceSources(referenceUsed, item.evidenceSources);
      continue;
    }

    if (item.status === "repairable") {
      partial += 1;
      if (partialRequired.length < 5) partialRequired.push(qualification);
      if (repairableRequired.length < 5) repairableRequired.push(qualification);
      collectReferenceSources(referenceUsed, item.evidenceSources);
      continue;
    }

    if (missingRequired.length < 5) missingRequired.push(qualification);
    if (humanInputNeeded.length < 5) humanInputNeeded.push(qualification);
  }

  const requiredCount = Math.max(
    args.qualificationProfile.required.slice(0, 8).length,
    1,
  );
  const score = Math.max(
    0,
    Math.min(100, Math.round(((covered + partial * 0.5) / requiredCount) * 90)),
  );
  const status =
    missingRequired.length >= 2
      ? "failed"
      : missingRequired.length === 1 || partialRequired.length > 0
        ? "warning"
        : "pass";

  return {
    ...args.baseReport,
    score,
    status,
    missingRequired,
    partialRequired,
    matchedSections,
    referenceUsed,
    humanInputNeeded,
    repairableRequired,
    evidenceFit:
      args.baseReport.evidenceFit ?? buildEvidenceFitReport(args.coveragePlan),
    alignmentSource: "ai_calibrated",
  };
}

function hasRepairableAlignmentGap(
  report: ResumeAlignmentReport,
  coveragePlan: ResumeCoveragePlan,
): boolean {
  return (
    (report.repairableRequired?.length ?? 0) > 0 ||
    hasRepairableCoverageGap(coveragePlan)
  );
}

function hasDensityRepairGap(trace: ResumeGenerationTrace): boolean {
  if (trace.contentPlan?.targetPages !== 2) return false;
  return (trace.densityWarnings ?? []).some((warning) =>
    /\b(?:underdeveloped|density is low|unused high-value)\b/i.test(warning),
  );
}

function hasPositioningQualityGap(data: TailoredData): boolean {
  const plan = data.resumePositioningPlan;
  if (!plan) return false;
  const leadText = normalizeComparable(
    [
      data.headline,
      data.summary,
      data.experience
        .slice(0, 2)
        .flatMap((item) => item.bullets.slice(0, 2))
        .join(" "),
    ].join(" "),
  );
  const wholeText = normalizeComparable(
    [
      leadText,
      data.skills
        .map((group) => `${group.name} ${group.keywords.join(" ")}`)
        .join(" "),
    ].join(" "),
  );
  const mustAppear = (plan.mustAppearConcepts ?? [])
    .map(normalizeComparable)
    .filter((item) => item.length >= 4);
  const leadConcepts = uniqueStrings([
    ...mustAppear,
    ...plan.skillsStrategy.groups.map((group) => group.name),
  ])
    .map(normalizeComparable)
    .filter((item) => item.length >= 4);
  const missingLeadPositioning =
    leadConcepts.length > 0 &&
    !leadConcepts.some((concept) =>
      textMatchesPositioningConcept(leadText, concept),
    );
  const missingMustAppear =
    mustAppear.length > 0 &&
    !mustAppear.some((concept) =>
      textMatchesPositioningConcept(wholeText, concept),
    );
  const avoidLead = [...plan.avoidFrame, ...(plan.mustAvoidConcepts ?? [])]
    .map(normalizeComparable)
    .filter((item) => item.length >= 4)
    .some((concept) => textMatchesPositioningConcept(leadText, concept));
  const plannedGroups = plan.skillsStrategy.groups
    .map((group) => normalizeComparable(group.name))
    .filter((name) => name.length >= 4);
  const generatedGroups = data.skills.map((group) =>
    normalizeComparable(group.name),
  );
  const matchingGroups = plannedGroups.filter((name) =>
    generatedGroups.some(
      (generated) => generated.includes(name) || name.includes(generated),
    ),
  );
  const weakSkillsGrouping =
    plannedGroups.length >= 2 &&
    matchingGroups.length < Math.min(2, plannedGroups.length);
  return (
    missingLeadPositioning ||
    missingMustAppear ||
    avoidLead ||
    weakSkillsGrouping
  );
}

function textMatchesPositioningConcept(text: string, concept: string): boolean {
  if (!text || !concept) return false;
  if (text.includes(concept)) return true;
  const tokens = concept
    .split(/\s+/)
    .filter(
      (token) => token.length >= 4 && !COMMON_POSITIONING_WORDS.has(token),
    );
  if (tokens.length === 0) return false;
  if (tokens.length <= 2) return tokens.every((token) => text.includes(token));
  return tokens.filter((token) => text.includes(token)).length >= 2;
}

const COMMON_POSITIONING_WORDS = new Set([
  "analyst",
  "associate",
  "candidate",
  "client",
  "clients",
  "role",
  "work",
  "working",
  "supporting",
  "support",
  "focused",
]);

function isBetterTailoredData(args: {
  next: TailoredData;
  current: TailoredData;
  densityRepairRequested: boolean;
  positioningRepairRequested: boolean;
}): boolean {
  const currentContent = generatedContentWeight(args.current);
  const nextContent = generatedContentWeight(args.next);
  if (currentContent >= 6 && nextContent < currentContent * 0.55) {
    return false;
  }
  if (
    hasPitchJudgePass(args.current) &&
    args.current.generationTrace.repackagingVerifier?.pitchJudge
      ?.repairAttempted === true &&
    hasPositioningQualityGap(args.next)
  ) {
    return false;
  }
  if (
    isBetterAlignment(
      args.next.resumeAlignmentReport,
      args.current.resumeAlignmentReport,
    )
  ) {
    return true;
  }
  if (
    args.positioningRepairRequested &&
    !hasPositioningQualityGap(args.next) &&
    args.next.resumeAlignmentReport.score >=
      args.current.resumeAlignmentReport.score - 5
  ) {
    return true;
  }
  if (!args.densityRepairRequested) return false;
  const currentWarnings =
    args.current.generationTrace.densityWarnings?.length ?? 0;
  const nextWarnings = args.next.generationTrace.densityWarnings?.length ?? 0;
  if (nextWarnings < currentWarnings) return true;
  return (
    experienceWordCount(args.next.experience) >
    experienceWordCount(args.current.experience)
  );
}

function hasPitchJudgePass(data: TailoredData): boolean {
  return (
    data.generationTrace.repackagingVerifier?.pitchJudge?.verdict === "pass"
  );
}

function generatedContentWeight(data: TailoredData): number {
  return (
    countWords(data.summary) +
    data.skills.flatMap((group) => group.keywords).length * 2 +
    data.experience.flatMap((item) => item.bullets).length * 4
  );
}

function experienceWordCount(experience: TailoredExperienceItem[]): number {
  return countWords(experience.flatMap((item) => item.bullets).join(" "));
}

function isBetterAlignment(
  next: ResumeAlignmentReport,
  current: ResumeAlignmentReport,
): boolean {
  if (statusRank(next.status) > statusRank(current.status)) return true;
  if (next.score > current.score) return true;
  if (
    (next.missingRequired?.length ?? 0) < (current.missingRequired?.length ?? 0)
  ) {
    return true;
  }
  if (
    (next.humanInputNeeded?.length ?? 0) <
    (current.humanInputNeeded?.length ?? 0)
  ) {
    return true;
  }
  if (
    (next.repairableRequired?.length ?? 0) <
    (current.repairableRequired?.length ?? 0)
  ) {
    return true;
  }
  if (
    (next.partialRequired?.length ?? 0) < (current.partialRequired?.length ?? 0)
  ) {
    return true;
  }
  return false;
}

function markAutoRewriteAttempted(data: TailoredData): TailoredData {
  const wordingGaps = (data.resumeAlignmentReport.repairableRequired ?? [])
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, 5);
  return {
    ...data,
    resumeAlignmentReport: {
      ...data.resumeAlignmentReport,
      autoRewriteApplied: true,
      wordingGapsAfterAutoRewrite: wordingGaps,
    },
  };
}

function statusRank(status: ResumeAlignmentReport["status"]): number {
  return status === "pass" ? 3 : status === "warning" ? 2 : 1;
}

function collectReferenceSources(
  values: string[],
  evidenceSources: string[],
): void {
  for (const source of evidenceSources) {
    const normalized = source.startsWith("reference:")
      ? source.slice("reference:".length)
      : source;
    if (!normalized || normalized.startsWith("resume:")) continue;
    if (values.length >= 5) return;
    if (
      !values.some((value) => value.toLowerCase() === normalized.toLowerCase())
    ) {
      values.push(normalized);
    }
  }
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function includesComparable(values: string[], target: string): boolean {
  const normalizedTarget = normalizeComparable(target);
  return values.some(
    (value) => normalizeComparable(value) === normalizedTarget,
  );
}

// ---------------------------------------------------------------------------
// Section-focused brief builders — pre-assemble evidence per output section
// so the AI doesn't need to cross-reference 13 separate prompt sections.
// ---------------------------------------------------------------------------

function buildJdRequirementsText(
  qualProfile: JdQualificationProfile,
  keywordProfile: JdKeywordProfile,
): string {
  const lines: string[] = [];
  if (qualProfile.required.length) {
    lines.push("Required qualifications:");
    for (const q of qualProfile.required.slice(0, 12)) {
      lines.push(`- ${q}`);
    }
  }
  if (qualProfile.preferred.length) {
    lines.push("Preferred qualifications:");
    for (const q of qualProfile.preferred.slice(0, 6)) {
      lines.push(`- ${q}`);
    }
  }
  if (qualProfile.keywords.length) {
    lines.push(
      `Core keywords: ${qualProfile.keywords.slice(0, 20).join(", ")}`,
    );
  }
  if (keywordProfile.blockedUnlessPresent.length) {
    lines.push(
      `Domain terms allowed ONLY if JD mentions them: ${keywordProfile.blockedUnlessPresent.join(", ")}`,
    );
  }
  return lines.join("\n") || "No structured JD requirements extracted.";
}

function buildCoverageLegend(): string {
  return [
    "direct   = proven in master resume or selected evidence - state confidently",
    "transferable = related evidence exists — reframe in JD language, do not over-claim",
    "none     = no supporting evidence found — leave this qualification out",
  ].join("\n");
}

function buildExperienceBrief(args: {
  profile: ResumeProfile;
  sourceExperiences: ExperienceEvidence[];
  experienceDigests: ExperienceCapabilityDigest[];
  coveragePlan: ResumeCoveragePlan;
  selectedEvidence: SelectedResumeEvidence[];
  generationDecision: ResumeGenerationDecision;
}): string {
  const {
    profile,
    sourceExperiences,
    experienceDigests,
    coveragePlan,
    selectedEvidence,
  } = args;
  const digestById = new Map(
    experienceDigests.map((digest) => [digest.experienceId, digest]),
  );

  const selectedChunks = selectedEvidence.flatMap((hit) =>
    hit.chunks.map((chunk) => ({
      qualification: hit.requirement,
      chunk,
    })),
  );

  const expQualifications = coveragePlan.items.filter((item) =>
    item.targetSections.includes("experience"),
  );

  const items = (profile.sections?.experience?.items ?? []).filter((e) => {
    const record = e as typeof e & { hidden?: boolean };
    return e.visible !== false && record.hidden !== true;
  });

  if (items.length === 0) return "No visible experience entries.";

  return items
    .map((e, index) => {
      const record = e as typeof e & { description?: string; period?: string };
      const sourceText =
        sourceExperiences.find((s) => s.id === e.id)?.sourceText ||
        stripHtml([e.summary, record.description].filter(Boolean).join("\n")) ||
        "";
      const experienceText = [e.company, e.position, sourceText]
        .join(" ")
        .toLowerCase();
      const digest = digestById.get(e.id || `experience-${index}`);

      // Find qualifications that target this experience entry.
      const targetingQuals = expQualifications
        .filter((qi) => {
          const qualText = qi.qualification.toLowerCase();
          // Match if qualification keywords overlap with experience text, or
          // if the coverage plan specifically lists this as an evidence section.
          return (
            qi.evidenceSources.some((src) => src.includes("experience")) ||
            qualText
              .split(/\s+/)
              .some((w) => w.length > 3 && experienceText.includes(w))
          );
        })
        .slice(0, 5);

      const relevantChunks = selectedChunks
        .filter((c) => {
          const chunkText = (c.chunk.rawText || "").toLowerCase();
          return (
            chunkText.includes(experienceText.slice(0, 40)) ||
            (e.company && chunkText.includes(e.company.toLowerCase())) ||
            targetingQuals.some((q) =>
              chunkText.includes(q.qualification.toLowerCase().slice(0, 30)),
            )
          );
        })
        .slice(0, 3);

      const lines: string[] = [];
      lines.push(
        `### Experience #${index}: ${e.position || "Untitled"} at ${e.company || "Unknown"} (${record.period || e.date || "?"})`,
      );
      lines.push(`ID: "${e.id || String(index)}"`);
      if (sourceText) {
        lines.push(`Master resume evidence: ${truncate(sourceText, 600)}`);
      } else {
        lines.push(
          "Master resume evidence: (sparse - use only selected evidence below)",
        );
      }
      if (digest) {
        lines.push("Experience capability digest:");
        lines.push(
          `  Fit: ${digest.fitLevel} | confidence: ${digest.confidence}`,
        );
        lines.push(`  Summary: ${digest.capabilitySummary}`);
        lines.push(
          `  Core claims: ${digest.coreClaims.slice(0, 8).join("; ") || "none"}`,
        );
        lines.push(
          `  Transferable claims: ${digest.transferableClaims.slice(0, 6).join("; ") || "none"}`,
        );
        lines.push(
          `  Required bullet themes: ${digest.recommendedBulletThemes.slice(0, 10).join("; ") || "none"}`,
        );
        lines.push(
          `  Blocked claims: ${digest.blockedClaims.slice(0, 6).join("; ") || "none"}`,
        );
      }
      if (targetingQuals.length) {
        lines.push("JD qualifications to address:");
        targetingQuals.forEach((q) => {
          const hints =
            q.allowedWordingHints.length > 0
              ? ` | allowed wording: ${q.allowedWordingHints.slice(0, 6).join(", ")}`
              : "";
          lines.push(`  - [${q.evidenceStatus}] ${q.qualification}${hints}`);
        });
      }
      if (relevantChunks.length) {
        lines.push("Selected evidence:");
        relevantChunks.forEach((c) => {
          const group = c.chunk.evidenceGroupId
            ? ` | group=${c.chunk.evidenceGroupId}`
            : "";
          lines.push(
            `  - ${c.chunk.chunkId}${group} | ${c.chunk.sourceFile} > ${c.chunk.section}: ${truncate(c.chunk.rawText || "", 400)}`,
          );
        });
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function buildSkillsBrief(args: {
  profile: ResumeProfile;
  jdKeywordProfile: JdKeywordProfile;
  coveragePlan: ResumeCoveragePlan;
  selectedEvidence: SelectedResumeEvidence[];
}): string {
  const { profile, jdKeywordProfile, coveragePlan, selectedEvidence } = args;

  const lines: string[] = [];

  // Current master resume skills.
  const skillItems = (
    profile.sections?.skills as unknown as {
      items?: Array<{ name: string; keywords: string[] }>;
    }
  )?.items;
  if (skillItems?.length) {
    lines.push("Current master resume skill categories:");
    skillItems.forEach((group) => {
      lines.push(`- ${group.name}: ${(group.keywords || []).join(", ")}`);
    });
  }
  lines.push(
    "Skill section style: keep this section to 3 specific functional groups. Prefer master/reference-style names such as Market & Audience Research, Data Analysis & Quality Control, and Reporting & Analytics Tools. Do not create broad filler groups such as Strategy & Analysis, Tools, Technical Skills, Soft Skills, or Communication.",
  );

  // JD skills-related qualifications.
  const skillsQuals = coveragePlan.items.filter((item) =>
    item.targetSections.includes("skills"),
  );
  if (skillsQuals.length) {
    lines.push("\nJD qualifications targeting skills section:");
    skillsQuals.forEach((q) => {
      const hints =
        q.allowedWordingHints.length > 0
          ? ` | allowed wording: ${q.allowedWordingHints.slice(0, 6).join(", ")}`
          : "";
      lines.push(`- [${q.evidenceStatus}] ${q.qualification}${hints}`);
    });
  }

  const jdKeywords = Array.from(
    new Set([
      ...jdKeywordProfile.requiredKeywords,
      ...jdKeywordProfile.experienceFocus,
    ]),
  );
  if (jdKeywords.length) {
    lines.push(`\nJD keywords to incorporate: ${jdKeywords.join(", ")}`);
  }

  const adjacentSkillCandidates = buildEvidenceBackedAdjacentSkillCandidates({
    skillItems,
    jdKeywordProfile,
    skillsQuals,
    selectedEvidence,
  });
  if (adjacentSkillCandidates.length) {
    lines.push(
      `\nEvidence-backed adjacent skill candidates for Skills section only: ${adjacentSkillCandidates.join(", ")}`,
    );
    lines.push(
      "Do not use these as experience claims unless selected evidence directly supports the claim.",
    );
  }

  const skillChunks = selectedEvidence
    .filter((hit) =>
      skillsQuals.some((q) => q.qualification === hit.requirement),
    )
    .flatMap((hit) => hit.chunks)
    .slice(0, 4);
  if (skillChunks.length) {
    lines.push("\nSelected evidence for skills:");
    skillChunks.forEach((c) => {
      lines.push(
        `- ${c.chunkId} | ${c.sourceFile} > ${c.section}: ${truncate(c.rawText || "", 300)}`,
      );
    });
  }

  return lines.join("\n") || "No skills data available.";
}

const DATA_SKILL_EXPANSION_TRIGGERS = [
  "data processing",
  "data analysis",
  "data handling",
  "data reporting",
];

const DATA_SKILL_EXPANSION_CANDIDATES = [
  "Excel",
  "SQL",
  "Power BI",
  "data cleaning",
  "data validation",
  "quality assurance",
  "QA checks",
  "dashboard reporting",
  "reporting workflows",
];

function buildEvidenceBackedAdjacentSkillCandidates(args: {
  skillItems?: Array<{ name: string; keywords: string[] }>;
  jdKeywordProfile: JdKeywordProfile;
  skillsQuals: ResumeCoveragePlan["items"];
  selectedEvidence: SelectedResumeEvidence[];
}): string[] {
  const jdText = normalizeComparable(
    [
      ...args.jdKeywordProfile.requiredKeywords,
      ...args.jdKeywordProfile.experienceFocus,
      ...args.skillsQuals.map((item) => item.qualification),
    ].join(" "),
  );
  if (
    !DATA_SKILL_EXPANSION_TRIGGERS.some((trigger) =>
      jdText.includes(normalizeComparable(trigger)),
    )
  ) {
    return [];
  }

  const evidenceText = normalizeComparable(
    [
      ...(args.skillItems ?? []).flatMap((group) => [
        group.name,
        ...(group.keywords ?? []),
      ]),
      ...args.selectedEvidence.flatMap((item) =>
        item.chunks.flatMap((chunk) => [chunk.rawText, ...chunk.keywords]),
      ),
    ].join(" "),
  );

  return DATA_SKILL_EXPANSION_CANDIDATES.filter((candidate) =>
    evidenceText.includes(normalizeComparable(candidate)),
  );
}

function buildSummaryBrief(args: { coveragePlan: ResumeCoveragePlan }): string {
  const { coveragePlan } = args;
  const summaryTargets = coveragePlan.items.filter((item) =>
    item.targetSections.includes("summary"),
  );
  if (summaryTargets.length === 0) {
    return "No specific summary themes extracted. Cover 3-4 strongest JD themes backed by evidence.";
  }
  const lines: string[] = [
    `Cover 3-4 of these themes (prioritize "covered" or "direct" status):`,
  ];
  summaryTargets.slice(0, 6).forEach((item, i) => {
    const hints =
      item.allowedWordingHints.length > 0
        ? ` | wording: ${item.allowedWordingHints.slice(0, 5).join(", ")}`
        : "";
    lines.push(
      `${i + 1}. [${item.evidenceStatus}; ${item.sourceType}] ${item.qualification}${hints}`,
    );
  });
  return lines.join("\n");
}

function buildEducationBrief(args: {
  profile: ResumeProfile;
  coveragePlan: ResumeCoveragePlan;
  jdQualificationProfile: JdQualificationProfile;
}): string {
  const { profile, coveragePlan } = args;
  const lines: string[] = [];

  const eduItems = Array.isArray(
    (profile.sections as Record<string, unknown> | undefined)?.education,
  )
    ? ((profile.sections as Record<string, unknown>).education as Array<
        Record<string, unknown>
      >)
    : [];

  if (eduItems.length) {
    lines.push("Current education entries:");
    eduItems.forEach((item, i) => {
      lines.push(
        `${i + 1}. ${item.school || ""} — ${item.degree || ""} — ${item.period || ""} — GPA: ${item.grade || "N/A"}`,
      );
      // Show description but strip duplicate GPA mentions
      const desc =
        typeof item.description === "string" ? stripHtml(item.description) : "";
      if (desc) {
        lines.push(`   Existing description: ${truncate(desc, 300)}`);
      }
    });
  }

  const eduQuals = coveragePlan.items.filter(
    (item) =>
      item.semanticType === "education" ||
      item.semanticType === "credential/license" ||
      item.qualification.toLowerCase().includes("degree") ||
      item.qualification.toLowerCase().includes("education"),
  );
  if (eduQuals.length) {
    lines.push("\nJD education requirements:");
    eduQuals.forEach((q) => {
      lines.push(`- [${q.evidenceStatus}] ${q.qualification}`);
    });
  }

  lines.push(
    "\nNote: Do NOT duplicate GPA. If the degree line already shows GPA, remove it from the description bullet.",
  );

  return lines.join("\n") || "No education data available.";
}

function buildLegacyProfileJson(
  profile: ResumeProfile,
  sourceExperiences: ExperienceEvidence[],
): Record<string, unknown> {
  return {
    basics: {
      name: profile.basics?.name,
      label: profile.basics?.label,
      summary: profile.basics?.summary,
    },
    skills: profile.sections?.skills,
    projects: profile.sections?.projects?.items?.map((p) => ({
      name: p.name,
      description: p.description,
      summary: stripHtml(p.summary ?? ""),
      keywords: p.keywords,
    })),
    education: (profile.sections as Record<string, unknown> | undefined)
      ?.education,
    experience: profile.sections?.experience?.items?.map((e) => {
      const record = e as typeof e & {
        description?: string;
        period?: string;
        hidden?: boolean;
      };
      return {
        id: e.id,
        company: e.company,
        position: e.position,
        location: e.location,
        date: e.date || record.period,
        visible: e.visible !== false && record.hidden !== true,
        summary: e.summary,
        description: record.description,
        sourceText:
          sourceExperiences.find((s) => s.id === e.id)?.sourceText ?? "",
      };
    }),
  };
}

async function buildTailoringPrompt(
  profile: ResumeProfile,
  jd: string,
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>,
  context: TailoringContext,
  preparation?: TailoringPreparation,
  resumePositioningPlan?: ResumePositioningPlan | null,
  jdServiceValueBrief?: JdServiceValueBrief | null,
): Promise<string> {
  const resolvedLanguage = resolveWritingOutputLanguage({
    style: writingStyle,
    profile,
  });
  const outputLanguage = getWritingLanguageLabel(resolvedLanguage.language);
  const resolvedPreparation =
    preparation ??
    (await prepareTailoring({
      profile,
      jobDescription: jd,
      context,
    }));
  const {
    jdKeywordProfile,
    jdQualificationProfile,
    sourceExperiences,
    experienceDigests,
    coveragePlan,
    generationDecision,
  } = resolvedPreparation;
  const experienceEvidence = resolvedPreparation.evidenceScopes.experience;
  const skillsEvidence = resolvedPreparation.evidenceScopes.skills;
  const summarySkillsEvidence = mergeSelectedEvidenceScopes(
    resolvedPreparation.evidenceScopes.summary,
    resolvedPreparation.evidenceScopes.skills,
  );
  let effectiveConstraints = stripLanguageDirectivesFromConstraints(
    writingStyle.constraints,
  );
  if (writingStyle.summaryMaxWords != null) {
    effectiveConstraints = stripWordLimitFromConstraints(effectiveConstraints);
  }
  if (writingStyle.maxKeywordsPerSkill != null) {
    effectiveConstraints =
      stripKeywordLimitFromConstraints(effectiveConstraints);
  }

  // Build section-focused briefs that pre-match evidence to resume sections.
  const jdRequirementsText = buildJdRequirementsText(
    jdQualificationProfile,
    jdKeywordProfile,
  );
  const coverageLegend = buildCoverageLegend();
  const experienceBrief = buildExperienceBrief({
    profile,
    sourceExperiences,
    experienceDigests,
    coveragePlan,
    selectedEvidence: experienceEvidence,
    generationDecision,
  });
  const skillsBrief = buildSkillsBrief({
    profile,
    jdKeywordProfile,
    coveragePlan,
    selectedEvidence: skillsEvidence,
  });
  const summaryBrief = buildSummaryBrief({ coveragePlan });
  const educationBrief = buildEducationBrief({
    profile,
    coveragePlan,
    jdQualificationProfile,
  });

  // Replace {{jobDescription}} and {{profileJson}} from old templates if user
  // has a custom template that still uses them (backward compat).
  const template = await getEffectivePromptTemplate("tailoringPromptTemplate");
  const rendered = renderPromptTemplate(template, {
    jdRequirements: jdRequirementsText,
    coverageLegend,
    experienceBrief,
    skillsBrief,
    summaryBrief,
    educationBrief,
    outputLanguage,
    tone: writingStyle.tone,
    formality: writingStyle.formality,
    summaryMaxWordsLine:
      writingStyle.summaryMaxWords != null
        ? ` Maximum ${writingStyle.summaryMaxWords} ${writingStyle.summaryMaxWords === 1 ? "word" : "words"}.`
        : "",
    maxKeywordsPerSkillLine:
      writingStyle.maxKeywordsPerSkill != null
        ? `\n   - Maximum ${writingStyle.maxKeywordsPerSkill} ${writingStyle.maxKeywordsPerSkill === 1 ? "keyword" : "keywords"} per category. If a category has more, keep only the most JD-relevant ones.`
        : "",
    constraintsBullet: effectiveConstraints
      ? `- Additional constraints: ${effectiveConstraints}`
      : "",
    avoidTermsBullet: writingStyle.doNotUse
      ? `- Avoid these words or phrases: ${writingStyle.doNotUse}`
      : "",
    // Backward compat: old templates still expect these
    jobDescription: jd,
    profileJson: JSON.stringify(
      buildLegacyProfileJson(profile, sourceExperiences),
      null,
      2,
    ),
  });

  // Append selected evidence as supplementary context after the main prompt.
  const applicationWritingInstructions =
    await buildApplicationWritingInstructionsForJob({
      title: context.jobTitle,
      employer: context.employer,
      jobDescription: jd,
    });
  const referenceInstructions = await buildResumeReferenceInstructions({
    roleFamily: generationDecision.roleFamily,
    targetPages: generationDecision.targetPages,
    formatReferences: generationDecision.formatReferences,
  });
  const selectedEvidenceInstructions = formatSelectedEvidenceForPrompt(
    summarySkillsEvidence,
  );
  const contentPlanInstructions = formatResumeContentPlanForPrompt(
    resolvedPreparation.contentPlan,
  );
  const bulletBundleInstructions = formatExperienceBulletBundlesForPrompt(
    resolvedPreparation.contentPlan.bulletBundleCandidates ?? [],
  );
  const experienceAnchorInstructions = formatExperienceAnchorsForPrompt(
    resolvedPreparation.experienceAnchors,
  );
  const experienceDigestInstructions =
    formatExperienceCapabilityDigestsForPrompt(experienceDigests);
  const positioningInstructions = formatResumePositioningPlanForPrompt(
    resumePositioningPlan ?? null,
  );
  const serviceValueInstructions = formatJdServiceValueBriefForPrompt(
    jdServiceValueBrief ?? null,
  );

  const resumePolicyInstructions = buildResumePolicyInstructions({
    roleFamily: generationDecision.roleFamily,
    roleLabel: generationDecision.roleFamily,
    resumeTargetPages: generationDecision.targetPages,
    resumePagePolicyMode: generationDecision.allowsManualResumeTargetPages
      ? "manual"
      : "locked",
    resumePagePolicyReason: generationDecision.documentPolicyReason,
    resumePagePolicyLabel: generationDecision.policyLabel,
    allowsManualResumeTargetPages:
      generationDecision.allowsManualResumeTargetPages,
    coverLetter: {
      maxWords: 400,
      targetBodyWords: 330,
      salutation: "To Whom It May Concern:",
      requirePersonalHeader: true,
      requireReLine: true,
    },
    reason: generationDecision.policyReason,
  });

  const repairInstructions = context.repair
    ? formatDomainRepairInstructions(context.repair)
    : "";

  return `${rendered}${
    referenceInstructions
      ? `\n\nRESUME REFERENCE LIBRARY (for layout, tone, bullet style):\n${referenceInstructions}`
      : ""
  }\n\nEXPERIENCE ANCHOR SUMMARIES (stable cache; use these to understand each role comprehensively, but do not invent specific claims unless selected evidence supports them):\n${experienceAnchorInstructions}\n\nEXPERIENCE CAPABILITY DIGESTS (compatibility view derived from anchors or fallback evidence; use for per-role bullet themes):\n${experienceDigestInstructions}\n\n${contentPlanInstructions}\n\nEXPERIENCE BULLET BUNDLE CANDIDATES (source-backed bullet opportunities; choose enough to satisfy JD coverage and page density):\n${bulletBundleInstructions}${"\n\nCONTENT PLAN ENFORCEMENT:\n- Treat bulletBudget as a density hint only; do not use it as a fixed per-experience cap or exact target.\n- Choose experience bullets from EXPERIENCE BULLET BUNDLE CANDIDATES. Each bullet should combine source-backed action, method/tool/data, output, and stakeholder or decision value when the bundle depth supports it.\n- For two-page resumes, if the experience section would be sparse, first expand selected bundle bullets with source-backed detail, then add more unused high-value bundles. Do not add filler bullets.\n- Skills are compact, not a page-filling section: output exactly 3 specific master-style skill groups unless the content plan says otherwise.\n- Skill group names should look like functional resume categories such as Market & Audience Research, Data Analysis & Quality Control, and Reporting & Analytics Tools. Avoid broad buckets like Strategy & Analysis, Tools, Technical Skills, Soft Skills, or Communication.\n- Use anchor summaries for context only. Every concrete JD-specific claim must be supported by SYSTEM SELECTED EVIDENCE BANK chunk IDs or a bullet bundle's sourceChunkIds.\n- If a requirement is blocked or has no evidence, do not write it as a concrete claim.\n- If a requirement is transferable only, write adjacent capability language and avoid claiming direct performance of the JD wording."}${
    selectedEvidenceInstructions
      ? `\n\nSYSTEM SELECTED EVIDENCE BANK (only these historical chunks may support new JD-specific claims):\n${selectedEvidenceInstructions}`
      : ""
  }${
    repairInstructions
      ? `\n\nPDF DOMAIN-GATE REPAIR:\n${repairInstructions}`
      : ""
  }${
    positioningInstructions
      ? `\n\nRESUME POSITIONING PLAN (apply before writing; keep original section, employer, and date order):\n${positioningInstructions}`
      : ""
  }${
    jdServiceValueBrief
      ? `\n\nJD SERVICE VALUE BRIEF (source of truth for buyer need and value narrative):\n${serviceValueInstructions}`
      : ""
  }\n\nAPPLICATION WRITING STRATEGY:\n${applicationWritingInstructions}\n\nDOCUMENT POLICY:\n${resumePolicyInstructions}`;
}

function formatResumePositioningPlanForPrompt(
  plan: ResumePositioningPlan | null,
): string {
  if (!plan) return "";
  const experience = plan.experienceStrategies
    .map((item) =>
      [
        `- ${item.experienceId}: ${item.desiredFrame}`,
        item.currentRisk ? `  current risk: ${item.currentRisk}` : "",
        item.emphasize.length
          ? `  emphasize: ${item.emphasize.join("; ")}`
          : "",
        item.deEmphasize.length
          ? `  de-emphasize: ${item.deEmphasize.join("; ")}`
          : "",
        item.allowedTransferableClaims.length
          ? `  allowed transferable claims: ${item.allowedTransferableClaims.join("; ")}`
          : "",
        item.forbiddenClaims.length
          ? `  forbidden claims: ${item.forbiddenClaims.join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
  const skills = plan.skillsStrategy.groups
    .map(
      (group) =>
        `- ${group.name}: ${group.keywords.join(", ")}${
          group.rationale ? ` (${group.rationale})` : ""
        }`,
    )
    .join("\n");
  const gaps = plan.gapStrategy
    .map(
      (item) =>
        `- ${item.jdNeed} [${item.evidenceStatus}]: ${item.wordingPolicy}`,
    )
    .join("\n");
  const translations = (plan.translationMap ?? [])
    .map(
      (item) =>
        `- ${item.sourceEvidence} -> ${item.jdFrame} [${item.claimType}]${
          item.limitations ? `; limits: ${item.limitations}` : ""
        }`,
    )
    .join("\n");
  const allowedTranslations = (plan.allowedTranslations ?? [])
    .map(
      (item) =>
        `- ${item.from} -> ${item.to} [${item.claimType}]${
          item.limit ? `; limit: ${item.limit}` : ""
        }`,
    )
    .join("\n");
  const experienceUse = (plan.experienceUse ?? [])
    .map(
      (item) =>
        `- ${item.id} [${item.use}]: ${item.rewriteGoal}${
          item.reason ? ` (${item.reason})` : ""
        }`,
    )
    .join("\n");
  return [
    plan.candidateThesis ? `Candidate thesis: ${plan.candidateThesis}` : "",
    plan.targetPitch ? `Target pitch: ${plan.targetPitch}` : "",
    plan.sourcePitch
      ? `Source pitch to move away from: ${plan.sourcePitch}`
      : "",
    plan.pitchDelta ? `Pitch delta: ${plan.pitchDelta}` : "",
    `Target frame: ${plan.targetFrame}`,
    plan.avoidFrame.length ? `Avoid frames: ${plan.avoidFrame.join("; ")}` : "",
    plan.primaryEvidenceRoles?.length
      ? `Primary evidence roles: ${plan.primaryEvidenceRoles.join("; ")}`
      : "",
    plan.supportingEvidenceRoles?.length
      ? `Supporting evidence roles: ${plan.supportingEvidenceRoles.join("; ")}`
      : "",
    plan.downplayedRoles?.length
      ? `Downplayed roles: ${plan.downplayedRoles.join("; ")}`
      : "",
    allowedTranslations
      ? `Allowed repackaging translations:\n${allowedTranslations}`
      : "",
    plan.overclaimRisks?.length
      ? `Overclaim risks: ${plan.overclaimRisks.join("; ")}`
      : "",
    experienceUse ? `Experience use:\n${experienceUse}` : "",
    translations ? `Allowed JD framing translations:\n${translations}` : "",
    plan.mustAppearConcepts?.length
      ? `Must-appear concepts: ${plan.mustAppearConcepts.join("; ")}`
      : "",
    plan.mustAvoidConcepts?.length
      ? `Must-avoid concepts: ${plan.mustAvoidConcepts.join("; ")}`
      : "",
    plan.readerExpectations.length
      ? `Reader expectations: ${plan.readerExpectations.join("; ")}`
      : "",
    plan.summaryStrategy.length
      ? `Summary strategy: ${plan.summaryStrategy.join("; ")}`
      : "",
    experience ? `Experience strategy:\n${experience}` : "",
    skills ? `Skills strategy:\n${skills}` : "",
    gaps
      ? `Gap wording policy:\n${gaps}\nFor weak/none gaps, do not claim direct experience; use transferable capability, interest, or omit.`
      : "",
    plan.polishChecks.length
      ? `Final polish checks: ${plan.polishChecks.join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDomainRepairInstructions(
  repair: NonNullable<TailoringContext["repair"]>,
): string {
  const residuals = repair.residuals
    .slice(0, 12)
    .map(
      (item) =>
        `- ${item.severity.toUpperCase()}: ${item.term} at ${item.path}. ${item.suggestedAction}`,
    )
    .join("\n");
  const previousDraft = repair.previousDraft
    ? `\nPrevious draft to repair, not preserve blindly:\n${JSON.stringify(
        repair.previousDraft,
        null,
        2,
      )}`
    : "";
  return `The previous PDF render was blocked by residual domain terms that are not supported by the current JD. Rewrite the affected generated content from JD qualifications, source resume evidence, and selected evidence. Do not use deterministic synonym swaps as the main fix; make the wording genuinely fit the JD. If a qualification or replacement claim lacks evidence, omit it and let the alignment report mark the gap.\n${residuals}${previousDraft}`;
}

function formatExperienceBulletBundlesForPrompt(
  bundles: ExperienceBulletBundle[],
): string {
  if (bundles.length === 0) {
    return "No source-backed bullet bundle candidates were available. Do not invent unsupported experience claims.";
  }
  return bundles
    .slice(0, 36)
    .map((bundle) =>
      [
        `- ${bundle.bundleId} | experience=${bundle.experienceId} | fit=${bundle.fit}/${bundle.confidence} | depth=${bundle.recommendedDepth}`,
        `  theme: ${bundle.theme}`,
        `  requirementIds: ${bundle.matchedRequirementIds.join(", ") || "none"}`,
        `  sourceChunkIds: ${bundle.sourceChunkIds.join(", ")}`,
        bundle.anchorId ? `  anchorId: ${bundle.anchorId}` : "",
        `  claims: ${bundle.requiredClaims.slice(0, 3).join(" | ")}`,
        bundle.blockedClaims.length
          ? `  blocked: ${bundle.blockedClaims.slice(0, 3).join(" | ")}`
          : "",
        `  reason: ${bundle.reason}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

function buildRepairPrompt(args: {
  basePrompt: string;
  draft: TailoredData;
  coveragePlan: ResumeCoveragePlan;
  report: ResumeAlignmentReport;
  resumePositioningPlan: ResumePositioningPlan | null;
}): string {
  const repairable = new Set(
    [
      ...(args.report.repairableRequired ?? []),
      ...args.report.partialRequired,
      ...args.report.missingRequired.filter(
        (item) => !(args.report.humanInputNeeded ?? []).includes(item),
      ),
    ].map(normalizeComparable),
  );
  const gaps = args.coveragePlan.items
    .filter(
      (item) =>
        item.status !== "covered" ||
        repairable.has(normalizeComparable(item.qualification)),
    )
    .slice(0, 5)
    .map((item) => {
      const sources = item.evidenceSources.length
        ? item.evidenceSources.join("; ")
        : "no evidence";
      return `- ${item.qualification} (${item.status}; ${sources})`;
    })
    .join("\n");
  const densityWarnings = args.draft.generationTrace.densityWarnings?.length
    ? args.draft.generationTrace.densityWarnings
        .map((item) => `- ${item}`)
        .join("\n")
    : "None.";
  const usedBundleIds = new Set(
    (args.draft.generationTrace.bulletBundlesUsed ?? []).map(
      (item) => item.bundleId,
    ),
  );
  const unusedHighValueBundles = (
    args.draft.generationTrace.bulletBundleCandidates ?? []
  )
    .filter(
      (bundle) =>
        !usedBundleIds.has(bundle.bundleId) &&
        (bundle.fit === "direct" || bundle.fit === "transferable") &&
        (bundle.confidence !== "low" || bundle.recommendedDepth !== "concise"),
    )
    .slice(0, 12);
  return `${args.basePrompt}\n\nPREVIOUS DRAFT JSON:\n${JSON.stringify(
    {
      headline: args.draft.headline,
      summary: args.draft.summary,
      skills: args.draft.skills,
      experience: args.draft.experience,
    },
    null,
    2,
  )}${
    args.resumePositioningPlan
      ? `\n\nPOSITIONING PLAN STILL APPLIES:\n${formatResumePositioningPlanForPrompt(args.resumePositioningPlan)}`
      : ""
  }\n\nTARGETED REPAIR PASS:\nRewrite the same JSON shape one more time. This is not optional: every listed gap with source resume evidence or selected evidence must become visible in one of its target resume sections using truthful JD-aligned wording. Preserve facts and do not invent tools, credentials, education, years, languages, metrics, employers, or outcomes. Use summary for only the strongest 2-3 themes; use experience bullets for responsibilities and transferable evidence; use skills only for JD-required evidence-backed skills; use education only for education evidence. If a gap has no evidence, do not invent it and keep unrelated sections concise.\n${gaps}\n\nPOSITIONING QUALITY REPAIR:\nThe final resume must visibly follow candidateThesis/targetFrame, use the planned functional skill groups when evidence allows, foreground primary evidence roles, and avoid letting downplayed roles or mustAvoidConcepts dominate. Do not solve this by adding unsupported keywords; reframe source-backed evidence only.\n\nDENSITY / BUNDLE REPAIR:\n${densityWarnings}\nIf density is underdeveloped and unused high-value bundles exist, supplement or expand experience bullets from these bundles only. Do not add filler, broad skills, or unsupported claims.\n${formatExperienceBulletBundlesForPrompt(unusedHighValueBundles)}`;
}

function sanitizeText(text: string): string {
  return text
    .replace(/\*\*[\s\S]*?\*\*/g, "") // remove markdown bold
    .trim();
}

function sanitizeExperience(value: unknown): TailoredExperienceItem[] {
  if (!Array.isArray(value)) return [];
  const sanitized: TailoredExperienceItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const bulletInputs = Array.isArray(record.bullets) ? record.bullets : [];
    const existingTrace = Array.isArray(record.bulletTrace)
      ? record.bulletTrace
      : [];
    const bullets: string[] = [];
    const bulletTrace: NonNullable<TailoredExperienceItem["bulletTrace"]> = [];
    for (const [index, bullet] of bulletInputs.slice(0, 6).entries()) {
      const priorTrace =
        existingTrace[index] && typeof existingTrace[index] === "object"
          ? (existingTrace[index] as NonNullable<
              TailoredExperienceItem["bulletTrace"]
            >[number])
          : undefined;
      if (typeof bullet === "string") {
        const text = sanitizeText(bullet);
        if (!text) continue;
        bullets.push(text);
        bulletTrace.push({
          ...(priorTrace ?? {}),
          claimSource: priorTrace?.claimSource ?? "ai_generated",
          boundaryVerdict: priorTrace?.boundaryVerdict ?? "legacy",
        });
        continue;
      }
      if (!bullet || typeof bullet !== "object") continue;
      const bulletRecord = bullet as Record<string, unknown>;
      const text = sanitizeText(
        typeof bulletRecord.text === "string" ? bulletRecord.text : "",
      );
      if (!text) continue;
      const claimType =
        bulletRecord.claimType === "direct" ||
        bulletRecord.claimType === "transferable" ||
        bulletRecord.claimType === "contextual"
          ? bulletRecord.claimType
          : "transferable";
      const supportIds = sanitizeStringList(bulletRecord.supportIds, 8);
      bullets.push(text);
      bulletTrace.push({
        ...(priorTrace ?? {}),
        claimSource: "ai_generated",
        claimType,
        positioningIntent: sanitizeText(
          typeof bulletRecord.positioningIntent === "string"
            ? bulletRecord.positioningIntent
            : "",
        ),
        riskFlags: sanitizeStringList(bulletRecord.riskFlags, 8),
        evidenceChunkIds: supportIds,
      });
    }
    if (id && bullets.length > 0) {
      sanitized.push({ id, bullets, bulletTrace });
    }
  }
  return sanitized;
}

function getExperienceEvidence(profile: ResumeProfile): ExperienceEvidence[] {
  return (
    profile.sections?.experience?.items
      ?.filter((item) => {
        const record = item as typeof item & { hidden?: boolean };
        return item.visible !== false && record.hidden !== true;
      })
      .map((item) => {
        const record = item as typeof item & {
          description?: string;
          period?: string;
        };
        return {
          id: item.id,
          sourceText: sanitizeText(
            stripHtml(
              [item.summary, record.description]
                .filter((value): value is string => Boolean(value))
                .join("\n"),
            ),
          ),
        };
      })
      .filter((item) => item.id && item.sourceText) ?? []
  );
}

function mergeExperienceWithFallback(args: {
  generated: TailoredExperienceItem[];
  sourceExperiences: ExperienceEvidence[];
  experienceDigests: ExperienceCapabilityDigest[];
  jdKeywordProfile: JdKeywordProfile;
}): TailoredExperienceItem[] {
  const digestById = new Map(
    args.experienceDigests.map((digest) => [digest.experienceId, digest]),
  );
  const fallbackById = new Map(
    args.sourceExperiences.map((source) => [
      source.id,
      uniqueStrings([
        ...extractFallbackBullets(source.sourceText),
        ...buildDigestFallbackBullets(digestById.get(source.id)),
      ])
        .map(
          (bullet) => applyDomainGateToText(bullet, args.jdKeywordProfile).text,
        )
        .map(sanitizeText)
        .filter(Boolean)
        .slice(0, 10),
    ]),
  );
  const fallbackByComparableId = new Map(
    [...fallbackById.entries()].map(([id, bullets]) => [
      comparableExperienceId(id),
      bullets,
    ]),
  );
  const merged: TailoredExperienceItem[] = args.generated
    .map((item): TailoredExperienceItem => {
      const bullets = item.bullets.map(sanitizeText).filter(Boolean);
      const fallbackBullets =
        fallbackById.get(item.id) ??
        fallbackByComparableId.get(comparableExperienceId(item.id)) ??
        [];
      const fallbackKeys = new Set(
        fallbackBullets.map((bullet) => normalizeComparable(bullet)),
      );
      const bulletTrace = bullets.map((bullet, index) => {
        const trace = item.bulletTrace?.[index];
        const isSourceFallback = fallbackKeys.has(
          normalizeComparable(bullets[index]),
        );
        if (!trace && !isSourceFallback) return undefined;
        const baseTrace = trace ?? {
          claimSource: "ai_generated",
          evidenceChunkIds: [],
        };
        if (!isSourceFallback) return trace;
        return {
          ...baseTrace,
          claimSource: baseTrace.claimSource,
          fallbackGenerated: true,
        };
      });
      const fallbackTrace = fallbackBullets.map(() => ({
        claimSource: "ai_generated",
        evidenceChunkIds: [],
        fallbackGenerated: true,
      }));
      const out: TailoredExperienceItem = {
        id: item.id,
        bullets: bullets.length > 0 ? bullets : fallbackBullets,
      };
      if (bullets.length > 0 && bulletTrace.some(Boolean)) {
        out.bulletTrace = bulletTrace.map(
          (trace) => trace ?? { claimSource: "ai_generated" },
        );
      } else if (fallbackBullets.length > 0) {
        out.bulletTrace = fallbackTrace;
      }
      return out;
    })
    .filter((item) => item.bullets.length > 0);
  const byId = new Set(merged.map((item) => item.id));

  for (const source of args.sourceExperiences) {
    if (byId.has(source.id)) continue;
    const fallbackBullets = fallbackById.get(source.id) ?? [];
    if (fallbackBullets.length === 0) continue;
    merged.push({ id: source.id, bullets: fallbackBullets });
  }

  return merged;
}

function extractFallbackBullets(sourceText: string): string[] {
  const bulletLike = sourceText
    .split(/(?:\n|•|- |\* )/)
    .map(sanitizeText)
    .filter((line) => line.length >= 24);
  if (bulletLike.length > 0) return bulletLike.slice(0, 10);

  return sourceText
    .split(/(?<=[.!?])\s+/)
    .map(sanitizeText)
    .filter((line) => line.length >= 24)
    .slice(0, 10);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = sanitizeText(value);
    if (!cleaned) continue;
    const key = normalizeComparable(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function stripHtml(text: string): string {
  return text
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function buildEvidenceText(
  profile: ResumeProfile,
  referenceEvidence: ResumeReferenceScanItem[],
): string {
  return [
    profile.basics?.summary,
    JSON.stringify(profile.sections?.skills ?? ""),
    JSON.stringify(profile.sections?.projects ?? ""),
    JSON.stringify(profile.sections?.experience ?? ""),
    JSON.stringify(
      (profile.sections as Record<string, unknown> | undefined)?.education ??
        "",
    ),
    ...referenceEvidence.map((item) =>
      [
        item.fileName,
        item.inferredRole,
        item.sections.join(" "),
        item.keywords?.join(" "),
        item.snippets?.summary,
        item.snippets?.experience,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  ]
    .filter(Boolean)
    .map((value) => stripHtml(String(value)))
    .join("\n");
}

function mergeReferenceItemsForCoverage(
  referenceEvidence: ResumeReferenceScanItem[],
  knowledgeHits: ResumeReferenceKnowledgeHit[],
): ResumeReferenceScanItem[] {
  const byKey = new Map<string, ResumeReferenceScanItem>();
  for (const item of referenceEvidence) {
    byKey.set(item.relativePath || item.fileName, item);
  }
  for (const chunk of knowledgeHits.flatMap((hit) => hit.chunks)) {
    const key = chunk.relativePath || chunk.fileName;
    const existing = byKey.get(key);
    const chunkText = `${chunk.section}: ${chunk.text}`;
    if (existing) {
      byKey.set(key, {
        ...existing,
        keywords: Array.from(
          new Set([...(existing.keywords ?? []), ...chunk.keywords]),
        ).slice(0, 40),
        snippets: {
          ...existing.snippets,
          experience: [existing.snippets?.experience, chunkText]
            .filter(Boolean)
            .join(" | ")
            .slice(0, 1800),
        },
      });
      continue;
    }
    byKey.set(key, {
      fileName: chunk.fileName,
      relativePath: chunk.relativePath,
      inferredRole: chunk.roleFamily,
      kind: chunk.kind,
      sections: [chunk.section],
      hasSkills: /skill/i.test(chunk.section),
      pageCount: null,
      lastModified: chunk.lastModified,
      size: chunk.size,
      keywords: chunk.keywords,
      snippets: {
        experience: chunkText,
      },
    });
  }
  return [...byKey.values()].slice(0, 20);
}

function buildSourceResumeSections(
  profile: ResumeProfile,
): Record<string, string> {
  const sections = profile.sections as Record<string, unknown> | undefined;
  const experience = profile.sections?.experience?.items
    ?.map((item) => {
      const record = item as typeof item & { description?: string };
      return [item.company, item.position, item.summary, record.description]
        .filter(Boolean)
        .join(" ");
    })
    .join(" ");
  return {
    summary: stripHtml(profile.basics?.summary ?? ""),
    skills: stripHtml(JSON.stringify(profile.sections?.skills ?? "")),
    experience: stripHtml(experience ?? ""),
    education: stripHtml(JSON.stringify(sections?.education ?? "")),
    projects: stripHtml(JSON.stringify(profile.sections?.projects ?? "")),
  };
}

function buildGeneratedResumeSections(args: {
  profile: ResumeProfile;
  summary: string;
  skills: Array<{ name: string; keywords: string[] }>;
  experience: TailoredExperienceItem[];
}): Record<string, string> {
  const experienceById = new Map(
    args.experience.map((item) => [item.id, item.bullets.join(" ")]),
  );
  const sourceExperience = args.profile.sections?.experience?.items
    ?.map((item) => {
      const record = item as typeof item & { description?: string };
      return (
        experienceById.get(item.id) ??
        [item.summary, record.description].filter(Boolean).join(" ")
      );
    })
    .join(" ");
  const sections = args.profile.sections as Record<string, unknown> | undefined;
  return {
    summary: args.summary,
    skills: args.skills
      .map((group) => `${group.name}: ${group.keywords.join(", ")}`)
      .join("\n"),
    experience: stripHtml(sourceExperience ?? ""),
    education: stripHtml(JSON.stringify(sections?.education ?? "")),
    projects: stripHtml(JSON.stringify(args.profile.sections?.projects ?? "")),
  };
}

function formatSelectedEvidenceForPrompt(
  items: SelectedResumeEvidence[],
): string {
  const limitedItems = items.slice(0, 12);
  const unsupportedBlocks = limitedItems
    .filter(
      (item) =>
        item.status === "no_evidence" ||
        item.status === "weak_evidence" ||
        item.chunks.length === 0,
    )
    .map((item) =>
      [
        `- Requirement: ${item.requirement}`,
        `  Status: ${item.status}`,
        item.fit
          ? `  Fit: ${item.fit}; confidence=${item.confidence ?? "low"}`
          : "",
        item.reason ? `  Reason: ${truncate(item.reason, 260)}` : "",
        item.blockedClaims?.length
          ? `  Blocked claims: ${item.blockedClaims.slice(0, 4).join("; ")}`
          : "",
        "  Instruction: Do not claim this requirement in the generated resume. If it is important, skip it or use only very general transferable wording already present in the master resume.",
      ].join("\n"),
    );

  const groups = new Map<
    string,
    {
      label: string;
      requirements: SelectedResumeEvidence[];
      chunks: Map<string, SelectedResumeEvidence["chunks"][number]>;
    }
  >();

  for (const item of limitedItems) {
    if (
      item.status === "no_evidence" ||
      item.status === "weak_evidence" ||
      item.chunks.length === 0
    ) {
      continue;
    }
    for (const chunk of item.chunks.slice(0, 3)) {
      const groupId =
        chunk.evidenceGroupId ??
        [chunk.sourceFile, chunk.roleFamily, chunk.section].join(" > ");
      const group = groups.get(groupId) ?? {
        label:
          chunk.evidenceGroupLabel ??
          [chunk.sourceFile, chunk.roleFamily, chunk.section]
            .filter(Boolean)
            .join(" > "),
        requirements: [],
        chunks: new Map<string, SelectedResumeEvidence["chunks"][number]>(),
      };
      if (
        !group.requirements.some(
          (requirement) =>
            (requirement.requirementId ?? requirement.requirement) ===
            (item.requirementId ?? item.requirement),
        )
      ) {
        group.requirements.push(item);
      }
      group.chunks.set(chunk.chunkId, chunk);
      groups.set(groupId, group);
    }
  }

  const groupBlocks = Array.from(groups.entries()).map(([groupId, group]) => {
    const requirements = group.requirements
      .map((item) =>
        [
          `  - Requirement: ${item.requirementId ?? "untracked"} | ${item.requirement}`,
          `    Status: ${item.status}`,
          `    Fit: ${item.fit ?? "direct"}; confidence=${item.confidence ?? "medium"}`,
          item.reason ? `    Reason: ${truncate(item.reason, 220)}` : "",
          item.allowedClaims?.length
            ? `    Allowed claims: ${item.allowedClaims.slice(0, 5).join("; ")}`
            : "",
          item.blockedClaims?.length
            ? `    Blocked claims: ${item.blockedClaims.slice(0, 4).join("; ")}`
            : "",
          item.status === "transferable_only"
            ? "    Instruction: Use only softened adjacent wording. Do not state the JD requirement as direct performed experience."
            : "    Instruction: This evidence may support direct JD-specific wording if the bullet stays faithful to the chunk.",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n");
    const chunks = Array.from(group.chunks.values())
      .map((chunk) => {
        const quality = chunk.qualitySignals
          ? ` | quality=${chunk.qualitySignals.confidence}, metrics=${chunk.qualitySignals.hasMetrics ? "yes" : "no"}`
          : "";
        const anchor = chunk.experienceAnchorId
          ? ` | anchor=${chunk.experienceAnchorId}`
          : "";
        const claim = chunk.claimType ? ` | claimType=${chunk.claimType}` : "";
        const sourceQuality = chunk.sourceQuality
          ? ` | sourceQuality=${chunk.sourceQuality}`
          : "";
        return `  - chunkId=${chunk.chunkId}${anchor}${claim}${sourceQuality}${quality} | ${chunk.sourceFile} > ${chunk.section}: ${truncate(chunk.rawText, 360)}`;
      })
      .join("\n");
    return [
      `Evidence group: ${groupId}`,
      `Label: ${group.label}`,
      "Supported requirements:",
      requirements,
      "Chunks:",
      chunks,
    ].join("\n");
  });

  return [
    groupBlocks.length
      ? "Evidence grouping rule: keep concrete facts attached to their evidence group/source experience. Do not merge facts from different groups into one experience bullet unless the source experience already supports both facts."
      : "",
    ...groupBlocks,
    ...unsupportedBlocks,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars - 1).trimEnd()}...`;
}
