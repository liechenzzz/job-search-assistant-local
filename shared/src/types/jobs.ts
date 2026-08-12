import type { ExtractorSourceId } from "../extractors";
import type { LocationEvidence, LocationMatchResult } from "./location";
import type { ApplicationRoleFamily } from "./settings";

export type { LocationEvidenceQuality } from "./location";

export type JobLocationEvidence = LocationEvidence;

export type JobStatus =
  | "discovered" // Crawled but not processed
  | "processing" // Currently generating resume
  | "ready" // PDF generated, waiting for user to apply
  | "applied" // Application sent
  | "in_progress" // In process beyond initial application
  | "skipped" // User skipped this job
  | "expired"; // Deadline passed

export const APPLICATION_STAGES = [
  "applied",
  "recruiter_screen",
  "assessment",
  "hiring_manager_screen",
  "technical_interview",
  "onsite",
  "offer",
  "closed",
] as const;

export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export const STAGE_LABELS: Record<ApplicationStage, string> = {
  applied: "Applied",
  recruiter_screen: "Recruiter Screen",
  assessment: "Assessment",
  hiring_manager_screen: "Team Match",
  technical_interview: "Technical Interview",
  onsite: "Final Round",
  offer: "Offer",
  closed: "Closed",
};

export type StageTransitionTarget = ApplicationStage | "no_change";

export const APPLICATION_OUTCOMES = [
  "offer_accepted",
  "offer_declined",
  "rejected",
  "withdrawn",
  "no_response",
  "ghosted",
] as const;

export type JobOutcome = (typeof APPLICATION_OUTCOMES)[number];

export const APPLICATION_TASK_TYPES = [
  "prep",
  "todo",
  "follow_up",
  "check_status",
] as const;

export type ApplicationTaskType = (typeof APPLICATION_TASK_TYPES)[number];

export const INTERVIEW_TYPES = [
  "recruiter_screen",
  "technical",
  "onsite",
  "panel",
  "behavioral",
  "final",
] as const;

export type InterviewType = (typeof INTERVIEW_TYPES)[number];

export const INTERVIEW_OUTCOMES = [
  "pass",
  "fail",
  "pending",
  "cancelled",
] as const;

export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number];

export interface StageEventMetadata {
  note?: string | null;
  actor?: "system" | "user";
  groupId?: string | null;
  groupLabel?: string | null;
  eventLabel?: string | null;
  externalUrl?: string | null;
  reasonCode?: string | null;
  eventType?: "interview_log" | "status_update" | "note" | null;
}

export interface StageEvent {
  id: string;
  applicationId: string;
  title: string;
  groupId: string | null;
  fromStage: ApplicationStage | null;
  toStage: ApplicationStage;
  occurredAt: number;
  metadata: StageEventMetadata | null;
  outcome: JobOutcome | null;
}

export interface ApplicationTask {
  id: string;
  applicationId: string;
  type: ApplicationTaskType;
  title: string;
  dueDate: number | null;
  isCompleted: boolean;
  notes: string | null;
}

export interface Interview {
  id: string;
  applicationId: string;
  scheduledAt: number;
  durationMins: number | null;
  type: InterviewType;
  outcome: InterviewOutcome | null;
}

