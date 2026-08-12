/**
 * Main pipeline logic - orchestrates the daily job processing flow.
 *
 * Flow:
 * 1. Run crawler to discover new jobs
 * 2. Score jobs for suitability
 * 3. Leave all jobs in "discovered" for manual processing
 */

import { join } from "node:path";
import type { AppErrorCode } from "@infra/errors";
import { logger } from "@infra/logger";
import { trackServerProductEvent } from "@infra/product-analytics";
import { runWithRequestContext } from "@infra/request-context";
import { getActiveTenantId } from "@server/tenancy/context";
import { resolveDocumentPolicy } from "@shared/document-policy.js";
import { applyDomainGateToExperience } from "@shared/jd-domain-gate.js";
import { buildJdKeywordProfile } from "@shared/jd-keyword-profile.js";
import { buildJdQualificationProfile } from "@shared/jd-qualification-profile.js";
import { createLocationIntentFromLegacyInputs } from "@shared/location-domain.js";
import { SEMANTIC_QUALIFICATION_ENGINE_VERSION } from "@shared/qualification-semantics.js";
import { buildResumeAlignmentReport } from "@shared/resume-alignment.js";
import { buildResumeCoveragePlan } from "@shared/resume-coverage-plan.js";
import type {
  Job,
  JobStatus,
  PipelineConfig,
  PipelineRunSavedDetails,
  ResumeAlignmentReport,
  ResumeProfile,
  TailoredExperienceItem,
} from "@shared/types";
import { getDataDir } from "../config/dataDir";
import * as jobsRepo from "../repositories/jobs";
import * as pipelineRepo from "../repositories/pipeline";
import * as settingsRepo from "../repositories/settings";
import { recheckJobAvailability } from "../services/jobAvailability";
import { repairStoredJobRelevance } from "../services/jobRelevanceMaintenance";
import { generateDocx, generateHtml, generatePdf } from "../services/pdf";
import { getProfile } from "../services/profile";
import { pickProjectIdsForJob } from "../services/projectSelection";
import { resolveResumeGenerationDecisionForJob } from "../services/resume-generation-decision";
import { findResumeReferenceEvidenceForQualifications } from "../services/resume-references";
import {
  extractProjectsFromProfile,
  resolveResumeProjectsSettings,
} from "../services/resumeProjects";
import {
  generateTailoring,
  RESUME_POSITIONING_GENERATOR_VERSION,
} from "../services/summary";
import {
  type PendingChallenge,
  progressHelpers,
  resetProgress,
} from "./progress";
import {
  buildPipelineRunSavedDetails,
  createPipelineRunResultSummary,
  updatePipelineRunResultSummary,
} from "./run-details";
import {
  discoverJobsStep,
  importJobsStep,
  loadProfileStep,
  notifyPipelineWebhookStep,
  processJobsStep,
  scoreJobsStep,
  selectJobsStep,
} from "./steps";

const DEFAULT_CONFIG: PipelineConfig = {
  topN: 10,
  minSuitabilityScore: 50,
  // Keep Glassdoor opt-in via source picker/settings; do not enable by default.
  sources: [
    "ontario-public-sector",
    "policyjobs-ottawa",
    "indeed",
    "linkedin",
    "hiringcafe",
  ],
  outputDir: join(getDataDir(), "pdfs"),
  enableCrawling: true,
  enableScoring: true,
  enableImporting: true,
  enableAutoTailoring: true,
};

type TenantPipelineState = {
  isRunning: boolean;
  activePipelineRunId: string | null;
  cancelRequestedAt: string | null;
  activeChallengeState: ChallengeState | null;
};

type ChallengeState = {
  challenges: Map<string, PendingChallenge>;
  /** Resolves the Promise that blocks the pipeline in `runPipeline`. */
  resolve: () => void;
};

const pipelineStateByTenant = new Map<string, TenantPipelineState>();

function getPipelineState(tenantId = getActiveTenantId()): TenantPipelineState {
  let state = pipelineStateByTenant.get(tenantId);
  if (!state) {
    state = {
      isRunning: false,
      activePipelineRunId: null,
      cancelRequestedAt: null,
      activeChallengeState: null,
    };
    pipelineStateByTenant.set(tenantId, state);
  }
  return state;
}

function parseWorkplaceTypes(
  raw: string | undefined,
): Array<"remote" | "hybrid" | "onsite"> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is "remote" | "hybrid" | "onsite" =>
        value === "remote" || value === "hybrid" || value === "onsite",
    );
  } catch {
    return [];
  }
}

async function resolveLocationIntent(
  config: Partial<PipelineConfig>,
): Promise<NonNullable<PipelineConfig["locationIntent"]>> {
  if (config.locationIntent) {
    return createLocationIntentFromLegacyInputs(config.locationIntent);
  }

  const settings = await settingsRepo.getAllSettings();
  return createLocationIntentFromLegacyInputs({
    selectedCountry: settings.jobspyCountryIndeed ?? "",
    searchCities: settings.searchCities ?? settings.jobspyLocation ?? "",
    workplaceTypes: parseWorkplaceTypes(settings.workplaceTypes),
    searchScope: settings.locationSearchScope,
    matchStrictness: settings.locationMatchStrictness,
  });
}

// ---------- Challenge pause/resume state ----------

// The pipeline async function stays alive in memory while paused — there's no
// state serialization. A server restart kills a paused pipeline, same as it
// kills a running one. This is intentional: challenges happen at most once
// per day per extractor, and the user is actively present to solve them.

