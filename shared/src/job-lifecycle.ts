import type { JobListItem } from "./types/jobs";

export type DiscoveryAgeTier =
  | "fresh_7"
  | "recent_14"
  | "aging_24"
  | "stale_30"
  | "older_30"
  | "unknown";

export type DeadlineUrgency =
  | "closing_soon"
  | "closing_this_month"
  | "future"
  | "expired"
  | "unknown";

const DAY_MS = 24 * 60 * 60 * 1000;

export function getDiscoveryAgeDays(
  job: Pick<JobListItem, "discoveredAt">,
  now = Date.now(),
): number | null {
  const discoveredAt = Date.parse(job.discoveredAt);
  if (!Number.isFinite(discoveredAt)) return null;
  return Math.max(0, Math.floor((now - discoveredAt) / DAY_MS));
}

export function getDiscoveryAgeTier(
  job: Pick<JobListItem, "discoveredAt">,
  now = Date.now(),
): DiscoveryAgeTier {
  const ageDays = getDiscoveryAgeDays(job, now);
  if (ageDays == null) return "unknown";
  if (ageDays <= 7) return "fresh_7";
  if (ageDays <= 14) return "recent_14";
  if (ageDays <= 24) return "aging_24";
  if (ageDays <= 30) return "stale_30";
  return "older_30";
}

const MONTH_MAP: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function makeDate(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseDeadlineDate(
  deadline: string | null | undefined,
): Date | null {
  if (!deadline) return null;
  const trimmed = deadline.trim();
  if (!trimmed) return null;

  // "27-May-2026 to 10-Jun-2026" or "27 May 2026 - 10 Jun 2026" → end date
  const rangeMatch = trimmed.match(
    /(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{4})\s+(?:to|[-–])\s+(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{4})/i,
  );
  if (rangeMatch) {
    const endMonth = MONTH_MAP[rangeMatch[5].toLowerCase()];
    if (endMonth !== undefined) {
      return makeDate(Number(rangeMatch[6]), endMonth, Number(rangeMatch[4]));
    }
  }

  // "December 31, 2026 at 11:59 pm" or "Tuesday, June 2, 2026 at 11:59 pm"
  const proseMatch = trimmed.match(
    /(?:[A-Za-z]{3,9}\s+)?([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/i,
  );
  if (proseMatch) {
    const month = MONTH_MAP[proseMatch[1].toLowerCase()];
    if (month !== undefined) {
      return makeDate(Number(proseMatch[3]), month, Number(proseMatch[2]));
    }
  }

  // ISO: YYYY-MM-DD
  const isoMatch = trimmed.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    return makeDate(
      Number(isoMatch[1]),
      Number(isoMatch[2]) - 1,
      Number(isoMatch[3]),
    );
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function getDeadlineUrgency(
  job: Pick<JobListItem, "deadline">,
  now = Date.now(),
): DeadlineUrgency {
  const deadline = parseDeadlineDate(job.deadline);
  if (!deadline) return "unknown";

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const daysUntil = Math.floor((deadline.getTime() - today.getTime()) / DAY_MS);

  if (daysUntil < 0) return "expired";
  if (daysUntil <= 7) return "closing_soon";
  if (daysUntil <= 30) return "closing_this_month";
  return "future";
}

export function isDiscoveryActionQueueCandidate(
  job: Pick<
    JobListItem,
    | "deadline"
    | "discoveredAt"
    | "relevanceStatus"
    | "availabilityStatus"
    | "status"
  >,
  now = Date.now(),
): boolean {
  if (job.status === "processing") return true;
  if (job.status !== "discovered") return false;

  if (
    job.availabilityStatus === "expired" ||
    job.availabilityStatus === "filled" ||
    job.availabilityStatus === "unavailable"
  ) {
    return false;
  }

  const urgency = getDeadlineUrgency(job, now);
  if (urgency === "expired") return false;
  if (urgency === "closing_soon") return true;

  const ageTier = getDiscoveryAgeTier(job, now);
  if (ageTier === "fresh_7" || ageTier === "recent_14") {
    return (
      job.relevanceStatus === "high_match" ||
      job.relevanceStatus === "medium_match" ||
      job.relevanceStatus === "needs_review"
    );
  }

  if (ageTier === "aging_24") {
    return (
      job.relevanceStatus === "high_match" || urgency === "closing_this_month"
    );
  }

  return (
    job.relevanceStatus === "high_match" && urgency === "closing_this_month"
  );
}
