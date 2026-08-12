import { randomUUID } from "node:crypto";
import {
  AppError,
  badRequest,
  notFound,
  requestTimeout,
  toAppError,
} from "@infra/errors";
import { fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { processJob } from "@server/pipeline/index";
import * as jobsRepo from "@server/repositories/jobs";
import { inferManualJobDetails } from "@server/services/manualJob";
import { getProfile } from "@server/services/profile";
import { scoreJobSuitability } from "@server/services/scorer";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import {
  extractJobContentFromHtml,
  fetchRenderedJobContent,
  shouldUseRenderedJobFallback,
} from "./manual-job-fetch";

export const manualJobsRouter = Router();

const manualJobFetchSchema = z.object({
  url: z.string().trim().url().max(2000),
});

const manualJobInferenceSchema = z.object({
  jobDescription: z.string().trim().min(1).max(60000),
});

const manualJobImportSchema = z.object({
  job: z.object({
    title: z.string().trim().min(1).max(500),
    employer: z.string().trim().min(1).max(500),
    jobUrl: z.string().trim().url().max(2000).optional(),
    applicationLink: z.string().trim().url().max(2000).optional(),
    location: z.string().trim().max(200).optional(),
    salary: z.string().trim().max(200).optional(),
    deadline: z.string().trim().max(100).optional(),
    jobDescription: z.string().trim().min(1).max(40000),
    jobType: z.string().trim().max(200).optional(),
    jobLevel: z.string().trim().max(200).optional(),
    jobFunction: z.string().trim().max(200).optional(),
    disciplines: z.string().trim().max(200).optional(),
    degreeRequired: z.string().trim().max(200).optional(),
    starting: z.string().trim().max(200).optional(),
  }),
});

const cleanOptional = (value?: string | null) => {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * POST /api/manual-jobs/fetch - Fetch and extract job content from a URL
 */
manualJobsRouter.post("/fetch", async (req: Request, res: Response) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const input = manualJobFetchSchema.parse(req.body ?? {});

    const response = await fetch(input.url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      return fail(
        res,
        new AppError({
          status: 502,
          code: "UPSTREAM_ERROR",
          message: `Failed to fetch URL: ${response.status} ${response.statusText}`,
        }),
      );
    }

    const staticContent = extractJobContentFromHtml(await response.text(), "static");
    let extracted = staticContent;
    const warnings: string[] = [];
    if (shouldUseRenderedJobFallback(staticContent.content)) {
      try {
        const rendered = await fetchRenderedJobContent(input.url);
        if (rendered && rendered.textLength > staticContent.textLength * 1.25) {
          extracted = rendered;
        } else if (!rendered) {
          warnings.push("Browser-render fallback unavailable; returned static HTML extraction.");
        }
      } catch (error) {
        logger.warn("Manual JD browser-render fallback failed", {
          error,
          url: input.url,
        });
        warnings.push("Browser-render fallback failed; returned static HTML extraction.");
      }
    }

    ok(res, {
      content: extracted.content,
      url: input.url,
      extractionMethod: extracted.extractionMethod,
      warnings,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    if (error instanceof Error && error.name === "AbortError") {
      return fail(res, requestTimeout());
    }
    fail(res, toAppError(error));
  } finally {
    clearTimeout(timeout);
  }
});

/**
 * POST /api/manual-jobs/infer - Infer job details from a pasted description
 */
manualJobsRouter.post("/infer", async (req: Request, res: Response) => {
  try {
    const input = manualJobInferenceSchema.parse(req.body ?? {});
    const result = await inferManualJobDetails(input.jobDescription);

    ok(res, {
      job: result.job,
      warning: result.warning ?? null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/manual-jobs/import - Import a manually curated job into the DB
 */
manualJobsRouter.post("/import", async (req: Request, res: Response) => {
  try {
    const input = manualJobImportSchema.parse(req.body ?? {});
    const job = input.job;

    const jobUrl =
      cleanOptional(job.jobUrl) ||
      cleanOptional(job.applicationLink) ||
      `manual://${randomUUID()}`;

    const createdJob = await jobsRepo.createJob({
      source: "manual",
      title: job.title.trim(),
      employer: job.employer.trim(),
      jobUrl,
      applicationLink: cleanOptional(job.applicationLink) ?? undefined,
      location: cleanOptional(job.location) ?? undefined,
      salary: cleanOptional(job.salary) ?? undefined,
      deadline: cleanOptional(job.deadline) ?? undefined,
      jobDescription: job.jobDescription.trim(),
      jobType: cleanOptional(job.jobType) ?? undefined,
      jobLevel: cleanOptional(job.jobLevel) ?? undefined,
      jobFunction: cleanOptional(job.jobFunction) ?? undefined,
      disciplines: cleanOptional(job.disciplines) ?? undefined,
      degreeRequired: cleanOptional(job.degreeRequired) ?? undefined,
      starting: cleanOptional(job.starting) ?? undefined,
    });

    const processResult = await processJob(createdJob.id, {
      analyticsOrigin: "manual_job_create",
    });
    if (!processResult.success) {
      logger.warn("Manual job auto-processing failed", {
        jobId: createdJob.id,
        error: processResult.error ?? "Unknown error",
      });
      return fail(
        res,
        new AppError({
          status: 502,
          code: "UPSTREAM_ERROR",
          message:
            processResult.error ||
            "Imported job but failed to move it to ready automatically",
          details: { jobId: createdJob.id },
        }),
      );
    }

    const processedJob = await jobsRepo.getJobById(createdJob.id);
    if (!processedJob) {
      return fail(res, notFound("Job not found"));
    }

    // Score asynchronously so the import returns immediately.
    (async () => {
      try {
        const rawProfile = await getProfile();
        if (
          !rawProfile ||
          typeof rawProfile !== "object" ||
          Array.isArray(rawProfile)
        ) {
          throw new Error("Invalid resume profile format");
        }
        const profile = rawProfile as Record<string, unknown>;
        const { score, reason } = await scoreJobSuitability(
          processedJob,
          profile,
        );
        await jobsRepo.updateJob(processedJob.id, {
          suitabilityScore: score,
          suitabilityReason: reason,
        });
      } catch (error) {
        logger.warn("Manual job scoring failed", {
          jobId: processedJob.id,
          error,
        });
      }
    })().catch((error) => {
      logger.warn("Manual job scoring task failed to start", {
        jobId: processedJob.id,
        error,
      });
    });

    ok(res, processedJob);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(res, toAppError(error));
  }
});