export interface JobNote {
  id: string;
  jobId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export type JobSource = ExtractorSourceId;

export interface JdKeywordProfile {
  roleFamily: ApplicationRoleFamily;
  requiredKeywords: string[];
  domainKeywordsPresent: string[];
  blockedUnlessPresent: string[];
  experienceFocus: string[];
}

export interface JdQualificationProfile {
  required: string[];
  preferred: string[];
  keywords: string[];
  confidence: "high" | "medium" | "low";
  ignoredAdminLines?: string[];
  requirements?: JdNormalizedRequirement[];
}

export type JdRequirementCategory =
  | "experience"
  | "skill"
  | "domain"
  | "tool"
  | "education"
  | "responsibility"
  | "soft_skill";

export interface JdNormalizedRequirement {
  id: string;
  text: string;
  category: JdRequirementCategory;
  priority: number;
  targetSections: string[];
  mustHave: boolean;
  evidenceNeeded: "direct" | "transferable" | "optional";
}

export type ResumeAlignmentStatus = "pass" | "warning" | "failed";

export interface ResumeAlignmentReport {
  engineVersion?: string;
  score: number;
  status: ResumeAlignmentStatus;
  missingRequired: string[];
  partialRequired: string[];
  matchedSections: Record<string, number>;
  referenceUsed: string[];
  humanInputNeeded?: string[];
  repairableRequired?: string[];
  autoRewriteApplied?: boolean;
  wordingGapsAfterAutoRewrite?: string[];
  evidenceFit?: EvidenceFitReport;
  alignmentSource?: "deterministic" | "ai_calibrated";
  generationTrace?: import("./document-policy").ResumeGenerationTrace;
}

export type ResumePositioningEvidenceStatus =
  | "direct"
  | "transferable"
  | "weak"
  | "none";

export interface ResumePositioningExperienceStrategy {
  experienceId: string;
  currentRisk: string;
  desiredFrame: string;
  emphasize: string[];
  deEmphasize: string[];
  allowedTransferableClaims: string[];
  forbiddenClaims: string[];
}

export interface ResumePositioningSkillGroup {
  name: string;
  keywords: string[];
  rationale: string;
}

export interface ResumePositioningGapStrategy {
  jdNeed: string;
  evidenceStatus: ResumePositioningEvidenceStatus;
  wordingPolicy: string;
}

export interface ResumePositioningTranslation {
  sourceEvidence: string;
  jdFrame: string;
  claimType: "direct" | "transferable" | "contextual";
  limitations: string;
}

export interface ResumeRepackagingAllowedTranslation {
  from: string;
  to: string;
  claimType: "direct" | "transferable" | "contextual";
  limit: string;
}

export interface ResumeRepackagingExperienceUse {
  id: string;
  use: "primary" | "supporting" | "downplayed";
  reason: string;
  rewriteGoal: string;
}

export interface ResumePositioningPlan {
  generatorVersion?: string;
  candidateThesis?: string;
  targetPitch?: string;
  sourcePitch?: string;
  pitchDelta?: string;
  allowedTranslations?: ResumeRepackagingAllowedTranslation[];
  overclaimRisks?: string[];
  experienceUse?: ResumeRepackagingExperienceUse[];
  targetFrame: string;
  avoidFrame: string[];
  primaryEvidenceRoles?: string[];
  supportingEvidenceRoles?: string[];
  downplayedRoles?: string[];
  translationMap?: ResumePositioningTranslation[];
  mustAppearConcepts?: string[];
  mustAvoidConcepts?: string[];
  readerExpectations: string[];
  summaryStrategy: string[];
  experienceStrategies: ResumePositioningExperienceStrategy[];
  skillsStrategy: {
    groups: ResumePositioningSkillGroup[];
  };
  gapStrategy: ResumePositioningGapStrategy[];
  polishChecks: string[];
}

export interface JdServiceValueBrief {
  buyerNeed: string;
  targetStakeholders: string[];
  businessDecisionsSupported: string[];
  expectedDeliverables: string[];
  mustSignalConcepts: string[];
  avoidDominantFrames: string[];
  candidateValueProposition: string;
  evidenceTranslationTargets: Array<{
    jdNeed: string;
    resumeProofTheme: string;
    acceptableWording: string;
    overclaimRisk: string;
  }>;
}

export interface ResumeServiceFitReport {
  status: "pass" | "needs_review" | "weak_fit";
  score: number;
  targetBuyerNeed: string;
  resumeCurrentlySignals: string[];
  matchedServiceValues: string[];
  missingOrWeakServiceValues: string[];
  oldFrameRisks: string[];
  unsupportedOrNeedsConfirmation: Array<{
    claim: string;
    severity: "soft" | "medium" | "high";
    recommendation: string;
  }>;
  manualFixSuggestions: Array<{
    section: "summary" | "skills" | "experience" | "education";
    issue: string;
    suggestedDirection: string;
  }>;
}

export interface EvidenceFitReport {
  score: number;
  status: ResumeAlignmentStatus;
  evidenceBackedRequired: string[];
  noEvidenceRequired: string[];
  referenceUsed: string[];
}

export type ResumeCoverageStatus = "covered" | "partial" | "missing";
export type ResumeQualificationSemanticType =
  | "education"
  | "experience"
  | "skill/tool"
  | "knowledge/domain"
  | "ability"
  | "credential/license"
  | "language"
  | "admin/non_scored";
export type ResumeQualificationEvidenceStatus =
  | "direct"
  | "transferable"
  | "none";
export type ResumeQualificationEvidenceSource = "master" | "reference" | "none";

export interface ResumeCoveragePlanItem {
  qualification: string;
  semanticType?: ResumeQualificationSemanticType;
  status: ResumeCoverageStatus;
  sections: string[];
  evidenceSources: string[];
  evidenceStatus: ResumeQualificationEvidenceStatus;
  targetSections: string[];
  allowedEvidenceSections?: string[];
  allowedWordingHints: string[];
  sourceType: ResumeQualificationEvidenceSource;
}

export interface ResumeCoveragePlan {
  items: ResumeCoveragePlanItem[];
  missingRequired: string[];
  partialRequired: string[];
  referenceUsed: string[];
}

export interface ResumeAlignmentDetailResponse {
  jobId: string;
  qualificationProfile: JdQualificationProfile | null;
  serviceValueBrief: JdServiceValueBrief | null;
  report: ResumeAlignmentReport | null;
  serviceFitReport: ResumeServiceFitReport | null;
  positioningPlan: ResumePositioningPlan | null;
  referenceSources: Array<{
    fileName: string;
    relativePath: string;
    inferredRole: string;
    kind: "resume" | "cover" | "combined" | "unknown";
    sections: string[];
    snippets?: {
      summary?: string;
      experience?: string;
      coverLetter?: string;
    };
  }>;
}

export interface TailoredExperienceItem {
  id: string;
  bullets: string[];
  evidenceChunkIds?: string[];
  bulletTrace?: Array<{
    claimSource: string;
    digestClaimId?: string;
    bundleId?: string;
    theme?: string;
    anchorId?: string;
    matchedRequirementIds?: string[];
    evidenceChunkIds?: string[];
    claimType?: "direct" | "transferable" | "contextual";
    positioningIntent?: string;
    riskFlags?: string[];
    boundaryVerdict?: "pass" | "softened" | "dropped" | "legacy";
    boundaryReasons?: string[];
    repairGenerated?: boolean;
    fallbackGenerated?: boolean;
    densityRepairGenerated?: boolean;
    claimVerdicts?: import("./capability-bridge").ExtractedClaim[];
    repairMode?: "targeted" | "fallback" | "fallback_failed" | "none";
    repairs?: string[];
  }>;
}

export const JOB_RELEVANCE_STATUSES = [
  "high_match",
  "medium_match",
  "needs_review",
  "low_relevance",
  "non_job_page",
] as const;

export type JobRelevanceStatus = (typeof JOB_RELEVANCE_STATUSES)[number];

export const JOB_AVAILABILITY_STATUSES = [
  "available",
  "closing_soon",
  "expired",
  "filled",
  "unavailable",
  "unknown",
] as const;

export type JobAvailabilityStatus = (typeof JOB_AVAILABILITY_STATUSES)[number];

export interface AppliedDuplicateMatch {
  jobId: string;
  title: string;
  employer: string;
  appliedAt: string;
  score: number;
  titleScore: number;
  employerScore: number;
}

export interface Job {
  id: string;

