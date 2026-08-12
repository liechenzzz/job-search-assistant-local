import { createHash } from "node:crypto";
import type { ExtractorSourceId } from "@shared/extractors";
import { classifyJobRelevance } from "@shared/job-relevance.js";
import type { CreateJobInput } from "@shared/types/jobs";

export type OntarioPublicSectorProgressEvent =
  | {
      type: "source_start";
      sourceIndex: number;
      sourceTotal: number;
      sourceName: string;
    }
  | {
      type: "source_complete";
      sourceIndex: number;
      sourceTotal: number;
      sourceName: string;
      jobsFoundSource: number;
    };

export interface RunOntarioPublicSectorOptions {
  searchTerms?: string[];
  maxJobs?: number;
  selectedSources?: readonly string[];
  fetchImpl?: typeof fetch;
  onProgress?: (event: OntarioPublicSectorProgressEvent) => void;
  shouldCancel?: () => boolean;
}

export interface OntarioPublicSectorResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
}

type PublicSectorSource = {
  id: string;
  sourceId: ExtractorSourceId;
  kind: "careers-page" | "substack-feed";
  mode: "direct-postings" | "curated-feed" | "discovery-only";
  platform?:
    | "generic"
    | "bamboohr"
    | "barrie-embedded"
    | "icims"
    | "successfactors"
    | "taleo"
    | "adp-workforcenow"
    | "talentpoolbuilder"
    | "pdf-posting";
  employer: string;
  url: string;
  locationHint: string;
  hostAllowlist: string[];
  postingUrlPatterns?: RegExp[];
};

type LinkCandidate = {
  url: string;
  text: string;
  applicationUrl?: string;
  descriptionText?: string;
  datePosted?: string;
  editionTitle?: string;
  editionUrl?: string;
};