/**
 * Returns the list of challenges currently blocking the pipeline, or empty if
 * the pipeline is not paused on challenges.
 */
export function getPendingChallenges(): PendingChallenge[] {
  const challengeState = getPipelineState().activeChallengeState;
  if (!challengeState) return [];
  return Array.from(challengeState.challenges.values());
}

/**
 * Mark a single challenge as resolved (called by the solve-challenge API after
 * the headed browser session succeeds).  When no challenges remain the blocked
 * pipeline Promise is resolved and discovery re-runs the affected extractors.
 */
export function resolvePipelineChallenge(extractorId: string): {
  resolved: boolean;
  remaining: number;
} {
  const state = getPipelineState();
  const challengeState = state.activeChallengeState;
  if (!challengeState) return { resolved: false, remaining: 0 };

  const deleted = challengeState.challenges.delete(extractorId);
  const remaining = challengeState.challenges.size;

  // Update progress so the UI reflects the change immediately
  progressHelpers.challengeResolved(
    Array.from(challengeState.challenges.values()),
  );

  if (remaining === 0) {
    challengeState.resolve();
  }

  return { resolved: deleted, remaining };
}

// ---------- Cancellation ----------

class PipelineCancelledError extends Error {
  constructor(message = "Pipeline cancellation requested") {
    super(message);
    this.name = "PipelineCancelledError";
  }
}

function ensureNotCancelled(tenantId = getActiveTenantId()): void {
  if (getPipelineState(tenantId).cancelRequestedAt) {
    throw new PipelineCancelledError();
  }
}

/**
 * Run the full job discovery and processing pipeline.
 */
