import type { ApplicationRoleFamily } from "./settings";
import type { DocumentPolicy } from "../document-policy";
import type { ResumeAlignmentReport, ResumeServiceFitReport } from "./jobs";
import type { ResumeGenerationDecision } from "../resume-generation-decision";

export interface JobDocumentDiagnostics {
  jobId: string;
  policy: DocumentPolicy;
  pdf: {
    exists: boolean;
    pageCount: number | null;
    targetPages: 1 | 2;
    exceedsTarget: boolean;
  };
  skills: {
    tailoredSkillGroups: number;
    designResumeSkillsHidden: boolean | null;
    designResumeSkillItems: number | null;
    canRenderTailoredSkills: boolean;
  };
  alignment: ResumeAlignmentReport | null;
  serviceFit?: ResumeServiceFitReport | null;
  resumePlan?: ResumeGenerationDecision;
  issues: string[];
  recommendations: string[];
}

export interface ResumeReferenceScanItem {
  fileName: string;
  relativePath: string;
  inferredRole: string;
  kind: "resume" | "cover" | "combined" | "unknown";
  sections: string[];
  hasSkills: boolean;
  pageCount: number | null;
  lastModified?: number | null;
  size?: number | null;
  keywords?: string[];
  snippets?: {
    summary?: string;
    experience?: string;
    coverLetter?: string;
  };
}

export interface ResumeReferenceChunk {
  id: string;
  relativePath: string;
  fileName: string;
  kind: "resume" | "cover" | "combined" | "unknown";
  roleFamily: ApplicationRoleFamily | string;
  section: string;
  text: string;
  rawText?: string;
  normalizedText?: string;
  keywords: string[];
  clusterId?: string;
  evidenceGroupId?: string;
  evidenceGroupLabel?: string;
  embedding?: number[];
  qualitySignals?: ResumeEvidenceQualitySignals;
  experienceAnchorId?: string;
  claimType?:
    | "responsibility"
    | "tool"
    | "domain"
    | "outcome"
    | "metric"
    | "stakeholder"
    | "summary"
    | "education"
    | "other";
  anchorSection?: string;
  sourceQuality?: "high" | "medium" | "low";
  extractorUsed?:
    | "docx_xml"
    | "poppler_text"
    | "tesseract_ocr"
    | "lightweight_pdf_fallback";
  lastModified?: number | null;
  size?: number | null;
}

export interface ResumeEvidenceQualitySignals {
  textLength: number;
  keywordCount: number;
  hasMetrics: boolean;
  sectionScore: number;
  sourceKindScore: number;
  recencyScore: number;
  confidence: "high" | "medium" | "low";
}

export interface SelectedResumeEvidenceChunk {
  chunkId: string;
  clusterId?: string;
  evidenceGroupId?: string;
  evidenceGroupLabel?: string;
  experienceAnchorId?: string;
  sourceFile: string;
  relativePath: string;
  section: string;
  roleFamily: ApplicationRoleFamily | string;
  rawText: string;
  keywords: string[];
  qualitySignals?: ResumeEvidenceQualitySignals;
  claimType?: ResumeReferenceChunk["claimType"];
  anchorSection?: string;
  sourceQuality?: "high" | "medium" | "low";
  fit?: "direct" | "transferable" | "weak" | "unsupported";
  confidence?: "high" | "medium" | "low";
}

export interface SelectedResumeEvidence {
  requirement: string;
  requirementId?: string;
  category?: string;
  priority?: number;
  status: "selected" | "transferable_only" | "no_evidence" | "weak_evidence";
  fit?: "direct" | "transferable" | "weak" | "unsupported";
  confidence?: "high" | "medium" | "low";
  chunks: SelectedResumeEvidenceChunk[];
  missingReason?: string;
  reason?: string;
  allowedClaims?: string[];
  blockedClaims?: string[];
  candidateChunkCount?: number;
  sourceClusterIds?: string[];
}

export interface JdRequirementEvidenceMap {
  requirementId: string;
  requirement: string;
  fit: "direct" | "transferable" | "weak" | "unsupported";
  confidence: "high" | "medium" | "low";
  selectedChunkIds: string[];
  reason: string;
  allowedClaims: string[];
  blockedClaims: string[];
}

export type ResumeRequirementTier = "core" | "major" | "minor" | "blocked";
export type ExperienceCapabilityFitLevel = "primary" | "relevant" | "background";
export type ResumeExperienceAllocationKind =
  | "primary"
  | "supporting"
  | "background"
  | "omit";

export interface ExperienceCapabilityDigest {
  experienceId: string;
  label: string;
  fitLevel: ExperienceCapabilityFitLevel;
  capabilitySummary: string;
  coreClaims: string[];
  transferableClaims: string[];
  matchedRequirementIds: string[];
  recommendedBulletThemes: string[];
  sourceChunkIds: string[];
  blockedClaims: string[];
  confidence: "high" | "medium" | "low";
}