const SOURCES: PublicSectorSource[] = [
  {
    id: "ops",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    employer: "Ontario Public Service",
    url: "https://www.gojobs.gov.on.ca/Search.aspx?SearchCommand=Next",
    locationHint: "Ontario",
    hostAllowlist: ["gojobs.gov.on.ca"],
    postingUrlPatterns: [/\/Preview\.aspx\?JobID=\d+/i],
  },
  {
    id: "city-toronto",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    employer: "City of Toronto",
    url: "https://jobs.toronto.ca/jobsatcity/search/",
    locationHint: "Toronto, ON",
    hostAllowlist: ["jobs.toronto.ca"],
    postingUrlPatterns: [/\/job\//i, /jobId=\d+/i],
  },
  {
    id: "peel-region",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    employer: "Region of Peel",
    url: "https://peelregion.ca/about/careers",
    locationHint: "Peel Region, ON",
    hostAllowlist: ["peelregion.ca", "jobs.peelregion.ca"],
    postingUrlPatterns: [/jobs\.peelregion\.ca\/job\//i, /\/job\//i],
  },
  {
    id: "york-region",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    employer: "York Region",
    url: "https://www.york.ca/york-region/careers/career-york-region",
    locationHint: "York Region, ON",
    hostAllowlist: ["york.ca", "jobs.york.ca"],
    postingUrlPatterns: [/jobs\.york\.ca\/job\//i, /\/job\//i],
  },
  {
    id: "durham-region",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    employer: "Durham Region",
    url: "https://www.durham.ca/en/regional-government/job-postings.aspx",
    locationHint: "Durham Region, ON",
    hostAllowlist: ["durham.ca"],
    postingUrlPatterns: [/job-postings\/.*\d+/i, /JobID=\d+/i],
  },
  {
    id: "halton-region",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    employer: "Halton Region",
    url: "https://careers.halton.ca/",
    locationHint: "Halton Region, ON",
    hostAllowlist: ["careers.halton.ca", "halton.ca"],
    postingUrlPatterns: [/careers\.halton\.ca\/job\//i, /\/job\//i],
  },
  {
    id: "hamilton",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    platform: "bamboohr",
    employer: "City of Hamilton",
    url: "https://cityofhamilton.bamboohr.com/careers",
    locationHint: "Hamilton, ON",
    hostAllowlist: ["cityofhamilton.bamboohr.com"],
    postingUrlPatterns: [/cityofhamilton\.bamboohr\.com\/careers\/\d+\/?$/i],
  },
  {
    id: "barrie",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    platform: "barrie-embedded",
    employer: "City of Barrie",
    url: "https://careers.barrie.ca/search/",
    locationHint: "Barrie, ON",
    hostAllowlist: ["careers.barrie.ca", "barrie.hiringplatform.ca"],
    postingUrlPatterns: [/careers\.barrie\.ca\/[^/?#]+-CA-\d+-en\/?$/i],
  },
  {
    id: "guelph",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    platform: "icims",
    employer: "City of Guelph",
    url: "https://careers-guelph.icims.com/jobs/intro",
    locationHint: "Guelph, ON",
    hostAllowlist: ["careers-guelph.icims.com"],
    postingUrlPatterns: [/careers-guelph\.icims\.com\/jobs\/\d+\//i],
  },
  {
    id: "kitchener",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    platform: "successfactors",
    employer: "City of Kitchener",
    url: "https://jobs.kitchener.ca/",
    locationHint: "Kitchener, ON",
    hostAllowlist: ["jobs.kitchener.ca"],
    postingUrlPatterns: [/jobs\.kitchener\.ca\/job\//i],
  },
  {
    id: "waterloo",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "discovery-only",
    platform: "talentpoolbuilder",
    employer: "City of Waterloo",
    url: "https://www.waterloo.ca/en/government/employment-and-volunteering.aspx",
    locationHint: "Waterloo, ON",
    hostAllowlist: ["waterloo.ca", "cityofwaterloo.talentpoolbuilder.com"],
  },
  {
    id: "mississauga",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    employer: "City of Mississauga",
    url: "https://jobs.mississauga.ca/",
    locationHint: "Mississauga, ON",
    hostAllowlist: ["jobs.mississauga.ca", "mississauga.ca"],
    postingUrlPatterns: [/jobs\.mississauga\.ca\/job\//i, /\/job\//i],
  },
  {
    id: "brampton",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    employer: "City of Brampton",
    url: "https://careers.brampton.ca/",
    locationHint: "Brampton, ON",
    hostAllowlist: ["careers.brampton.ca", "brampton.ca"],
    postingUrlPatterns: [/careers\.brampton\.ca\/job\//i, /\/job\//i],
  },
  {
    id: "markham",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "discovery-only",
    platform: "adp-workforcenow",
    employer: "City of Markham",
    url: "https://www.markham.ca/about-city-markham/employment/view-jobs-and-apply-now",
    locationHint: "Markham, ON",
    hostAllowlist: ["markham.ca", "workforcenow.adp.com"],
  },
  {
    id: "vaughan",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "discovery-only",
    employer: "City of Vaughan",
    url: "https://www.vaughan.ca/about-city-vaughan/careers",
    locationHint: "Vaughan, ON",
    hostAllowlist: ["vaughan.ca"],
  },
  {
    id: "richmond-hill",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    platform: "successfactors",
    employer: "City of Richmond Hill",
    url: "https://jobs.richmondhill.ca/go/View-All/2572817/",
    locationHint: "Richmond Hill, ON",
    hostAllowlist: ["jobs.richmondhill.ca"],
    postingUrlPatterns: [/jobs\.richmondhill\.ca\/job\//i],
  },
  {
    id: "oakville",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "direct-postings",
    platform: "taleo",
    employer: "Town of Oakville",
    url: "https://tre.tbe.taleo.net/tre01/ats/careers/v2/jobSearch?act=redirectCwsV2&cws=43&org=TOWNOFOA",
    locationHint: "Oakville, ON",
    hostAllowlist: ["tre.tbe.taleo.net"],
    postingUrlPatterns: [
      /tre\.tbe\.taleo\.net\/tre01\/ats\/careers\/v2\/viewRequisition/i,
    ],
  },
  {
    id: "burlington",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "discovery-only",
    platform: "pdf-posting",
    employer: "City of Burlington",
    url: "https://www.burlington.ca/en/council-and-city-administration/careers.aspx",
    locationHint: "Burlington, ON",
    hostAllowlist: ["burlington.ca"],
  },
  {
    id: "oshawa",
    sourceId: "ontario-public-sector",
    kind: "careers-page",
    mode: "discovery-only",
    employer: "City of Oshawa",
    url: "https://www.oshawa.ca/en/city-hall/careers.aspx",
    locationHint: "Oshawa, ON",
    hostAllowlist: ["oshawa.ca"],
  },
  {
    id: "policyjobs-ottawa",
    sourceId: "policyjobs-ottawa",
    kind: "substack-feed",
    mode: "curated-feed",
    employer: "PolicyJobsOTT",
    url: "https://policyjobsott.substack.com/feed",
    locationHint: "Ottawa, ON",
    hostAllowlist: ["policyjobsott.substack.com"],
  },
];

const POLICYJOBS_OTT_EDITION_LIMIT = 4;

const STRONG_TITLE_PATTERNS = [
  /\bpolicy\b/i,
  /\bresearch\b/i,
  /\bdata\b/i,
  /\banalyst\b/i,
  /\badvisor\b/i,
  /\bevaluation\b/i,
  /\bperformance\b/i,
  /\beconomic development\b/i,
  /\bstrategy|strategic\b/i,
  /\bplanning\b/i,
  /\bbusiness analyst\b/i,
  /\bmarket intelligence\b/i,
];

const LOW_VALUE_TITLE_PATTERNS = [
  /\brecreation\b/i,
  /\bcamp\b/i,
  /\barborist\b/i,
  /\bforestry\b/i,
  /\busher\b/i,
  /\blabou?r(er)?\b/i,
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
];

const NON_POSTING_URL_PATTERNS = [
  /\/(?:career|careers|employment|jobs?)\/?$/i,
  /(?:how-to-apply|hiring-process|benefits|job-alert|job-alerts)/i,
  /(?:volunteer|volunteering|student|students|internship|co-op|summer)/i,
  /(?:accessibility|accommodation|privacy|terms|faq|contact-us)/i,
];

const GENERIC_PAGE_TITLE_PATTERNS = [
  /^careers?$/i,
  /^jobs?$/i,
  /^employment$/i,
  /\bjob opportunities\b/i,
  /\bjobs at\b/i,
  /\bcareer opportunities\b/i,
  /\bhiring process\b/i,
  /\bhow to apply\b/i,
  /\bbenefits\b/i,
  /\bjob alerts?\b/i,
  /\bvolunteering?\b/i,
  /\bstudent jobs?\b/i,
];

const POSTING_ID_PATTERN =
  /\b(?:job|posting|requisition|req\.?|competition)(?![a-z])\s*(?:id|number|#|no\.?)?\s*:?\s*[A-Z0-9-]{4,}\b/i;

const APPLY_SIGNAL_PATTERN =
  /\b(?:apply now|apply online|submit your application|application deadline)\b/i;

const FIELD_PATTERNS: Array<
  [
    keyof Pick<
      CreateJobInput,
      "deadline" | "salary" | "location" | "datePosted" | "jobType"
    >,
    RegExp,
  ]
> = [
  [
    "deadline",
    /\b(?:application deadline|closing date|posting period|closing|apply by)\b\s*:?\s*([^\n\r]{4,120})/i,
  ],
  [
    "salary",
    /\b(?:salary range|salary|hourly rate|wage|compensation)\b\s*:?\s*([^\n\r]{4,160})/i,
  ],
  [
    "location",
    /\b(?:work location|location|workplace)\b\s*:\s*([^\n\r]{3,160})/i,
  ],
  [
    "datePosted",
    /\b(?:posted|posting date|date posted)\b\s*:?\s*([^\n\r]{4,100})/i,
  ],
  [
    "jobType",
    /\b(?:job type|job type & duration|employment type|duration)\b\s*:?\s*([^\n\r]{4,160})/i,
  ],
];

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 10)),
    );
}

function normalizeWhitespace(value: string): string {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n+\s*/g, "\n")
    .trim();
}

function extractTitle(html: string, fallback: string): string {
  const candidates = [
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1],
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    )?.[1],
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
    fallback,
  ];

  for (const candidate of candidates) {
    const title = normalizeWhitespace(stripTags(candidate ?? ""));
    if (title) {
      return title
        .replace(/\s+\|\s+.*$/i, "")
        .replace(/\s+-\s+job details.*$/i, "")
        .trim();
    }
  }

  return "Unknown Title";
}

function isAllowedHost(url: URL, source: PublicSectorSource): boolean {
  return source.hostAllowlist.some(
    (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
  );
}

function extractLinks(html: string, baseUrl: string): LinkCandidate[] {
  const links: LinkCandidate[] = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match = anchorPattern.exec(html);
  while (match) {
    const href = match[1];
    if (href && !href.startsWith("#") && !href.startsWith("mailto:")) {
      try {
        const url = new URL(decodeHtml(href), baseUrl);
        links.push({
          url: url.href,
          text: normalizeWhitespace(stripTags(match[2] ?? "")),
        });
      } catch {
        // Ignore malformed hrefs.
      }
    }
    match = anchorPattern.exec(html);
  }
  return links;
}

function decodeSerializedString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\r?\n/g, "\\n")}"`);
  } catch {
    return decodeHtml(value)
      .replace(/\\"/g, '"')
      .replace(/\\\//g, "/")
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .trim();
  }
}

function extractSerializedField(
  block: string,
  key: string,
): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `"${escapedKey}"\\s*:\\s*\\[\\s*0\\s*,\\s*"((?:\\\\.|[^"\\\\])*)"\\s*\\]`,
    "i",
  );
  const value = block.match(pattern)?.[1];
  return value ? decodeSerializedString(value) : undefined;
}

function collectBarrieEmbeddedCandidates(
  html: string,
  source: PublicSectorSource,
): LinkCandidate[] {
  const decodedHtml = decodeHtml(html);
  const pathPattern = /"path"\s*:\s*\[\s*0\s*,\s*"((?:\\.|[^"\\])*)"\s*\]/gi;
  const pathMatches = [...decodedHtml.matchAll(pathPattern)];
  const candidates: LinkCandidate[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < pathMatches.length; index += 1) {
    const match = pathMatches[index];
    if (match.index === undefined) continue;

    const blockEnd =
      pathMatches[index + 1]?.index === undefined
        ? decodedHtml.length
        : pathMatches[index + 1].index;
    const block = decodedHtml.slice(match.index, blockEnd);
    const path = decodeSerializedString(match[1] ?? "");
    if (!/-CA-\d+-en\/?$/i.test(path)) continue;

    const title = normalizeWhitespace(
      extractSerializedField(block, "title") ?? "",
    );
    const descriptionHtml = extractSerializedField(block, "description") ?? "";
    if (!title || !descriptionHtml) continue;

    const url = new URL(path, source.url).href;
    if (seen.has(url)) continue;
    seen.add(url);

    const applicationUrl = normalizeWhitespace(
      extractSerializedField(block, "applicationFormUrl") ??
        extractSerializedField(block, "url") ??
        "",
    );
    candidates.push({
      url,
      text: title,
      applicationUrl: applicationUrl || undefined,
      descriptionText: descriptionHtml,
      datePosted: extractSerializedField(block, "postingDate"),
    });
  }

  return candidates;
}