export async function runPipeline(
  config: Partial<PipelineConfig> = {},
): Promise<{
  success: boolean;
  jobsDiscovered: number;
  jobsProcessed: number;
  error?: string;
}> {
  const tenantId = getActiveTenantId();
  const tenantState = getPipelineState(tenantId);
  if (tenantState.isRunning) {
    return {
      success: false,
      jobsDiscovered: 0,
      jobsProcessed: 0,
      error: "Pipeline is already running",
    };
  }

  tenantState.isRunning = true;
  tenantState.activePipelineRunId = "pending";
  tenantState.cancelRequestedAt = null;
  resetProgress();
  const locationIntent = await resolveLocationIntent(config);
  const mergedConfig = { ...DEFAULT_CONFIG, ...config, locationIntent };
  const configSnapshot = {
    topN: mergedConfig.topN,
    minSuitabilityScore: mergedConfig.minSuitabilityScore,
    sources: mergedConfig.sources,
    locationIntent,
  } as const;

  let savedDetails: PipelineRunSavedDetails | null = null;
  try {
    savedDetails = await buildPipelineRunSavedDetails(mergedConfig);
  } catch (error) {
    logger.warn("Failed to capture pipeline run settings snapshot", { error });
  }

  const pipelineRun = await pipelineRepo.createPipelineRun({
    configSnapshot,
    savedDetails,
  });
  tenantState.activePipelineRunId = pipelineRun.id;

  return runWithRequestContext({ pipelineRunId: pipelineRun.id }, async () => {
    const pipelineLogger = logger.child({ pipelineRunId: pipelineRun.id });
    let jobsDiscovered = 0;
    let jobsProcessed = 0;
    let resultSummary =
      savedDetails?.resultSummary ?? createPipelineRunResultSummary();
    const persistResultSummary = async (
      update: Parameters<typeof updatePipelineRunResultSummary>[1],
    ) => {
      resultSummary = updatePipelineRunResultSummary(resultSummary, update);
      await pipelineRepo.updatePipelineRun(pipelineRun.id, {
        resultSummary,
      });
    };
    pipelineLogger.info("Starting pipeline run", {
      topN: mergedConfig.topN,
      minSuitabilityScore: mergedConfig.minSuitabilityScore,
      sources: mergedConfig.sources,
      locationIntent: mergedConfig.locationIntent,
    });

    try {
      ensureNotCancelled(tenantId);
      await persistResultSummary({ stage: "started" });
      const profile = await loadProfileStep();
      await persistResultSummary({ stage: "profile_loaded" });

      ensureNotCancelled(tenantId);
      await persistResultSummary({ stage: "discovery" });
      let { discoveredJobs, sourceErrors, pendingChallenges } =
        await discoverJobsStep({
          mergedConfig,
          shouldCancel: () =>
            getPipelineState(tenantId).cancelRequestedAt !== null,
        });
      await persistResultSummary({
        stage: "discovery",
        sourceErrors,
      });

      // ---------- Challenge pause/resume ----------
      if (pendingChallenges.length > 0) {
        pipelineLogger.info("Challenges detected, pausing pipeline", {
          challenges: pendingChallenges.map((c) => ({
            extractorId: c.extractorId,
            url: c.url,
          })),
        });

        progressHelpers.challengeRequired(pendingChallenges);

        // Block until all challenges are resolved by the solve-challenge API.
        // The Promise is resolved by `resolvePipelineChallenge()`, which is
        // called from the POST /api/pipeline/solve-challenge endpoint (4d).
        // Cancellation still works: the cancel endpoint sets cancelRequestedAt,
        // and ensureNotCancelled() fires after the Promise resolves.
        const challengedSources = pendingChallenges.flatMap((c) => c.sources);

        await new Promise<void>((resolve) => {
          tenantState.activeChallengeState = {
            challenges: new Map(
              pendingChallenges.map((c) => [c.extractorId, c]),
            ),
            resolve,
          };
        });
        tenantState.activeChallengeState = null;

        ensureNotCancelled(tenantId);

        // Re-run only the extractors that had challenges
        pipelineLogger.info("Challenges resolved, re-running extractors", {
          sources: challengedSources,
        });

        const retryConfig = { ...mergedConfig, sources: challengedSources };
        const retryResult = await discoverJobsStep({
          mergedConfig: retryConfig,
          shouldCancel: () =>
            getPipelineState(tenantId).cancelRequestedAt !== null,
        });

        discoveredJobs = [...discoveredJobs, ...retryResult.discoveredJobs];
        sourceErrors = [...sourceErrors, ...retryResult.sourceErrors];
        pendingChallenges = retryResult.pendingChallenges;

        // If the retry itself hits challenges again (e.g. cookie expired
        // between solve and retry), we don't loop — just continue with whatever
        // the first run discovered.  The user will see partial results and can
        // re-run the pipeline.
        if (retryResult.pendingChallenges.length > 0) {
          pipelineLogger.warn(
            "Retry after challenge still has challenges — continuing with partial results",
            {
              retryPendingChallenges: retryResult.pendingChallenges.map(
                (c) => c.extractorId,
              ),
            },
          );
        }

        progressHelpers.crawlingComplete(discoveredJobs.length);
      }

      ensureNotCancelled(tenantId);
      const { created } = await importJobsStep({ discoveredJobs });
      jobsDiscovered = created;

      await persistResultSummary({ stage: "import" });
      await pipelineRepo.updatePipelineRun(pipelineRun.id, {
        jobsDiscovered: created,
      });

      ensureNotCancelled(tenantId);
      await repairStoredJobRelevance();

      ensureNotCancelled(tenantId);
      await recheckJobAvailability({ limit: 120 });

      ensureNotCancelled(tenantId);
      await persistResultSummary({ stage: "scoring" });
      const { unprocessedJobs, scoredJobs } = await scoreJobsStep({
        profile,
        shouldCancel: () =>
          getPipelineState(tenantId).cancelRequestedAt !== null,
      });
      await persistResultSummary({
        stage: "scoring",
        jobsScored: scoredJobs.length,
      });

      ensureNotCancelled(tenantId);
      await persistResultSummary({ stage: "selection" });
      const jobsToProcess = await selectJobsStep({
        scoredJobs,
        mergedConfig,
      });
      await persistResultSummary({
        stage: "selection",
        jobsScored: scoredJobs.length,
        jobsSelected: jobsToProcess.length,
      });

      pipelineLogger.info("Selected jobs for processing", {
        candidates: jobsToProcess.length,
      });

      await persistResultSummary({
        stage: "processing",
        jobsScored: scoredJobs.length,
        jobsSelected: jobsToProcess.length,
      });
      const { processedCount } = await processJobsStep({
        jobsToProcess,
        processJob,
        shouldCancel: () =>
          getPipelineState(tenantId).cancelRequestedAt !== null,
      });
      jobsProcessed = processedCount;

      resultSummary = updatePipelineRunResultSummary(resultSummary, {
        stage: "completed",
        jobsScored: scoredJobs.length,
        jobsSelected: jobsToProcess.length,
      });
      await pipelineRepo.updatePipelineRun(pipelineRun.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        jobsProcessed: processedCount,
        resultSummary,
      });

      progressHelpers.complete(created, processedCount);
      pipelineLogger.info("Pipeline run completed", {
        jobsDiscovered: created,
        jobsProcessed: processedCount,
      });

      await notifyPipelineWebhookStep("pipeline.completed", {
        pipelineRunId: pipelineRun.id,
        jobsDiscovered: created,
        jobsScored: unprocessedJobs.length,
        jobsProcessed: processedCount,
      });

      return {
        success: true,
        jobsDiscovered: created,
        jobsProcessed: processedCount,
      };
    } catch (error) {
      if (error instanceof PipelineCancelledError) {
        const message = "Cancelled by user request";
        await pipelineRepo.updatePipelineRun(pipelineRun.id, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          jobsDiscovered,
          jobsProcessed,
          errorMessage: message,
          resultSummary,
        });
        progressHelpers.cancelled(message);
        pipelineLogger.info("Pipeline run cancelled", {
          jobsDiscovered,
          jobsProcessed,
        });
        return {
          success: false,
          jobsDiscovered,
          jobsProcessed,
          error: message,
        };
      }

      const message = error instanceof Error ? error.message : "Unknown error";

      await pipelineRepo.updatePipelineRun(pipelineRun.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: message,
        resultSummary,
      });

      progressHelpers.failed(message);
      pipelineLogger.error("Pipeline run failed", error);

      await notifyPipelineWebhookStep("pipeline.failed", {
        pipelineRunId: pipelineRun.id,
        error: message,
      });

      return {
        success: false,
        jobsDiscovered,
        jobsProcessed,
        error: message,
      };
    } finally {
      tenantState.isRunning = false;
      tenantState.activePipelineRunId = null;
      tenantState.cancelRequestedAt = null;
      tenantState.activeChallengeState = null;
    }
  });
}

export type ProcessJobOptions = {
  force?: boolean;
  requestOrigin?: string | null;
  analyticsOrigin?:
    | "move_to_ready"
    | "generate_pdf"
    | "pipeline"
    | "manual_job_create";
  skipSummarization?: boolean;
};