  // Source / provenance
  source: JobSource;
  sourceJobId: string | null; // External ID (if provided)
  jobUrlDirect: string | null; // Source-provided direct URL (if provided)
  datePosted: string | null; // Source-provided posting date (if provided)

  // From crawler (normalized)
  title: string;
  employer: string;
  employerUrl: string | null;
  jobUrl: string; // Gradcracker listing URL
  applicationLink: string | null; // Actual application URL
  disciplines: string | null;
  deadline: string | null;
  salary: string | null;
  location: string | null;
  locationEvidence: JobLocationEvidence | null;
  locationMatch?: LocationMatchResult | null;
  degreeRequired: string | null;
  starting: string | null;
  jobDescription: string | null;

  // Orchestrator enrichments
  status: JobStatus;
  relevanceStatus: JobRelevanceStatus | null;
  relevanceReason: string | null;
  availabilityStatus: JobAvailabilityStatus | null;
  availabilityReason: string | null;
  availabilityCheckedAt: string | null;
  outcome: JobOutcome | null;
  closedAt: number | null;
  suitabilityScore: number | null; // 0-100 AI-generated score
  suitabilityReason: string | null; // AI explanation
  tailoredSummary: string | null; // Generated resume summary
  tailoredHeadline: string | null; // Generated resume headline
  tailoredSkills: string | null; // Generated resume skills (JSON)
  tailoredExperience: string | null; // Generated experience bullets (JSON)
  jdKeywordProfile: string | null; // Deterministic JD keyword profile (JSON)
  jdQualificationProfile: string | null; // Short JD qualification profile (JSON)
  jdServiceValueBrief: string | null; // JD service-value brief (JSON)
  resumeAlignmentReport: string | null; // Short generated resume alignment QA (JSON)
  resumeServiceFitReport: string | null; // Resume service-value fit QA (JSON)
  resumePositioningPlan: string | null; // Resume positioning strategy plan (JSON)
  resumeTargetPagesOverride: 1 | 2 | null; // Manual one-page/two-page selection for jobs not covered by locked policy
  selectedProjectIds: string | null; // Comma-separated IDs of selected projects
  pdfPath: string | null; // Path to generated PDF
  tracerLinksEnabled: boolean; // Rewrite outbound resume links to tracer links on next PDF generation
  sponsorMatchScore: number | null; // 0-100 fuzzy match score with visa sponsors
  sponsorMatchNames: string | null; // JSON array of matched sponsor names (when 100% matches or top match)
  appliedDuplicateMatch?: AppliedDuplicateMatch | null; // Included on detail responses and may be omitted on list responses

