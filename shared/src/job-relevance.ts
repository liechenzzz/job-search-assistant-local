import type { JobRelevanceStatus, JobSource } from "./types/jobs";

export type RelevanceSourceKind = "public-sector" | "job-board" | "curated";

export interface ClassifyJobRelevanceInput {
  source: JobSource;
  sourceKind: RelevanceSourceKind;
  title: string;
  description?: string | null;
  url?: string | null;
  employer?: string | null;
  deadline?: string | null;
  salary?: string | null;
  location?: string | null;
  datePosted?: string | null;
  jobType?: string | null;
  searchTerms?: readonly string[];
}

export interface JobRelevanceClassification {
  status: JobRelevanceStatus;
  reason: string;
}

const HIGH_TITLE_PATTERNS = [
  /\bpolicy\b/i,
  /\bresearch\b/i,
  /\bdata\b/i,
  /\banalyst\b/i,
  /\badvisor\b/i,
  /\bevaluation\b/i,
  /\bperformance\b/i,
  /\beconomic development\b/i,
  /\b(?:strategy|strategic)\b/i,
  /\bplanning\b/i,
  /\bbusiness analyst\b/i,
  /\bmarket intelligence\b/i,
  /\bintelligence analyst\b/i,
];

const MEDIUM_TITLE_PATTERNS = [
  /\bproject manager\b/i,
  /\bprogram manager\b/i,
  /\bprogram advisor\b/i,
  /\bcoordinator\b/i,
  /\bmanager\b/i,
  /\bplanner\b/i,
  /\bconsultation\b/i,
  /\bbusiness transformation\b/i,
  /\bdigital products?\b/i,
  /\bproduct owner\b/i,
];

const GENERIC_MEDIUM_TITLE_PATTERNS = [/^project manager$/i, /^manager$/i];

const MEDIUM_TITLE_QUALIFIER_PATTERNS = [
  /\bpolicy\b/i,
  /\bdata\b/i,
  /\banalytics?\b/i,
  /\b(?:strategy|strategic)\b/i,
  /\bplanning\b/i,
  /\bconsultation\b/i,
  /\bbusiness transformation\b/i,
  /\bdigital products?\b/i,
  /\beconomic development\b/i,
];

const DESCRIPTION_RELEVANCE_PATTERNS = [
  /\bpolicy\b/i,
  /\bresearch\b/i,
  /\bdata analysis\b/i,
  /\banalytics?\b/i,
  /\bdashboard(?:s)?\b/i,
  /\bevaluation\b/i,
  /\bperformance measurement\b/i,
  /\bstrategic planning\b/i,
  /\bbusiness analysis\b/i,
  /\bpublic consultation\b/i,
  /\beconomic development\b/i,
  /\bdigital products?\b/i,
  /\bbusiness transformation\b/i,
  /\bchange management\b/i,
  /\bstatistical\b/i,
  /\breporting\b/i,
];

const LOW_VALUE_TITLE_PATTERNS = [
  /\brecreation\b/i,
  /\bcamp\b/i,
  /\barborist\b/i,
  /\bforestry\b/i,
  /\busher\b/i,
  /\blabou?r(?:er)?\b/i,
  /\boperator\b/i,
  /\bdriver\b/i,
  /\bcrossing guard\b/i,
  /\bfirefighter\b/i,
  /\bparamedic\b/i,
  /\bmechanic\b/i,
  /\bfacility attendant\b/i,
  /\battendant\b/i,
  /\bclerk\b/i,
  /\bcashier\b/i,
  /\blifeguard\b/i,
  /\bcook\b/i,
  /\btrainer\b/i,
  /\banimal control\b/i,
];

const GENERIC_PAGE_TITLE_PATTERNS = [
  /^careers?$/i,
  /^jobs?$/i,
  /^employment$/i,
  /^bamboohr$/i,
  /\bjob opportunities\b/i,
  /\bcurrent opportunities\b/i,
  /\bjobs at\b/i,
  /\bcareer opportunities\b/i,
  /\bhiring process\b/i,
  /\bhow to apply\b/i,
  /\bbenefits\b/i,
  /\bjob alerts?\b/i,
  /\bvolunteering?\b/i,
  /\bstudent jobs?\b/i,
  /\bmybenefits\b/i,
  /\binternationally trained professionals\b/i,
];

const NON_POSTING_URL_PATTERNS = [
  /\/(?:career|careers|employment|jobs?|search)\/?$/i,
  /(?:how-to-apply|hiring-process|benefits|job-alert|job-alerts)/i,
  /(?:volunteer|volunteering|student|students|internship|co-op|summer)/i,
  /(?:accessibility|accommodation|privacy|terms|faq|contact-us)/i,
  /\/(?:people-programs|financial-stability-supports|ontario-works)\//i,
  /\/careers\/internationally-trained-professionals\/?$/i,
];

const BROAD_SEARCH_TERMS = new Set([
  "policy",
  "data",
  "analyst",
  "analysis",
  "research",
  "strategy",
  "strategic",
  "planning",
  "program",
  "project",
  "manager",
]);