function parseResumeAlignmentReport(
  raw: string | null,
): ResumeAlignmentReport | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ResumeAlignmentReport>;
    if (
      !parsed ||
      typeof parsed.score !== "number" ||
      (parsed.status !== "pass" &&
        parsed.status !== "warning" &&
        parsed.status !== "failed")
    ) {
      return null;
    }
    return {
      engineVersion:
        typeof parsed.engineVersion === "string"
          ? parsed.engineVersion
          : undefined,
      score: Math.max(0, Math.min(100, Math.round(parsed.score))),
      status: parsed.status,
      missingRequired: Array.isArray(parsed.missingRequired)
        ? parsed.missingRequired
            .filter((item): item is string => typeof item === "string")
            .slice(0, 5)
        : [],
      partialRequired: Array.isArray(parsed.partialRequired)
        ? parsed.partialRequired
            .filter((item): item is string => typeof item === "string")
            .slice(0, 5)
        : [],
      matchedSections:
        parsed.matchedSections && typeof parsed.matchedSections === "object"
          ? (parsed.matchedSections as Record<string, number>)
          : {},
      referenceUsed: Array.isArray(parsed.referenceUsed)
        ? parsed.referenceUsed
            .filter((item): item is string => typeof item === "string")
            .slice(0, 5)
        : [],
      humanInputNeeded: Array.isArray(parsed.humanInputNeeded)
        ? parsed.humanInputNeeded
            .filter((item): item is string => typeof item === "string")
            .slice(0, 5)
        : [],
      repairableRequired: Array.isArray(parsed.repairableRequired)
        ? parsed.repairableRequired
            .filter((item): item is string => typeof item === "string")
            .slice(0, 5)
        : [],
      autoRewriteApplied:
        typeof parsed.autoRewriteApplied === "boolean"
          ? parsed.autoRewriteApplied
          : undefined,
      wordingGapsAfterAutoRewrite: Array.isArray(
        parsed.wordingGapsAfterAutoRewrite,
      )
        ? parsed.wordingGapsAfterAutoRewrite
            .filter((item): item is string => typeof item === "string")
            .slice(0, 5)
        : [],
      evidenceFit:
        parsed.evidenceFit && typeof parsed.evidenceFit === "object"
          ? parsed.evidenceFit
          : undefined,
      alignmentSource:
        parsed.alignmentSource === "ai_calibrated"
          ? "ai_calibrated"
          : "deterministic",
    };
  } catch {
    return null;
  }
}

function needsAlignmentRepair(job: Job): boolean {
  const report = parseResumeAlignmentReport(job.resumeAlignmentReport);
  if (!report) return true;
  if (report.engineVersion !== SEMANTIC_QUALIFICATION_ENGINE_VERSION)
    return true;
  return report.status !== "pass" || report.score < 90;
}

function hasCurrentAlignmentReport(raw: string | null): boolean {
  const report = parseResumeAlignmentReport(raw);
  return report?.engineVersion === SEMANTIC_QUALIFICATION_ENGINE_VERSION;
}

function hasCurrentPositioningPlan(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { generatorVersion?: unknown } | null;
    return parsed?.generatorVersion === RESUME_POSITIONING_GENERATOR_VERSION;
  } catch {
    return false;
  }
}

/**
 * Step 1: Generate AI summary and suggest projects.
 */
