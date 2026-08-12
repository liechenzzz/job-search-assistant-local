import {
  classifyJobRelevance,
  type RelevanceSourceKind,
} from "@shared/job-relevance.js";
import type { Job, JobSource } from "@shared/types";
import * as jobsRepo from "../repositories/jobs";

export interface RepairStoredJobRelevanceResult {
  checked: number;
  deleted: number;
  updated: number;
  skipped: number;
}

const ACTIVE_REPAIR_STATUSES = ["discovered", "processing", "ready"] as const;

function sourceKindFor(source: JobSource): RelevanceSourceKind {
  if (source === "ontario-public-sector") return "public-sector";
  if (source === "policyjobs-ottawa") return "curated";
  return "job-board";
}

function classifyStoredJob(job: Job) {
  return classifyJobRelevance({
    source: job.source,
    sourceKind: sourceKindFor(job.source),
    title: job.title,
    employer: job.employer,
    location: job.location,
    description: job.jobDescription,
    url: job.jobUrl ?? job.applicationLink,
    deadline: job.deadline,
    salary: job.salary,
    datePosted: job.datePosted,
    jobType: job.jobType,
  });
}

/**
 * Reclassifies active legacy rows that predate the relevance gate.
 * It is intentionally limited to rows without a stored relevance status, so it
 * does not keep rewriting user-curated jobs.
 */
export async function repairStoredJobRelevance(): Promise<RepairStoredJobRelevanceResult> {
  const jobs = await jobsRepo.getAllJobs([...ACTIVE_REPAIR_STATUSES]);
  const targets = jobs.filter((job) => job.relevanceStatus === null);
  const result: RepairStoredJobRelevanceResult = {
    checked: targets.length,
    deleted: 0,
    updated: 0,
    skipped: 0,
  };

  for (const job of targets) {
    const classification = classifyStoredJob(job);

    if (classification.status === "non_job_page") {
      if (await jobsRepo.deleteJobById(job.id)) {
        result.deleted += 1;
      }
      continue;
    }

    const nextStatus =
      classification.status === "low_relevance" && job.status !== "ready"
        ? "skipped"
        : job.status;

    const updated = await jobsRepo.updateJob(job.id, {
      relevanceStatus: classification.status,
      relevanceReason: classification.reason,
      status: nextStatus,
    });

    if (updated) {
      result.updated += 1;
      if (nextStatus === "skipped" && job.status !== "skipped") {
        result.skipped += 1;
      }
    }
  }

  return result;
}