const POSTING_ID_PATTERN =
  /\b(?:job|posting|requisition|req\.?|competition)(?![a-z])\s*(?:id|number|#|no\.?)?\s*:?\s*[A-Z0-9-]{4,}\b/i;
const POSTING_CONTEXT_PATTERN =
  /\b(?:application deadline|closing date|job details|position summary|job posting|job opening|current opening|vacancy|requisition)\b/i;
const PUBLIC_SECTOR_POSTING_URL_PATTERNS = [
  /preview\.aspx\?jobid=/i,
  /\/job\/.+\/\d+\/?$/i,
  /\/jobsatcity\/job\/.+\/\d+\/?$/i,
  /\/careers\/\d+(?:[/?#]|$)/i,
  /\/careers\/[^/?#]+-\d+(?:-[a-z]{2})?(?:[/?#]|$)/i,
  /\/jobdetail\.ftl\?/i,
  /\/recruitment\/.+jobid=/i,
  /\/recruitment\/.+jobId=/,
  /hiringplatform\.ca\/\d+-/i,
  /[?&](?:jobid|job_id|job|requisitionid|reqid|postingid|gh_jid)=\w+/i,
  /myworkdayjobs\.com\/.+\/job\//i,
];

function normalizedTitle(title: string): string {
  return title
    .replace(/\s+\|\s+.*$/i, "")
    .replace(/\s+-\s+.*$/i, "")
    .trim();
}

function countMatches(value: string, patterns: RegExp[]): number {
  return patterns.filter((pattern) => pattern.test(value)).length;
}

function hasAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function hasGenericMediumTitle(title: string): boolean {
  return hasAny(normalizedTitle(title), GENERIC_MEDIUM_TITLE_PATTERNS);
}

function searchTermHit(input: ClassifyJobRelevanceInput): boolean {
  const combined = `${input.title} ${input.description ?? ""}`.toLowerCase();
  return (input.searchTerms ?? []).some((term) => {
    const normalized = term.trim().toLowerCase();
    if (normalized.length < 4) return false;
    if (BROAD_SEARCH_TERMS.has(normalized)) return false;
    return combined.includes(normalized);
  });
}

function hasPublicSectorPostingEvidence(
  input: ClassifyJobRelevanceInput,
): boolean {
  const url = input.url ?? "";
  const description = input.description ?? "";
  const text = `${url}\n${description}`;

  if (POSTING_ID_PATTERN.test(text)) return true;
  if (PUBLIC_SECTOR_POSTING_URL_PATTERNS.some((pattern) => pattern.test(url))) {
    return true;
  }
  if (/\bjob details\b/i.test(description) && /\/job\//i.test(url)) {
    return true;
  }

  if (
    (Boolean(input.deadline) || Boolean(input.datePosted)) &&
    POSTING_CONTEXT_PATTERN.test(description)
  ) {
    return true;
  }

  return false;
}

function publicSectorNonJobPage(input: ClassifyJobRelevanceInput): boolean {
  const title = normalizedTitle(input.title);
  const url = input.url;
  const hasEvidence = hasPublicSectorPostingEvidence(input);

  if (!hasEvidence) return true;

  if (hasAny(title, GENERIC_PAGE_TITLE_PATTERNS) && !hasEvidence) return true;
  if (url && NON_POSTING_URL_PATTERNS.some((p) => p.test(url))) {
    return !hasEvidence;
  }
  return false;
}

export function classifyJobRelevance(
  input: ClassifyJobRelevanceInput,
): JobRelevanceClassification {
  const title = input.title.trim();
  const description = input.description ?? "";

  if (input.sourceKind === "public-sector" && publicSectorNonJobPage(input)) {
    return {
      status: "non_job_page",
      reason:
        "Public-sector page looks like a career/search/info shell, not a posting.",
    };
  }

  if (hasAny(title, LOW_VALUE_TITLE_PATTERNS)) {
    return {
      status: "low_relevance",
      reason: "Title matches an operational/frontline role pattern.",
    };
  }

  if (hasAny(title, HIGH_TITLE_PATTERNS)) {
    return {
      status: "high_match",
      reason: "Title has a strong policy/data/research signal.",
    };
  }

  const mediumTitle = hasAny(title, MEDIUM_TITLE_PATTERNS);
  const descriptionScore = countMatches(
    description,
    DESCRIPTION_RELEVANCE_PATTERNS,
  );
  const genericMedium = hasGenericMediumTitle(title);

  if (
    genericMedium &&
    !hasAny(title, MEDIUM_TITLE_QUALIFIER_PATTERNS) &&
    descriptionScore < 4
  ) {
    return {
      status:
        input.sourceKind === "job-board" ? "needs_review" : "low_relevance",
      reason:
        "Generic manager/project title lacks enough policy/data evidence.",
    };
  }

  if (mediumTitle && descriptionScore >= (genericMedium ? 4 : 2)) {
    return {
      status: "medium_match",
      reason: "Title is adjacent and description has policy/data evidence.",
    };
  }

  if (searchTermHit(input) && (mediumTitle || descriptionScore >= 2)) {
    return {
      status: "medium_match",
      reason: "Search term and local evidence both support relevance.",
    };
  }

  if (descriptionScore >= 3) {
    return {
      status: "medium_match",
      reason: "Description has several policy/data/research signals.",
    };
  }

  if (
    input.sourceKind === "curated" ||
    input.source === "policyjobs-ottawa" ||
    input.sourceKind === "job-board"
  ) {
    return {
      status: "needs_review",
      reason: "Source is plausible but local evidence is incomplete.",
    };
  }

  return {
    status: "low_relevance",
    reason: "No strong policy/data evidence found in title or description.",
  };
}