export async function summarizeJob(
  jobId: string,
  options?: ProcessJobOptions,
): Promise<{
  success: boolean;
  error?: string;
}> {
  return runWithRequestContext({ jobId }, async () => {
    const jobLogger = logger.child({ jobId });
    jobLogger.info("Summarizing job");
    try {
      const job = await jobsRepo.getJobById(jobId);
      if (!job) return { success: false, error: "Job not found" };

      const profile = await getProfile();

      // 1. Generate Summary & Tailoring
      let tailoredSummary = job.tailoredSummary;
      let tailoredHeadline = job.tailoredHeadline;
      let tailoredSkills = job.tailoredSkills;
      let tailoredExperience = job.tailoredExperience;
      let jdKeywordProfile = job.jdKeywordProfile;
      let jdQualificationProfile = job.jdQualificationProfile;
      let jdServiceValueBrief = job.jdServiceValueBrief;
      let resumeAlignmentReport = job.resumeAlignmentReport;
      let resumeServiceFitReport = job.resumeServiceFitReport;
      let resumePositioningPlan = job.resumePositioningPlan;

      if (
        !tailoredSummary ||
        !tailoredHeadline ||
        !tailoredSkills ||
        !tailoredExperience ||
        !jdKeywordProfile ||
        !jdQualificationProfile ||
        !jdServiceValueBrief ||
        !resumeAlignmentReport ||
        !resumeServiceFitReport ||
        !resumePositioningPlan ||
        !hasCurrentAlignmentReport(resumeAlignmentReport) ||
        !hasCurrentPositioningPlan(resumePositioningPlan) ||
        options?.force
      ) {
        jobLogger.info("Generating tailoring content");
        const tailoringResult = await generateTailoring(
          job.jobDescription || "",
          profile,
          {
            source: job.source,
            jobTitle: job.title,
            employer: job.employer,
            jobUrl: job.jobUrl,
            applicationLink: job.applicationLink,
            location: job.location,
            resumeTargetPagesOverride: job.resumeTargetPagesOverride,
          },
        );
        if (tailoringResult.success && tailoringResult.data) {
          tailoredSummary = tailoringResult.data.summary;
          tailoredHeadline = tailoringResult.data.headline;
          tailoredSkills = JSON.stringify(tailoringResult.data.skills);
          tailoredExperience = JSON.stringify(tailoringResult.data.experience);
          jdKeywordProfile = JSON.stringify(
            tailoringResult.data.jdKeywordProfile,
          );
          jdQualificationProfile = JSON.stringify(
            tailoringResult.data.jdQualificationProfile,
          );
          jdServiceValueBrief = tailoringResult.data.jdServiceValueBrief
            ? JSON.stringify(tailoringResult.data.jdServiceValueBrief)
            : null;
          resumeAlignmentReport = JSON.stringify(
            tailoringResult.data.resumeAlignmentReport,
          );
          resumeServiceFitReport = tailoringResult.data.resumeServiceFitReport
            ? JSON.stringify(tailoringResult.data.resumeServiceFitReport)
            : null;
          resumePositioningPlan = tailoringResult.data.resumePositioningPlan
            ? JSON.stringify(tailoringResult.data.resumePositioningPlan)
            : null;
        } else if (
          options?.force ||
          !tailoredSummary ||
          !tailoredHeadline ||
          !tailoredExperience ||
          !jdKeywordProfile ||
          !jdQualificationProfile ||
          !resumeAlignmentReport
        ) {
          return {
            success: false,
            error: `Tailoring failed: ${tailoringResult.error || "unknown error"}`,
          };
        }
      }

      // 2. Suggest Projects
      let selectedProjectIds = job.selectedProjectIds;
      if (!selectedProjectIds || options?.force) {
        jobLogger.info("Selecting projects");
        try {
          const { catalog, selectionItems } =
            extractProjectsFromProfile(profile);
          const overrideResumeProjectsRaw =
            await settingsRepo.getSetting("resumeProjects");
          const { resumeProjects } = resolveResumeProjectsSettings({
            catalog,
            overrideRaw: overrideResumeProjectsRaw,
          });

          const locked = resumeProjects.lockedProjectIds;
          const documentPolicy = resolveDocumentPolicy({
            source: job.source,
            title: job.title,
            employer: job.employer,
            jobDescription: job.jobDescription,
            jobUrl: job.jobUrl,
            applicationLink: job.applicationLink,
            location: job.location,
            resumeTargetPagesOverride: job.resumeTargetPagesOverride,
          });
          const maxProjectsForPolicy =
            documentPolicy.resumeTargetPages === 1
              ? Math.min(resumeProjects.maxProjects, 1)
              : resumeProjects.maxProjects;
          const desiredCount = Math.max(
            0,
            maxProjectsForPolicy - locked.length,
          );
          const eligibleSet = new Set(resumeProjects.aiSelectableProjectIds);
          const eligibleProjects = selectionItems.filter((p) =>
            eligibleSet.has(p.id),
          );

          const picked = await pickProjectIdsForJob({
            jobDescription: job.jobDescription || "",
            eligibleProjects,
            desiredCount,
            qualificationProfile: jdQualificationProfile
              ? JSON.parse(jdQualificationProfile)
              : undefined,
          });

          selectedProjectIds = [...locked, ...picked].join(",");
        } catch (error) {
          jobLogger.warn("Failed to suggest projects", error);
        }
      }

      await jobsRepo.updateJob(job.id, {
        tailoredSummary: tailoredSummary ?? undefined,
        tailoredHeadline: tailoredHeadline ?? undefined,
        tailoredSkills: tailoredSkills ?? undefined,
        tailoredExperience: tailoredExperience ?? undefined,
        jdKeywordProfile: jdKeywordProfile ?? undefined,
        jdQualificationProfile: jdQualificationProfile ?? undefined,
        jdServiceValueBrief: jdServiceValueBrief ?? undefined,
        resumeAlignmentReport: resumeAlignmentReport ?? undefined,
        resumeServiceFitReport: resumeServiceFitReport ?? undefined,
        resumePositioningPlan: resumePositioningPlan ?? undefined,
        selectedProjectIds: selectedProjectIds ?? undefined,
      });

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      jobLogger.error("Summarization failed", error);
      return { success: false, error: message };
    }
  });
}

/**
 * Step 2: Generate PDF using current summary and project selection.
 */