export interface ExperienceAnchorFact {
  text: string;
  sourceChunkIds: string[];
  sourceFiles?: string[];
  confidence?: "high" | "medium" | "low";
}

export interface ExperienceAnchorSummary {
  experienceAnchorId: string;
  identity: {
    company: string;
    title: string;
    dateRange?: string;
    location?: string;
    roleAliases: string[];
  };
  roleOverview: ExperienceAnchorFact;
  responsibilityAreas: ExperienceAnchorFact[];
  majorProjects: ExperienceAnchorFact[];
  toolsAndMethods: ExperienceAnchorFact[];
  domains: ExperienceAnchorFact[];
  stakeholders: ExperienceAnchorFact[];
  measurableOutcomes: ExperienceAnchorFact[];
  transferableStrengths: ExperienceAnchorFact[];
  limitationsOrUnverifiedClaims: ExperienceAnchorFact[];
  sourceChunkIds: string[];
  sourceFiles: string[];
  sourceDigestHash: string;
  confidence: "high" | "medium" | "low";
  diagnostics: {
    buildMethod: "deterministic" | "llm" | "fallback";
    sourceChunkCount: number;
    lowQualitySourceChunkIds: string[];
    orphanChunkIds: string[];
    warnings: string[];
  };
  lastBuiltAt: string;
  version: number;
}

export interface ResumeContentPlanRequirement {
  requirementId: string;
  requirement: string;
  category?: string;
  tier: ResumeRequirementTier;
  emphasisScore: number;
  fit: "direct" | "transferable" | "weak" | "unsupported";
  confidence: "high" | "medium" | "low";
  targetSections: string[];
  bulletBudget: number;
  reason: string;
  allowedClaims: string[];
  blockedClaims: string[];
}

export interface ResumeContentPlanExperienceAllocation {
  experienceId: string;
  label: string;
  kind: ResumeExperienceAllocationKind;
  digestId?: string;
  fitLevel?: ExperienceCapabilityFitLevel;
  experienceFitScore: number;
  bulletBudget: number;
  minBulletBudget?: number;
  maxBulletBudget?: number;
  requiredBulletThemes?: string[];
  coveredRequirementIds: string[];
  evidenceChunkIds: string[];
  reason: string;
}

export interface ExperienceBulletBundle {
  bundleId: string;
  experienceId: string;
  theme: string;
  requiredClaims: string[];
  sourceChunkIds: string[];
  anchorId?: string;
  matchedRequirementIds: string[];
  fit: "direct" | "transferable" | "weak" | "unsupported";
  confidence: "high" | "medium" | "low";
  blockedClaims: string[];
  recommendedDepth: "concise" | "standard" | "deep";
  reason: string;
}

export interface ResumeContentPlan {
  targetPages: 1 | 2;
  requirementTiers: ResumeContentPlanRequirement[];
  experienceAllocations: ResumeContentPlanExperienceAllocation[];
  sectionBudgets: {
    summaryWords: { min: number; max: number };
    skillGroups: { min: number; max: number };
    experienceBullets: { min: number; max: number };
  };
  pageFillTarget?: {
    mode: "compact_one_page" | "full_two_page";
    minExperienceBullets: number;
    targetExperienceBullets: number;
    minTotalWords: number;
    targetTotalWords: number;
    bulletWordTarget: { min: number; max: number };
    reason: string;
  };
  bulletBundleCandidates?: ExperienceBulletBundle[];
  densityTargets?: {
    minExperienceWords: number;
    targetExperienceWords: number;
    minAverageBulletWords: number;
    targetAverageBulletWords: number;
    minRelevantBundleCandidates: number;
    reason: string;
  };
  coverageTargets?: {
    coreRequirementIds: string[];
    majorRequirementIds: string[];
    relevantExperienceIds: string[];
  };
  bulletBudgets: Record<string, number>;
  softenedRequirements: string[];
  omittedOrDeemphasizedItems: Array<{
    id: string;
    label: string;
    action: "background" | "omit";
    reason: string;
  }>;
  blockedClaims: string[];
}

