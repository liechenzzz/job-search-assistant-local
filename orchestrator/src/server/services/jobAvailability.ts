import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import { asyncPool } from "@server/utils/async-pool";
import {
  getDeadlineUrgency,
  parseDeadlineDate,
} from "@shared/job-lifecycle.js";
import type { Job, JobAvailabilityStatus } from "@shared/types";

type AvailabilityDecision = {
  status: JobAvailabilityStatus;
  reason: string;
  closeJob: boolean;
};

type AvailabilityCheckSummary = {
  checked: number;
  available: number;
  closingSoon: number;
  expired: number;
  filled: number;
  unavailable: number;
  unknown: number;
  closed: number;
};

const CHECK_CONCURRENCY = 4;
const CHECK_TIMEOUT_MS = 10_000;

const CLOSED_TEXT_PATTERN =
  /\b(?:position has been filled|job has been filled|posting has closed|posting closed|no longer accepting applications|no longer available|this job is no longer available|application deadline has passed|applications are closed)\b/i;

const APPLY_TEXT_PATTERN =
  /\b(?:apply now|apply for this job|submit application|start application|apply online|job details|posting details)\b/i;

const BLOCKED_STATUS_CODES = new Set([401, 403, 429]);
const UNAVAILABLE_STATUS_CODES = new Set([404, 410]);

export function classifyJobAvailabilityFromContent(args: {
  job: Pick<Job, "title" | "deadline">;
  content: string;
  now?: number;
}): AvailabilityDecision {
  const deadlineDecision = classifyDeadline(args.job, args.now);
  if (deadlineDecision.closeJob) return deadlineDecision;

  const normalized = args.content.replace(/\s+/g, " ").slice(0, 200_000);
  if (CLOSED_TEXT_PATTERN.test(normalized)) {
    return {
      status: "filled",
      reason:
        "Posting page says the job is closed, filled, or no longer accepting applications.",
      closeJob: true,
    };
  }

  const titleTokens = args.job.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4)
    .slice(0, 8);
  const lowerContent = normalized.toLowerCase();
  const hasTitleEvidence =
    titleTokens.length === 0 ||
    titleTokens.some((token) => lowerContent.includes(token));
  const hasApplyEvidence = APPLY_TEXT_PATTERN.test(normalized);

  if (hasTitleEvidence && hasApplyEvidence) {
    return deadlineDecision.status === "closing_soon"
      ? deadlineDecision
      : {
          status: "available",
          reason: "Posting page still contains title/apply evidence.",
          closeJob: false,
        };
  }

  return {
    status: "unknown",
    reason: "Posting page loaded, but open/closed evidence was inconclusive.",
    closeJob: false,
  };
}

export function classifyDeadline(
  job: Pick<Job, "deadline">,
  now = Date.now(),
): AvailabilityDecision {
  const urgency = getDeadlineUrgency(job, now);
  if (urgency === "expired") {
    const parsed = parseDeadlineDate(job.deadline);
    return {
      status: "expired",
      reason: parsed
        ? `Deadline passed on ${parsed.toISOString().slice(0, 10)}.`
        : "Deadline has passed.",
      closeJob: true,
    };
  }
  if (urgency === "closing_soon") {
    return {
      status: "closing_soon",
      reason: "Deadline is within 7 days.",
      closeJob: false,
    };
  }
  return {
    status: "available",
    reason:
      urgency === "closing_this_month"
        ? "Deadline is within 30 days."
        : "No expired deadline evidence.",
    closeJob: false,
  };
}

async function fetchPostingContent(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; content: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; JobOpsAvailabilityCheck/1.0; +https://localhost)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const content = await response.text().catch(() => "");
    return { status: response.status, content };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkJobAvailability(
  job: Job,
  options?: { fetchImpl?: typeof fetch; now?: number },
): Promise<AvailabilityDecision> {
  const deadlineDecision = classifyDeadline(job, options?.now);
  if (deadlineDecision.closeJob) return deadlineDecision;

  const url = job.applicationLink || job.jobUrl;
  if (!url) {
    return {
      status: deadlineDecision.status,
      reason: "No posting URL is available for recheck.",
      closeJob: false,
    };
  }

  try {
    const response = await fetchPostingContent(url, options?.fetchImpl);
    if (UNAVAILABLE_STATUS_CODES.has(response.status)) {
      return {
        status: "unavailable",
        reason: `Posting URL returned HTTP ${response.status}.`,
        closeJob: true,
      };
    }
    if (BLOCKED_STATUS_CODES.has(response.status) || response.status >= 500) {
      return {
        status: "unknown",
        reason: `Posting URL returned HTTP ${response.status}; keeping job open.`,
        closeJob: false,
      };
    }
    if (response.status >= 400) {
      return {
        status: "unknown",
        reason: `Posting URL returned HTTP ${response.status}; keeping job open.`,
        closeJob: false,
      };
    }

    const pageDecision = classifyJobAvailabilityFromContent({
      job,
      content: response.content,
      now: options?.now,
    });

    if (
      pageDecision.status === "available" &&
      deadlineDecision.status === "closing_soon"
    ) {
      return deadlineDecision;
    }

    return pageDecision;
  } catch (error) {
    return {
      status: "unknown",
      reason:
        error instanceof Error
          ? `Availability check failed: ${error.message}`
          : "Availability check failed.",
      closeJob: false,
    };
  }
}

export async function recheckJobAvailability(args?: {
  limit?: number;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<AvailabilityCheckSummary> {
  const candidates = await jobsRepo.getAvailabilityRecheckCandidates(
    args?.limit ?? 100,
  );
  const summary: AvailabilityCheckSummary = {
    checked: 0,
    available: 0,
    closingSoon: 0,
    expired: 0,
    filled: 0,
    unavailable: 0,
    unknown: 0,
    closed: 0,
  };

  await asyncPool({
    items: candidates,
    concurrency: CHECK_CONCURRENCY,
    task: async (job) => {
      const decision = await checkJobAvailability(job, {
        fetchImpl: args?.fetchImpl,
        now: args?.now,
      });
      const checkedAt = new Date(args?.now ?? Date.now()).toISOString();
      const isDeadlineExpiry = decision.status === "expired";
      const shouldClose =
        decision.closeJob &&
        (isDeadlineExpiry ||
          (job.status !== "ready" && job.status !== "applied"));
      await jobsRepo.updateJob(job.id, {
        availabilityStatus: decision.status,
        availabilityReason: decision.reason,
        availabilityCheckedAt: checkedAt,
        ...(shouldClose
          ? {
              status: "expired" as const,
              closedAt: Math.floor((args?.now ?? Date.now()) / 1000),
            }
          : {}),
      });

      summary.checked += 1;
      if (decision.status === "available") summary.available += 1;
      if (decision.status === "closing_soon") summary.closingSoon += 1;
      if (decision.status === "expired") summary.expired += 1;
      if (decision.status === "filled") summary.filled += 1;
      if (decision.status === "unavailable") summary.unavailable += 1;
      if (decision.status === "unknown") summary.unknown += 1;
      if (shouldClose) summary.closed += 1;
    },
  });

  logger.info("Availability recheck completed", summary);
  return summary;
}