export async function generateFinalPdf(
  jobId: string,
  options?: ProcessJobOptions,
): Promise<{
  success: boolean;
  error?: string;
  errorCode?: AppErrorCode;
}> {
  return runWithRequestContext({ jobId }, async () => {
    const jobLogger = logger.child({ jobId });
    jobLogger.info("Generating final PDF");
    let jobStatusToRestore: JobStatus | null = null;
    try {
      const job = await jobsRepo.getJobById(jobId);
      if (!job) return { success: false, error: "Job not found" };
      jobStatusToRestore = job.status;

      // Ensure AI content exists unless the caller already summarised. Ready-job
      // PDF regeneration should preserve the current draft unless the final
      // domain gate triggers the targeted repair pass below.
      if (!options?.skipSummarization) {
        jobLogger.info("Ensuring AI content before PDF generation");
        const sumResult = await summarizeJob(jobId, {
          force: false,
          requestOrigin: options?.requestOrigin ?? null,
          analyticsOrigin: options?.analyticsOrigin ?? "generate_pdf",
        });
        if (!sumResult.success) {
          jobLogger.warn(
            "AI content regeneration failed, falling back to existing content with fresh domain gate",
            { error: sumResult.error },
          );
        }
      }

      // Re-read the job to pick up freshly stored tailoring (or keep existing
      // if summarisation was skipped or failed).
      let updatedJob = await jobsRepo.getJobById(jobId);
      if (!updatedJob) return { success: false, error: "Job not found" };

      if (needsAlignmentRepair(updatedJob)) {
        jobLogger.info(
          "Stored resume alignment is low; running forced JD repair before materials generation",
          {
            alignment: parseResumeAlignmentReport(
              updatedJob.resumeAlignmentReport,
            ),
          },
        );
        const repairSummary = await summarizeJob(jobId, {
          force: true,
          requestOrigin: options?.requestOrigin ?? null,
          analyticsOrigin: options?.analyticsOrigin ?? "generate_pdf",
        });
        if (repairSummary.success) {
          updatedJob = await jobsRepo.getJobById(jobId);
          if (!updatedJob) return { success: false, error: "Job not found" };
        } else {
          jobLogger.warn(
            "Forced JD alignment repair failed before materials generation",
            {
              error: repairSummary.error,
            },
          );
        }
      }

      // Ready jobs already have a usable PDF; keep them visible while regenerating.
      if (updatedJob.status !== "ready") {
        await jobsRepo.updateJob(updatedJob.id, { status: "processing" });
      }

      // Keep the existing draft available for a possible one-pass repair.
      const rawExperience: TailoredExperienceItem[] =
        updatedJob.tailoredExperience
          ? JSON.parse(updatedJob.tailoredExperience)
          : [];

      const resumeDecision = await resolveResumeGenerationDecisionForJob(
        updatedJob,
        { includeEvidenceReferences: true },
      );
      const documentPolicy = resolveDocumentPolicy({
        source: updatedJob.source,
        title: updatedJob.title,
        employer: updatedJob.employer,
        jobDescription: updatedJob.jobDescription,
        jobUrl: updatedJob.jobUrl,
        applicationLink: updatedJob.applicationLink,
        location: updatedJob.location,
        resumeTargetPagesOverride: updatedJob.resumeTargetPagesOverride,
      });
      const pdfOptions = {
        tracerLinksEnabled: updatedJob.tracerLinksEnabled,
        requestOrigin: options?.requestOrigin ?? null,
        tracerCompanyName: updatedJob.employer ?? null,
        jobTitle: updatedJob.title,
        jobEmployer: updatedJob.employer,
        resumeTargetPages: resumeDecision.targetPages,
        resumeDecision,
      } as const;
      const profileForPdfFallback = await getProfile();
      const buildTailoredPdfContent = (jobForContent: Job) => {
        const profileForContent = buildJdKeywordProfile({
          title: jobForContent.title,
          employer: jobForContent.employer,
          jobDescription: jobForContent.jobDescription || "",
        });
        const raw: TailoredExperienceItem[] = jobForContent.tailoredExperience
          ? JSON.parse(jobForContent.tailoredExperience)
          : [];
        const gated = applyDomainGateToExperience(raw, profileForContent);
        const experience = fillEmptyExperienceBulletsFromProfile(
          gated.experience,
          profileForPdfFallback,
        );
        return {
          content: {
            summary: jobForContent.tailoredSummary || "",
            headline: jobForContent.tailoredHeadline || "",
            skills: jobForContent.tailoredSkills
              ? JSON.parse(jobForContent.tailoredSkills)
              : [],
            experience,
            jdKeywordProfile: profileForContent,
          },
          gatedExperience: experience,
        };
      };

      const initialContent = buildTailoredPdfContent(updatedJob);
      let finalJob = updatedJob;
      let finalGatedExperience = initialContent.gatedExperience;
      const materialWarnings: string[] = [];
      let pdfResult = await generatePdf(
        updatedJob.id,
        initialContent.content,
        updatedJob.jobDescription || "",
        undefined, // deprecated baseResumePath parameter
        updatedJob.selectedProjectIds,
        pdfOptions,
      );

      if (!pdfResult.success && pdfResult.domainGateResiduals?.length) {
        jobLogger.warn(
          "PDF domain gate blocked draft; running one repair pass",
          {
            residuals: pdfResult.domainGateResiduals,
          },
        );
        const profile = await getProfile();
        const repairResult = await generateTailoring(
          updatedJob.jobDescription || "",
          profile,
          {
            source: updatedJob.source,
            jobTitle: updatedJob.title,
            employer: updatedJob.employer,
            jobUrl: updatedJob.jobUrl,
            applicationLink: updatedJob.applicationLink,
            location: updatedJob.location,
            resumeTargetPagesOverride: updatedJob.resumeTargetPagesOverride,
            repair: {
              reason: "domain_gate_residuals",
              residuals: pdfResult.domainGateResiduals,
              previousDraft: {
                headline: updatedJob.tailoredHeadline,
                summary: updatedJob.tailoredSummary,
                skills: updatedJob.tailoredSkills
                  ? JSON.parse(updatedJob.tailoredSkills)
                  : [],
                experience: rawExperience,
              },
            },
          },
        );

        if (repairResult.success && repairResult.data) {
          const repairedJob = await jobsRepo.updateJob(updatedJob.id, {
            tailoredSummary: repairResult.data.summary,
            tailoredHeadline: repairResult.data.headline,
            tailoredSkills: JSON.stringify(repairResult.data.skills),
            tailoredExperience: JSON.stringify(repairResult.data.experience),
            jdKeywordProfile: JSON.stringify(
              repairResult.data.jdKeywordProfile,
            ),
            jdQualificationProfile: JSON.stringify(
              repairResult.data.jdQualificationProfile,
            ),
            jdServiceValueBrief: repairResult.data.jdServiceValueBrief
              ? JSON.stringify(repairResult.data.jdServiceValueBrief)
              : undefined,
            resumeAlignmentReport: JSON.stringify(
              repairResult.data.resumeAlignmentReport,
            ),
            resumeServiceFitReport: repairResult.data.resumeServiceFitReport
              ? JSON.stringify(repairResult.data.resumeServiceFitReport)
              : undefined,
            resumePositioningPlan: repairResult.data.resumePositioningPlan
              ? JSON.stringify(repairResult.data.resumePositioningPlan)
              : undefined,
          });
          if (repairedJob) {
            finalJob = repairedJob;
            const repairedContent = buildTailoredPdfContent(repairedJob);
            finalGatedExperience = repairedContent.gatedExperience;
            pdfResult = await generatePdf(
              repairedJob.id,
              repairedContent.content,
              repairedJob.jobDescription || "",
              undefined,
              repairedJob.selectedProjectIds,
              pdfOptions,
            );
          }
        } else {
          jobLogger.warn("PDF domain gate repair pass failed", {
            error: repairResult.error,
          });
        }
      }

      if (!pdfResult.success) {
        const residualMessage = pdfResult.domainGateResiduals?.length
          ? ` Residual locations: ${pdfResult.domainGateResiduals
              .slice(0, 5)
              .map((item) => `${item.path} (${item.term})`)
              .join("; ")}.`
          : "";
        materialWarnings.push(
          `Optional PDF generation failed; Word and HTML materials remain available.${
            pdfResult.error ? ` ${pdfResult.error}` : ""
          }${residualMessage}`,
        );
      }

      const finalContent = buildTailoredPdfContent(finalJob);
      finalGatedExperience = finalContent.gatedExperience;
      const [docxResult, htmlResult] = await Promise.all([
        generateDocx(
          finalJob.id,
          finalContent.content,
          finalJob.jobDescription || "",
          finalJob.selectedProjectIds,
          pdfOptions,
        ),
        generateHtml(
          finalJob.id,
          finalContent.content,
          finalJob.jobDescription || "",
          finalJob.selectedProjectIds,
          pdfOptions,
        ),
      ]);

      if (!docxResult.success || !htmlResult.success) {
        await jobsRepo.updateJob(updatedJob.id, { status: updatedJob.status });
        const failures = [
          !docxResult.success
            ? `Word failed: ${docxResult.error ?? "unknown error"}`
            : null,
          !htmlResult.success
            ? `HTML failed: ${htmlResult.error ?? "unknown error"}`
            : null,
        ]
          .filter(Boolean)
          .join(" ");
        return {
          success: false,
          error: `Resume materials generation failed. ${failures}`,
          errorCode: docxResult.errorCode ?? htmlResult.errorCode,
        };
      }

      await jobsRepo.updateJob(finalJob.id, {
        status: "ready",
        pdfPath: pdfResult.success
          ? pdfResult.pdfPath
          : (finalJob.pdfPath ?? updatedJob.pdfPath ?? undefined),
        jdKeywordProfile: JSON.stringify(finalContent.content.jdKeywordProfile),
        jdQualificationProfile: JSON.stringify(
          buildJdQualificationProfile({
            title: finalJob.title,
            employer: finalJob.employer,
            jobDescription: finalJob.jobDescription || "",
          }),
        ),
        resumeAlignmentReport:
          finalJob.resumeAlignmentReport ??
          JSON.stringify(
            await buildPdfFallbackAlignmentReport({
              job: finalJob,
              profile: await getProfile(),
              gatedExperience: finalGatedExperience,
            }),
          ),
      });

      const analyticsOrigin = options?.analyticsOrigin ?? "move_to_ready";
      const generationKind =
        updatedJob.status === "ready" ? "regenerate" : "initial";
      void trackServerProductEvent(
        "resume_generated",
        {
          origin: analyticsOrigin,
          generation_kind: generationKind,
          tracer_links_enabled: updatedJob.tracerLinksEnabled,
          has_tailored_summary: Boolean(updatedJob.tailoredSummary),
          has_tailored_skills: Boolean(updatedJob.tailoredSkills),
          pdf_generated: pdfResult.success,
          materials_generated: true,
        },
        {
          requestOrigin: options?.requestOrigin ?? null,
          urlPath: "/jobs",
        },
      );

      if (updatedJob.status !== "ready") {
        void trackServerProductEvent(
          "job_moved_to_ready",
          {
            origin: analyticsOrigin,
            tracer_links_enabled: updatedJob.tracerLinksEnabled,
          },
          {
            requestOrigin: options?.requestOrigin ?? null,
            urlPath: "/jobs",
          },
        );
      }

      if (materialWarnings.length > 0) {
        jobLogger.warn(
          "Resume materials generated with optional PDF warnings",
          {
            warnings: materialWarnings,
          },
        );
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (jobStatusToRestore) {
        try {
          await jobsRepo.updateJob(jobId, { status: jobStatusToRestore });
        } catch (restoreError) {
          jobLogger.warn("Failed to restore job status after PDF error", {
            restoreStatus: jobStatusToRestore,
            error: restoreError,
          });
        }
      }
      jobLogger.error("PDF generation failed", error);
      return { success: false, error: message };
    }
  });
}

/**
 * Process a single job (runs both steps in sequence).
 */
export async function processJob(
  jobId: string,
  options?: ProcessJobOptions,
): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    // Step 1: Summarize & Select Projects
    const sumResult = await summarizeJob(jobId, options);
    if (!sumResult.success) return sumResult;

    // Step 2: Generate PDF (skip summarization since we just ran it)
    const pdfResult = await generateFinalPdf(jobId, {
      ...options,
      skipSummarization: true,
    });
    return pdfResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: message };
  }
}