  // JobSpy fields (nullable for non-JobSpy sources)
  jobType: string | null;
  salarySource: string | null;
  salaryInterval: string | null;
  salaryMinAmount: number | null;
  salaryMaxAmount: number | null;
  salaryCurrency: string | null;
  isRemote: boolean | null;
  jobLevel: string | null;
  jobFunction: string | null;
  listingType: string | null;
  emails: string | null;
  companyIndustry: string | null;
  companyLogo: string | null;
  companyUrlDirect: string | null;
  companyAddresses: string | null;
  companyNumEmployees: string | null;
  companyRevenue: string | null;
  companyDescription: string | null;
  skills: string | null;
  experienceRange: string | null;
  companyRating: number | null;
  companyReviewsCount: number | null;
  vacancyCount: number | null;
  workFromHomeType: string | null;

  // Timestamps
  discoveredAt: string;
  processedAt: string | null;
  readyAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type JobListItem = Pick<
  Job,
  | "id"
  | "source"
  | "title"
  | "employer"
  | "jobUrl"
  | "applicationLink"
  | "datePosted"
  | "deadline"
  | "salary"
  | "location"
  | "status"
  | "relevanceStatus"
  | "relevanceReason"
  | "availabilityStatus"
  | "availabilityReason"
  | "availabilityCheckedAt"
  | "outcome"
  | "closedAt"
  | "suitabilityScore"
  | "sponsorMatchScore"
  | "appliedDuplicateMatch"
  | "jobType"
  | "jobFunction"
  | "salaryMinAmount"
  | "salaryMaxAmount"
  | "salaryCurrency"
  | "discoveredAt"
  | "readyAt"
  | "appliedAt"
  | "updatedAt"
> & {
  resumeAlignmentReport?: string | null;
  resumeServiceFitReport?: string | null;
};

export interface CreateJobInput {
  source: JobSource;
  title: string;
  employer: string;
  employerUrl?: string;
  jobUrl: string;
  applicationLink?: string;
  disciplines?: string;
  deadline?: string;
  salary?: string;
  location?: string;
  locationEvidence?: JobLocationEvidence;
  relevanceStatus?: JobRelevanceStatus;
  relevanceReason?: string;
  availabilityStatus?: JobAvailabilityStatus;
  availabilityReason?: string;
  availabilityCheckedAt?: string;
  degreeRequired?: string;
  starting?: string;
  jobDescription?: string;

