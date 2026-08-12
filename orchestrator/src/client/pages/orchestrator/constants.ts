import {
  EXTRACTOR_SOURCE_IDS,
  EXTRACTOR_SOURCE_METADATA,
  PIPELINE_EXTRACTOR_SOURCE_IDS,
} from "@shared/extractors";
import type { JobSource, JobStatus } from "@shared/types";

export const DEFAULT_PIPELINE_SOURCES: JobSource[] = [
  "ontario-public-sector",
  "policyjobs-ottawa",
  "indeed",
  "linkedin",
  "hiringcafe",
];
export const PIPELINE_SOURCES_STORAGE_KEY = "jobops.pipeline.sources";

export const orderedSources: JobSource[] = [
  ...PIPELINE_EXTRACTOR_SOURCE_IDS,
].sort(
  (left, right) =>
    EXTRACTOR_SOURCE_METADATA[left].order -
    EXTRACTOR_SOURCE_METADATA[right].order,
);
export const orderedFilterSources: JobSource[] = [...EXTRACTOR_SOURCE_IDS].sort(
  (left, right) =>
    EXTRACTOR_SOURCE_METADATA[left].order -
    EXTRACTOR_SOURCE_METADATA[right].order,
);

export const statusTokens: Record<
  JobStatus,
  { label: string; badge: string; dot: string }
> = {
  discovered: {
    label: "Discovered",
    badge: "border-sky-500/30 bg-sky-500/10 text-sky-200",
    dot: "bg-sky-400",
  },
  processing: {
    label: "Processing",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    dot: "bg-amber-400",
  },
  ready: {
    label: "Ready",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    dot: "bg-emerald-400",
  },
  applied: {
    label: "Applied",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    dot: "bg-emerald-400",
  },
  in_progress: {
    label: "In Progress",
    badge: "border-cyan-500/30 bg-cyan-500/10 text-cyan-200",
    dot: "bg-cyan-400",
  },
  skipped: {
    label: "Skipped",
    badge: "border-rose-500/30 bg-rose-500/10 text-rose-200",
    dot: "bg-rose-400",
  },
  expired: {
    label: "Expired",
    badge: "border-muted-foreground/20 bg-muted/30 text-muted-foreground",
    dot: "bg-muted-foreground",
  },
};

export const defaultStatusToken = {
  label: "Unknown",
  badge: "border-muted-foreground/20 bg-muted/30 text-muted-foreground",
  dot: "bg-muted-foreground",
};

export const appliedDuplicateIndicator = {
  label: "Previously Applied",
  dot: "bg-yellow-400",
};

export type FilterTab = "ready" | "discovered" | "applied" | "archived" | "all";
export type DateFilterPreset = "7" | "14" | "30" | "90" | "custom";
export type DateFilterDimension = "ready" | "applied" | "closed" | "discovered";
export type DiscoveryAgeFilter =
  | "action_queue"
  | "fresh_7"
  | "recent_14"
  | "aging_24"
  | "stale_30"
  | "older_30"
  | "all";

export type SortKey =
  | "date"
  | "discoveredAt"
  | "score"
  | "salary"
  | "title"
  | "employer";
export type SortDirection = "asc" | "desc";
export type SponsorFilter =
  | "all"
  | "confirmed"
  | "potential"
  | "not_found"
  | "unknown";
export type SalaryFilterMode = "at_least" | "at_most" | "between";

export interface SalaryFilter {
  mode: SalaryFilterMode;
  min: number | null;
  max: number | null;
}

export interface JobSort {
  key: SortKey;
  direction: SortDirection;
  datePriority?: DateFilterDimension[];
}

export interface JobDateFilter {
  dimensions: DateFilterDimension[];
  startDate: string | null;
  endDate: string | null;
  preset: DateFilterPreset | null;
}

export const DEFAULT_SORT: JobSort = { key: "score", direction: "desc" };
export const DEFAULT_DISCOVERY_AGE_FILTER: DiscoveryAgeFilter = "action_queue";
export const DEFAULT_DATE_FILTER: JobDateFilter = {
  dimensions: [],
  startDate: null,
  endDate: null,
  preset: null,
};

export const sortLabels: Record<JobSort["key"], string> = {
  date: "Date",
  discoveredAt: "Discovered",
  score: "Score",
  salary: "Salary",
  title: "Title",
  employer: "Company",
};

export const defaultSortDirection: Record<JobSort["key"], SortDirection> = {
  date: "desc",
  discoveredAt: "desc",
  score: "desc",
  salary: "desc",
  title: "asc",
  employer: "asc",
};

export const tabs: Array<{
  id: FilterTab;
  label: string;
  statuses: JobStatus[];
}> = [
  { id: "ready", label: "Ready", statuses: ["ready"] },
  {
    id: "discovered",
    label: "Discovered",
    statuses: ["discovered", "processing"],
  },
  { id: "applied", label: "Applied", statuses: ["applied"] },
  { id: "archived", label: "Archived", statuses: ["expired", "skipped"] },
  { id: "all", label: "All Jobs", statuses: [] },
];

export const emptyStateCopy: Record<FilterTab, string> = {
  ready: "Run the pipeline to discover and process new jobs.",
  discovered: "All discovered jobs have been processed.",
  applied: "You have not applied to any jobs yet.",
  archived: "No expired or skipped jobs yet.",
  all: "No jobs in the system yet. Run the pipeline to get started.",
};

export const dateFilterDimensionLabels: Record<DateFilterDimension, string> = {
  ready: "Ready",
  applied: "Applied",
  closed: "Closed",
  discovered: "Discovered",
};

export const dateFilterDimensionOrder: DateFilterDimension[] = [
  "ready",
  "applied",
  "closed",
  "discovered",
];

export const discoveryAgeFilterLabels: Record<DiscoveryAgeFilter, string> = {
  action_queue: "Action queue",
  fresh_7: "0-7 days",
  recent_14: "8-14 days",
  aging_24: "15-24 days",
  stale_30: "25-30 days",
  older_30: "30+ days",
  all: "All backlog",
};

export const discoveryAgeFilterOrder: DiscoveryAgeFilter[] = [
  "action_queue",
  "fresh_7",
  "recent_14",
  "aging_24",
  "stale_30",
  "older_30",
  "all",
];

export const DISCOVERY_ACTION_QUEUE_LIMIT = 200;