/**
 * Check if pipeline is currently running.
 */
export function getPipelineStatus(): { isRunning: boolean } {
  return { isRunning: getPipelineState().isRunning };
}

function fillEmptyExperienceBulletsFromProfile(
  experience: TailoredExperienceItem[],
  profile: ResumeProfile,
): TailoredExperienceItem[] {
  const fallbackById = new Map(
    profile.sections?.experience?.items
      ?.filter((item) => {
        const record = item as typeof item & { hidden?: boolean };
        return item.visible !== false && record.hidden !== true;
      })
      .map((item) => {
        const record = item as typeof item & { description?: string };
        return [
          item.id,
          extractFallbackExperienceBullets(
            stripHtml(
              [item.summary, record.description].filter(Boolean).join("\n"),
            ),
          ),
        ] as const;
      }) ?? [],
  );

  return experience
    .map((item) => {
      const bullets = item.bullets
        .map((bullet) => bullet.trim())
        .filter(Boolean);
      return {
        ...item,
        bullets:
          bullets.length > 0 ? bullets : (fallbackById.get(item.id) ?? []),
      };
    })
    .filter((item) => item.bullets.length > 0);
}

function extractFallbackExperienceBullets(sourceText: string): string[] {
  const bulletLike = sourceText
    .split(/(?:\n|â€¢|\u2022|- |\* )/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 24);
  if (bulletLike.length > 0) return bulletLike.slice(0, 6);

  return sourceText
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 24)
    .slice(0, 6);
}