function uniqueCandidates(candidates: LinkCandidate[]): LinkCandidate[] {
  const seen = new Set<string>();
  const unique: LinkCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }
  return unique;
}

function collectDirectLinkCandidates(
  html: string,
  source: PublicSectorSource,
): LinkCandidate[] {
  return uniqueCandidates(
    extractLinks(html, source.url).filter((link) =>
      isPotentialJobLink(link, source),
    ),
  );
}

function isSuccessFactorsCategoryLink(
  link: LinkCandidate,
  source: PublicSectorSource,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(link.url);
  } catch {
    return false;
  }
  return (
    isAllowedHost(parsed, source) &&
    /\/go\/[^/?#]+\/\d+\/?$/i.test(parsed.pathname)
  );
}

async function collectSuccessFactorsCandidates(
  html: string,
  source: PublicSectorSource,
  fetchImpl: typeof fetch,
): Promise<LinkCandidate[]> {
  const directCandidates = collectDirectLinkCandidates(html, source);
  if (directCandidates.length > 0) return directCandidates;

  const categoryLinks = uniqueCandidates(
    extractLinks(html, source.url).filter((link) =>
      isSuccessFactorsCategoryLink(link, source),
    ),
  ).slice(0, 12);
  const candidates: LinkCandidate[] = [];
  for (const categoryLink of categoryLinks) {
    const categoryHtml = await fetchText(categoryLink.url, fetchImpl);
    candidates.push(...collectDirectLinkCandidates(categoryHtml, source));
  }
  return uniqueCandidates(candidates);
}