export interface ResumeGenerationTrace {
  selectedEvidence: SelectedResumeEvidence[];
  contentPlan?: ResumeContentPlan;
  bulletBundleCandidates?: ExperienceBulletBundle[];
  bulletBundlesUsed?: Array<{
    bundleId: string;
    experienceId: string;
    theme: string;
    sourceChunkIds: string[];
    matchedRequirementIds: string[];
  }>;
  densityWarnings?: string[];
  experienceDigests?: ExperienceCapabilityDigest[];
  experienceAnchors?: ExperienceAnchorSummary[];
  anchorEvidenceMap?: Array<{
    experienceAnchorId: string;
    selectedChunkIds: string[];
    matchedRequirementIds: string[];
  }>;
  anchorWarnings?: string[];
  experience: Array<{
    experienceId: string;
    bulletCount: number;
    evidenceChunkIds: string[];
    sourceFiles: string[];
    missingEvidence?: boolean;
    bullets?: Array<{
      text: string;
      claimSource: string;
      digestClaimId?: string;
      bundleId?: string;
      theme?: string;
      anchorId?: string;
      matchedRequirementIds?: string[];
      evidenceChunkIds: string[];
      claimType?: "direct" | "transferable" | "contextual";
      positioningIntent?: string;
      riskFlags?: string[];
      boundaryVerdict?: "pass" | "softened" | "dropped" | "legacy";
      boundaryReasons?: string[];
      repairGenerated?: boolean;
      fallbackGenerated?: boolean;
      densityRepairGenerated?: boolean;
      missingEvidence?: boolean;
    }>;
  }>;
  repackagingVerifier?: {
    generatorVersion: string;
    targetFrame?: string;
    candidateThesis?: string;
    targetPitch?: string;
    sourcePitch?: string;
    pitchJudge?: {
      verdict: "pass" | "fail";
      dominantPitchDetected: string;
      targetPitchMatched: boolean;
      sourcePitchDominating: boolean;
      failedSections: Array<"summary" | "skills" | "experience">;
      failedExperienceIds: string[];
      reasons: string[];
      repairAttempted?: boolean;
      repairFailed?: boolean;
    };
    roleEmphasis: Array<{
      experienceId: string;
      category: "primary" | "supporting" | "downplayed" | "unspecified";
    }>;
    bulletVerdicts: Array<{
      experienceId: string;
      bulletIndex: number;
      claimType?: "direct" | "transferable" | "contextual";
      verdict: "pass" | "softened" | "dropped" | "legacy";
      reasons: string[];
    }>;
    softenedBullets: number;
    droppedBullets: number;
    unsupportedClaimReasons: string[];
  };
  uncoveredRequirements: string[];
}

export interface ResumeReferenceIngestFile {
  fileName: string;
  relativePath?: string;
  kind?: "resume" | "cover" | "combined" | "unknown";
  contentBase64: string;
  mimeType?: string | null;
  lastModified?: number | null;
  size?: number | null;
}

export interface ResumeReferenceIngestionDiagnostics {
  totalFiles: number;
  parsedFiles: number;
  skippedFiles: Array<{
    fileName: string;
    relativePath: string;
    reason: string;
  }>;
  emptyTextFiles: Array<{
    fileName: string;
    relativePath: string;
    reason: string;
  }>;
  lowQualityFiles: Array<{
    fileName: string;
    relativePath: string;
    reason: string;
    textLength: number;
  }>;
  duplicateChunkRatio: number;
  clusterCount: number;
  chunkCount: number;
  extractorCounts?: Partial<
    Record<
      "docx_xml" | "poppler_text" | "tesseract_ocr" | "lightweight_pdf_fallback",
      number
    >
  >;
  ocrFileCount?: number;
  partialOcrFileCount?: number;
  missingDependencies?: string[];
  fileDiagnostics?: Array<{
    fileName: string;
    relativePath: string;
    extractor:
      | "docx_xml"
      | "poppler_text"
      | "tesseract_ocr"
      | "lightweight_pdf_fallback";
    ocrUsed: boolean;
    pageCount: number | null;
    textLength: number;
    missingDependencies: string[];
    reason: string;
    partialOcr?: boolean;
    ocrPageLimit?: number;
  }>;
  parser: "server";
}

export interface ResumeReferenceRepresentative {
  roleFamily: ApplicationRoleFamily | string;
  resume: ResumeReferenceScanItem | null;
  coverLetter: ResumeReferenceScanItem | null;
}

export interface ResumeReferenceScanResult {
  scannedAt: string;
  filesConsidered: number;
  activeCount?: number;
  resumeCount: number;
  coverLetterCount: number;
  combinedCount: number;
  chunkCount?: number;
  indexedChunkCount?: number;
  truncatedChunks?: number;
  indexStatus?: "not_indexed" | "indexed" | "failed";
  lastIndexError?: string;
  lastIndexedAt?: string;
  ragProbe?: {
    checkedAt: string;
    hitCount: number;
    sampleFiles: string[];
  };
  changeSummary?: {
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
  };
  coverage: Record<string, number>;
  items: ResumeReferenceScanItem[];
  chunks?: ResumeReferenceChunk[];
  representatives?: ResumeReferenceRepresentative[];
  ingestionDiagnostics?: ResumeReferenceIngestionDiagnostics;
  writingGuide?: Partial<
    Record<
      ApplicationRoleFamily | string,
      {
        resumeStyle?: string;
        bulletStyle?: string;
        skillsStyle?: string;
        coverLetterStyle?: string;
        sourceFiles: string[];
      }
    >
  >;
  experienceAnchors?: ExperienceAnchorSummary[];
  anchorDiagnostics?: {
    anchorCount: number;
    orphanEvidenceChunks: Array<{
      chunkId: string;
      sourceFile: string;
      reason: string;
    }>;
    staleAnchorWarnings: string[];
  };
}