async function buildPdfFallbackAlignmentReport(args: {
  job: Job;
  profile: ResumeProfile;
  gatedExperience: TailoredExperienceItem[];
}) {
  const qualificationProfile = buildJdQualificationProfile({
    title: args.job.title,
    employer: args.job.employer,
    jobDescription: args.job.jobDescription || "",
  });
  const referenceItems = await findResumeReferenceEvidenceForQualifications({
    qualificationProfile,
    maxItems: 5,
  });
  const experienceById = new Map(
    args.gatedExperience.map((item) => [item.id, item.bullets.join(" ")]),
  );
  const experienceText =
    args.profile.sections?.experience?.items
      ?.map((item) => {
        const record = item as typeof item & { description?: string };
        return (
          experienceById.get(item.id) ??
          [item.summary, record.description].filter(Boolean).join(" ")
        );
      })
      .join(" ") ?? "";
  const selectedIds = new Set(
    (args.job.selectedProjectIds ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const projectText = (args.profile.sections?.projects?.items ?? [])
    .filter((item) => selectedIds.size === 0 || selectedIds.has(item.id))
    .map((item) =>
      [item.name, item.description, item.summary, item.keywords?.join(" ")]
        .filter(Boolean)
        .join(" "),
    )
    .join(" ");
  const sections = args.profile.sections as Record<string, unknown> | undefined;

  const resumeSections = {
    summary: args.job.tailoredSummary ?? "",
    skills: parseTailoredSkillsText(args.job.tailoredSkills),
    experience: stripHtml(experienceText),
    education: stripHtml(JSON.stringify(sections?.education ?? "")),
    projects: stripHtml(projectText),
  };
  const coveragePlan = buildResumeCoveragePlan({
    qualificationProfile,
    resumeSections,
    referenceItems,
  });

  return buildResumeAlignmentReport({
    qualificationProfile,
    resumeSections,
    referenceItems,
    coveragePlan,
  });
}

function parseTailoredSkillsText(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return "";
    return parsed
      .map((group) => {
        if (!group || typeof group !== "object") return "";
        const record = group as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : "";
        const keywords = Array.isArray(record.keywords)
          ? record.keywords.filter(
              (item): item is string => typeof item === "string",
            )
          : [];
        return [name, keywords.join(" ")].filter(Boolean).join(": ");
      })
      .join("\n");
  } catch {
    return "";
  }
}

function stripHtml(text: string): string {
  return text
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

export function requestPipelineCancel(): {
  accepted: boolean;
  pipelineRunId: string | null;
  alreadyRequested: boolean;
} {
  const state = getPipelineState();
  if (!state.isRunning) {
    return { accepted: false, pipelineRunId: null, alreadyRequested: false };
  }

  const pipelineRunId =
    state.activePipelineRunId && state.activePipelineRunId !== "pending"
      ? state.activePipelineRunId
      : null;

  if (state.cancelRequestedAt) {
    return {
      accepted: true,
      pipelineRunId,
      alreadyRequested: true,
    };
  }

  state.cancelRequestedAt = new Date().toISOString();

  // Unblock the challenge pause if the pipeline is waiting for human solving.
  // Without this, cancellation during challenge_required would leave the
  // pipeline stuck until challenges are solved or the server restarts.
  // ensureNotCancelled() runs immediately after the paused Promise resolves.
  if (state.activeChallengeState) {
    state.activeChallengeState.resolve();
    state.activeChallengeState = null;
  }

  return {
    accepted: true,
    pipelineRunId,
    alreadyRequested: false,
  };
}

export function isPipelineCancelRequested(): boolean {
  return getPipelineState().cancelRequestedAt !== null;
}