function isPotentialJobLink(
  link: LinkCandidate,
  source: PublicSectorSource,
): boolean {
  if (source.mode !== "direct-postings") return false;

  let parsed: URL;
  try {
    parsed = new URL(link.url);
  } catch {
    return false;
  }
  if (!isAllowedHost(parsed, source)) return false;

  const haystack =
    `${link.text} ${parsed.pathname} ${parsed.search}`.toLowerCase();
  if (NON_POSTING_URL_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return false;
  }

  if (source.postingUrlPatterns?.some((pattern) => pattern.test(link.url))) {
    return true;
  }

  if (/preview\.aspx\?jobid=/i.test(link.url)) return true;
  if (/\/job\/.+\/\d+\/?$/i.test(parsed.pathname)) return true;
  if (/[?&](?:jobid|job_id|requisitionid|reqid|postingid)=\w+/i.test(link.url))
    return true;

  return false;
}

function titleLooksRelevant(title: string): boolean {
  const hasStrongSignal = STRONG_TITLE_PATTERNS.some((pattern) =>
    pattern.test(title),
  );
  const hasLowValueSignal = LOW_VALUE_TITLE_PATTERNS.some((pattern) =>
    pattern.test(title),
  );
  return hasStrongSignal && !hasLowValueSignal;
}