  // JobSpy fields (optional)
  sourceJobId?: string;
  jobUrlDirect?: string;
  datePosted?: string;
  jobType?: string;
  salarySource?: string;
  salaryInterval?: string;
  salaryMinAmount?: number;
  salaryMaxAmount?: number;
  salaryCurrency?: string;
  isRemote?: boolean;
  jobLevel?: string;
  jobFunction?: string;
  listingType?: string;
  emails?: string;
  companyIndustry?: string;
  companyLogo?: string;
  companyUrlDirect?: string;
  companyAddresses?: string;
  companyNumEmployees?: string;
  companyRevenue?: string;
  companyDescription?: string;
  skills?: string;
  experienceRange?: string;
  companyRating?: number;
  companyReviewsCount?: number;
  vacancyCount?: number;
  workFromHomeType?: string;
  status?: Extract<JobStatus, "discovered" | "skipped">;
}

export interface ManualJobDraft {
  title?: string;
  employer?: string;
  jobUrl?: string;
  applicationLink?: string;
  location?: string;
  salary?: string;
  deadline?: string;
  jobDescription?: string;
  jobType?: string;
  jobLevel?: string;
  jobFunction?: string;
  disciplines?: string;
  degreeRequired?: string;
  starting?: string;
}

export interface ManualJobInferenceResponse {
  job: ManualJobDraft;
  warning?: string | null;
}

export interface ManualJobFetchResponse {
  content: string;
  url: string;
}

export interface UpdateJobInput {
  title?: string;
  employer?: string;
  jobUrl?: string;
  applicationLink?: string | null;
  location?: string | null;
  salary?: string | null;
  deadline?: string | null;
  status?: JobStatus;
  relevanceStatus?: JobRelevanceStatus | null;
  relevanceReason?: string | null;
  availabilityStatus?: JobAvailabilityStatus | null;
  availabilityReason?: string | null;
  availabilityCheckedAt?: string | null;
  outcome?: JobOutcome | null;
  closedAt?: number | null;
  jobDescription?: string | null;
  locationEvidence?: JobLocationEvidence | null;
  suitabilityScore?: number;
  suitabilityReason?: string;
  tailoredSummary?: string;
  tailoredHeadline?: string;
  tailoredSkills?: string;
  tailoredExperience?: string;
  jdKeywordProfile?: string;
  jdQualificationProfile?: string;
  jdServiceValueBrief?: string | null;
  resumeAlignmentReport?: string;
  resumeServiceFitReport?: string | null;
  resumePositioningPlan?: string;
  resumeTargetPagesOverride?: 1 | 2 | null;
  selectedProjectIds?: string;
  pdfPath?: string;
  tracerLinksEnabled?: boolean;
  readyAt?: string;
  appliedAt?: string;
  sponsorMatchScore?: number;
  sponsorMatchNames?: string;
}

export interface CreateJobNoteInput {
  title: string;
  content: string;
}

export interface UpdateJobNoteInput {
  title: string;
  content: string;
}