function hasGenericPageTitle(title: string): boolean {
  const normalized = title
    .replace(/\s+\|\s+.*$/i, "")
    .replace(/\s+-\s+.*$/i, "")
    .trim();
  return GENERIC_PAGE_TITLE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function hasPostingUrlSignal(url: string, source: PublicSectorSource): boolean {
  if (source.postingUrlPatterns?.some((pattern) => pattern.test(url))) {
    return true;
  }
  return (
    /preview\.aspx\?jobid=/i.test(url) ||
    /\/job\/.+\/\d+\/?$/i.test(new URL(url).pathname) ||
    /[?&](?:jobid|job_id|requisitionid|reqid|postingid)=\w+/i.test(url)
  );
}

function hasJobPostingEvidence(args: {
  source: PublicSectorSource;
  url: string;
  title: string;
  text: string;
  deadline?: string;
  salary?: string;
  location?: string;
  datePosted?: string;
  jobType?: string;
}): boolean {
  if (args.source.kind === "substack-feed") return true;
  if (hasGenericPageTitle(args.title)) return false;

  let score = 0;
  if (hasPostingUrlSignal(args.url, args.source)) score += 2;
  if (titleLooksRelevant(args.title)) score += 2;
  if (args.deadline) score += 2;
  if (args.salary) score += 1;
  if (args.location) score += 1;
  if (args.datePosted) score += 1;
  if (POSTING_ID_PATTERN.test(`${args.url}\n${args.text}`)) score += 2;
  if (APPLY_SIGNAL_PATTERN.test(args.text)) score += 1;

  return score >= 4;
}

function extractField(
  text: string,
  field: keyof Pick<
    CreateJobInput,
    "deadline" | "salary" | "location" | "datePosted" | "jobType"
  >,
): string | undefined {
  const pattern = FIELD_PATTERNS.find(([key]) => key === field)?.[1];
  if (!pattern) return undefined;
  const value = text.match(pattern)?.[1];
  if (!value) return undefined;
  return normalizeWhitespace(value)
    .replace(/\s{2,}/g, " ")
    .slice(0, 220);
}

function sourceJobIdFromUrl(url: string, sourceId: string): string {
  const parsed = new URL(url);
  const jobId =
    parsed.searchParams.get("JobID") ??
    parsed.pathname.split("/").filter(Boolean).at(-1);
  return `${sourceId}:${jobId || parsed.href}`;
}

function sourceJobIdFromNewsletterJob(
  sourceId: string,
  url: string,
  title: string,
): string {
  const digest = createHash("sha1")
    .update(`${url}|${title}`)
    .digest("hex")
    .slice(0, 12);
  return `${sourceId}:${digest}`;
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; JobOps Ontario Public Sector Extractor)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function extractTagValue(xml: string, tagName: string): string | undefined {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`,
    "i",
  );
  const value = xml.match(pattern)?.[1];
  if (!value) return undefined;
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)?.[1];
  return decodeHtml(cdata ?? value).trim();
}

function extractRssItems(xml: string): Array<{
  title: string;
  link: string;
  pubDate?: string;
  content: string;
}> {
  const items: Array<{
    title: string;
    link: string;
    pubDate?: string;
    content: string;
  }> = [];
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match = itemPattern.exec(xml);
  while (match) {
    const itemXml = match[1] ?? "";
    const title = extractTagValue(itemXml, "title") ?? "";
    const link = extractTagValue(itemXml, "link") ?? "";
    const pubDate = extractTagValue(itemXml, "pubDate");
    const content = extractTagValue(itemXml, "content:encoded") ?? "";
    if (title && link && content) {
      items.push({ title, link, pubDate, content });
    }
    match = itemPattern.exec(xml);
  }
  return items;
}

function cleanNewsletterJobTitle(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^\d+\.\s*/, "")
    .replace(/\s*\(\d+\s+positions?\)\s*$/i, "")
    .trim();
}

function parseEmployerFromTitle(title: string): string | null {
  const parts = title
    .split(/\s+(?:—|–|-)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length >= 2 ? (parts.at(-1) ?? null) : null;
}

function titleWithEmployer(anchorText: string, headingTitle: string): string {
  const cleanAnchor = cleanNewsletterJobTitle(anchorText);
  const employer = parseEmployerFromTitle(headingTitle);
  if (!employer) return cleanAnchor || headingTitle;
  if (cleanAnchor.toLowerCase().includes(employer.toLowerCase())) {
    return cleanAnchor;
  }
  return `${cleanAnchor} — ${employer}`;
}

function extractNewsletterJobCandidatesFromItem(args: {
  itemTitle: string;
  itemLink: string;
  pubDate?: string;
  content: string;
}): LinkCandidate[] {
  const jobsHeading = args.content.search(
    /<h2[^>]*>\s*(?:<[^>]+>)*\s*the jobs\s*(?:<[^>]+>)*\s*<\/h2>/i,
  );
  if (jobsHeading < 0) return [];

  const jobsHtml = args.content.slice(jobsHeading);
  const headingPattern = /<h4\b[^>]*>([\s\S]*?)<\/h4>/gi;
  const headingMatches = [...jobsHtml.matchAll(headingPattern)];
  const candidates: LinkCandidate[] = [];

  for (let index = 0; index < headingMatches.length; index += 1) {
    const match = headingMatches[index];
    if (match.index === undefined) continue;

    const headingHtml = match[1] ?? "";
    const headingText = cleanNewsletterJobTitle(stripTags(headingHtml));
    if (!/^\d+\./.test(normalizeWhitespace(stripTags(headingHtml)))) {
      continue;
    }

    const bodyStart = match.index + match[0].length;
    const bodyEnd =
      headingMatches[index + 1]?.index === undefined
        ? jobsHtml.length
        : headingMatches[index + 1].index;
    const bodyHtml = jobsHtml.slice(bodyStart, bodyEnd);
    const headingLinks = extractLinks(headingHtml, args.itemLink);
    const bodyLinks = extractLinks(bodyHtml, args.itemLink);
    const selectedLinks = headingLinks.length > 0 ? headingLinks : bodyLinks;
    const descriptionText = stripTags(bodyHtml).slice(0, 4000);

    for (const link of selectedLinks) {
      if (link.url.includes("substackcdn.com")) continue;
      if (link.url.startsWith("mailto:")) continue;
      const text =
        headingLinks.length > 0
          ? headingText
          : titleWithEmployer(link.text, headingText);
      if (!text || text.length < 4) continue;
      candidates.push({
        url: link.url,
        text,
        descriptionText,
        datePosted: args.pubDate,
        editionTitle: args.itemTitle,
        editionUrl: args.itemLink,
      });
    }
  }

  return candidates;
}

async function collectSubstackFeedCandidates(
  source: PublicSectorSource,
  fetchImpl: typeof fetch,
): Promise<LinkCandidate[]> {
  const xml = await fetchText(source.url, fetchImpl);
  const items = extractRssItems(xml).slice(0, POLICYJOBS_OTT_EDITION_LIMIT);
  const candidates = items.flatMap((item) =>
    extractNewsletterJobCandidatesFromItem({
      itemTitle: item.title,
      itemLink: item.link,
      pubDate: item.pubDate,
      content: item.content,
    }),
  );
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.url}|${candidate.text}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function collectCandidates(
  source: PublicSectorSource,
  fetchImpl: typeof fetch,
): Promise<LinkCandidate[]> {
  if (source.kind === "substack-feed") {
    return collectSubstackFeedCandidates(source, fetchImpl);
  }
  if (source.mode === "discovery-only") {
    return [];
  }

  const html = await fetchText(source.url, fetchImpl);
  if (source.platform === "barrie-embedded") {
    return collectBarrieEmbeddedCandidates(html, source);
  }
  if (source.platform === "successfactors") {
    return collectSuccessFactorsCandidates(html, source, fetchImpl);
  }

  return collectDirectLinkCandidates(html, source);
}

async function fetchJob(
  source: PublicSectorSource,
  candidate: LinkCandidate,
  searchTerms: string[],
  fetchImpl: typeof fetch,
): Promise<CreateJobInput | null> {
  const html =
    source.kind === "substack-feed" || candidate.descriptionText
      ? `<h1>${candidate.text}</h1><p>${candidate.descriptionText ?? ""}</p>`
      : await fetchText(candidate.url, fetchImpl);
  const text = stripTags(html);
  const title =
    source.kind === "substack-feed"
      ? candidate.text
      : extractTitle(html, candidate.text);

  const location = extractField(text, "location") ?? source.locationHint;
  const salary = extractField(text, "salary");
  const deadline = extractField(text, "deadline");
  const datePosted = extractField(text, "datePosted") ?? candidate.datePosted;
  const jobType = extractField(text, "jobType");
  if (
    !hasJobPostingEvidence({
      source,
      url: candidate.url,
      title,
      text,
      deadline,
      salary,
      location,
      datePosted,
      jobType,
    })
  ) {
    return null;
  }
  const employer = parseEmployerFromTitle(title) ?? source.employer;
  const classification = classifyJobRelevance({
    source: source.sourceId,
    sourceKind: source.kind === "substack-feed" ? "curated" : "public-sector",
    title,
    employer,
    description: text,
    url: candidate.url,
    deadline,
    salary,
    location,
    datePosted,
    jobType,
    searchTerms,
  });
  if (classification.status === "non_job_page") return null;

  return {
    source: source.sourceId,
    sourceJobId:
      source.kind === "substack-feed"
        ? sourceJobIdFromNewsletterJob(source.id, candidate.url, title)
        : sourceJobIdFromUrl(candidate.url, source.id),
    title,
    employer,
    jobUrl: candidate.url,
    applicationLink: candidate.applicationUrl ?? candidate.url,
    deadline,
    salary,
    location,
    datePosted,
    jobType,
    relevanceStatus: classification.status,
    relevanceReason: classification.reason,
    status:
      classification.status === "low_relevance" ? "skipped" : "discovered",
    disciplines: "Public sector | Policy, research, data, strategy",
    jobFunction: "Policy, research, data, strategy",
    locationEvidence: {
      location,
      rawLocation: location,
      country: "canada",
      countryKey: "canada",
      city: null,
      regionHints: ["Ontario"],
      workplaceType: null,
      isRemote: null,
      isHybrid: null,
      evidenceQuality: "approximate",
      source: source.sourceId,
      sourceNotes: [
        `source:${source.id}`,
        `employer:${employer}`,
        ...(candidate.editionTitle
          ? [`edition:${candidate.editionTitle}`]
          : []),
        ...(candidate.editionUrl ? [`editionUrl:${candidate.editionUrl}`] : []),
      ],
    },
    jobDescription: text.slice(0, 12000),
    isRemote: /\bremote\b/i.test(location),
  };
}

export async function runOntarioPublicSector(
  options: RunOntarioPublicSectorOptions = {},
): Promise<OntarioPublicSectorResult> {
  const searchTerms = options.searchTerms ?? [];
  const parsedMaxJobs = Number.isFinite(options.maxJobs)
    ? options.maxJobs
    : 150;
  const maxJobs = Math.max(1, parsedMaxJobs ?? 150);
  const fetchImpl = options.fetchImpl ?? fetch;
  const jobs: CreateJobInput[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  const selectedSources = new Set(
    options.selectedSources?.length
      ? options.selectedSources
      : ["ontario-public-sector"],
  );
  const runnableSources = SOURCES.filter((source) =>
    selectedSources.has(source.sourceId),
  );

  try {
    let sourceIndex = 0;
    for (const source of runnableSources) {
      sourceIndex += 1;
      if (options.shouldCancel?.()) return { success: true, jobs };

      options.onProgress?.({
        type: "source_start",
        sourceIndex,
        sourceTotal: runnableSources.length,
        sourceName: source.employer,
      });

      let jobsFoundSource = 0;
      try {
        const candidates = await collectCandidates(source, fetchImpl);
        for (const candidate of candidates) {
          if (options.shouldCancel?.()) return { success: true, jobs };
          if (jobs.length >= maxJobs) break;
          if (seen.has(candidate.url)) continue;
          seen.add(candidate.url);

          const job = await fetchJob(source, candidate, searchTerms, fetchImpl);
          if (!job) continue;
          jobs.push(job);
          jobsFoundSource += 1;
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown source error";
        errors.push(`${source.employer}: ${message}`);
      }

      options.onProgress?.({
        type: "source_complete",
        sourceIndex,
        sourceTotal: runnableSources.length,
        sourceName: source.employer,
        jobsFoundSource,
      });

      if (jobs.length >= maxJobs) break;
    }

    return {
      success: true,
      jobs,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unexpected error while running Ontario public-sector extractor.";
    return {
      success: false,
      jobs: [],
      error: message,
    };
  }
}
