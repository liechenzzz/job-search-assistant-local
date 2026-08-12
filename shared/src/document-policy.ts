import {
  APPLICATION_ROLE_FAMILY_LABELS,
  detectApplicationRoleFamily,
  type RoleDetectionInput,
} from "./application-writing";
import type { ApplicationRoleFamily, ResumeProfile } from "./types/settings";

export type ResumeTargetPages = 1 | 2;
export type ResumePagePolicyMode = "locked" | "manual";
export type ResumePagePolicyReason =
  | "city_public_sector"
  | "ontario_provincial"
  | "public_sector_government"
  | "consulting"
  | "manual";

export interface DocumentPolicyInput extends RoleDetectionInput {
  source?: string | null;
  jobUrl?: string | null;
  applicationLink?: string | null;
  location?: string | null;
  resumeTargetPagesOverride?: ResumeTargetPages | null;
}

export interface CoverLetterPolicy {
  maxWords: number;
  targetBodyWords: number;
  salutation: "To Whom It May Concern:";
  requirePersonalHeader: boolean;
  requireReLine: boolean;
}

export interface DocumentPolicy {
  roleFamily: ApplicationRoleFamily;
  roleLabel: string;
  resumeTargetPages: ResumeTargetPages;
  resumePagePolicyMode: ResumePagePolicyMode;
  resumePagePolicyReason: ResumePagePolicyReason;
  resumePagePolicyLabel: string;
  allowsManualResumeTargetPages: boolean;
  coverLetter: CoverLetterPolicy;
  reason: string;
}

export function buildCoverLetterHeader(profile?: ResumeProfile): string[] {
  const basics = profile?.basics;
  const location = basics?.location;
  const locationLine = [location?.city, location?.region, location?.countryCode]
    .filter(Boolean)
    .join(", ");
  const contactLine = [basics?.email, basics?.phone]
    .filter(Boolean)
    .join(" | ");
  const linkedIn = basics?.profiles?.find(
    (item) =>
      item.network?.toLowerCase() === "linkedin" ||
      item.url?.toLowerCase().includes("linkedin.com"),
  );

  return [
    basics?.name,
    locationLine,
    contactLine,
    linkedIn?.url ? `LinkedIn: ${linkedIn.url}` : basics?.url,
  ].filter((line): line is string => Boolean(line?.trim()));
}

const CONSULTING_ONE_PAGE_ROLES = new Set<ApplicationRoleFamily>([
  "consulting_strategy",
]);

const CONSULTING_EMPLOYERS = [
  "accenture",
  "deloitte",
  "kpmg",
  "mckinsey",
  "mnp",
  "pwc",
  "pricewaterhousecoopers",
  "bain",
  "bcg",
  "boston consulting group",
  "ey",
  "ernst young",
  "ernst & young",
];

function normalizePolicyText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/&/g, " and ");
}

function hasWord(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  });
}

function containsAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(normalizePolicyText(term)));
}

function isOntarioProvincialJob(input: DocumentPolicyInput): boolean {
  const text = normalizePolicyText(
    [
      input.source,
      input.title,
      input.employer,
      input.jobDescription,
      input.jobUrl,
      input.applicationLink,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return (
    hasWord(text, [
      "ontario public service",
      "ops",
      "province of ontario",
      "government of ontario",
      "ontario government",
      "ontario ministry",
    ]) ||
    /\bministry of [a-z ,]+ontario\b/i.test(text) ||
    /\bjobs\.gov\.on\.ca\b/i.test(text)
  );
}

function isCityOrMunicipalJob(input: DocumentPolicyInput): boolean {
  const employer = normalizePolicyText(input.employer);
  const source = normalizePolicyText(input.source);
  const urlText = normalizePolicyText(
    [input.jobUrl, input.applicationLink].filter(Boolean).join("\n"),
  );
  const text = normalizePolicyText(
    [input.title, input.employer, input.jobDescription, input.location]
      .filter(Boolean)
      .join("\n"),
  );

  if (
    /\b(city|town|township|municipality|county|region|regional municipality) of\b/i.test(
      employer,
    )
  ) {
    return true;
  }

  if (
    hasWord(source, [
      "municipal",
      "city",
      "civicjobs",
      "city careers",
      "municipal world",
    ])
  ) {
    return true;
  }

  if (
    /\/careers|\/jobs|\/employment/.test(urlText) &&
    hasWord(urlText, [
      "toronto",
      "mississauga",
      "brampton",
      "hamilton",
      "barrie",
      "oakville",
      "burlington",
      "markham",
      "vaughan",
      "richmondhill",
      "richmond-hill",
      "durham",
      "halton",
      "peel",
      "yorkregion",
      "york-region",
    ])
  ) {
    return true;
  }

  return hasWord(text, [
    "municipal government",
    "local government",
    "regional government",
    "city council",
  ]);
}

function isBroadPublicSectorJob(input: DocumentPolicyInput): boolean {
  const employer = normalizePolicyText(input.employer);
  const source = normalizePolicyText(input.source);
  const urlText = normalizePolicyText(
    [input.jobUrl, input.applicationLink].filter(Boolean).join("\n"),
  );
  const text = normalizePolicyText(
    [
      input.source,
      input.title,
      input.employer,
      input.jobDescription,
      input.location,
      input.jobUrl,
      input.applicationLink,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  if (
    containsAny(employer, [
      "government of canada",
      "national research council canada",
      "building ontario fund",
      "ontario financing authority",
      "greater toronto airports authority",
      "toronto pearson",
    ])
  ) {
    return true;
  }

  if (
    containsAny(source, [
      "federal government",
      "public sector",
      "crown agency",
      "crown corporation",
      "public agency",
      "regulatory authority",
      "government careers",
    ])
  ) {
    return true;
  }

  if (
    containsAny(urlText, [
      "canada.ca",
      "gc.ca",
      "jobs.gc.ca",
      "gojobs.gov.on.ca",
      "ontario.ca",
    ])
  ) {
    return true;
  }

  return (
    containsAny(text, [
      "federal government",
      "provincial government",
      "public sector",
      "crown agency",
      "crown corporation",
      "public agency",
      "regulatory authority",
      "government stakeholder",
      "treasury board",
      "policy and regulatory compliance",
    ]) ||
    /\b(government|public-sector|public sector).{0,80}\b(policy|program|regulatory|stakeholder|briefing|planning|partnerships)\b/i.test(
      text,
    )
  );
}

function isExplicitConsultingJob(
  input: DocumentPolicyInput,
  roleFamily: ApplicationRoleFamily,
): boolean {
  const title = normalizePolicyText(input.title);
  const employer = normalizePolicyText(input.employer);
  const text = normalizePolicyText(
    [input.title, input.employer, input.jobDescription]
      .filter(Boolean)
      .join("\n"),
  );

  if (CONSULTING_EMPLOYERS.some((name) => employer.includes(name))) {
    return true;
  }

  if (
    hasWord(title, [
      "consultant",
      "consulting",
      "advisory",
      "management consulting",
    ])
  ) {
    return true;
  }

  return (
    CONSULTING_ONE_PAGE_ROLES.has(roleFamily) &&
    hasWord(text, ["consultant", "consulting", "advisory"])
  );
}

export function resolveDocumentPolicy(
  input: DocumentPolicyInput,
): DocumentPolicy {
  const roleFamily = detectApplicationRoleFamily(input);
  let resumeTargetPages: ResumeTargetPages;
  let resumePagePolicyMode: ResumePagePolicyMode = "locked";
  let resumePagePolicyReason: ResumePagePolicyReason;
  let resumePagePolicyLabel: string;
  let reason: string;

  if (isOntarioProvincialJob(input)) {
    resumeTargetPages = 2;
    resumePagePolicyReason = "ontario_provincial";
    resumePagePolicyLabel = "2-page locked · Ontario provincial / OPS";
    reason =
      "Ontario provincial and OPS applications always use a two-page resume.";
  } else if (isCityOrMunicipalJob(input)) {
    resumeTargetPages = 2;
    resumePagePolicyReason = "city_public_sector";
    resumePagePolicyLabel = "2-page locked · City / municipal";
    reason =
      "City, municipal, regional, and local public-sector applications always use a two-page resume.";
  } else if (isBroadPublicSectorJob(input)) {
    resumeTargetPages = 2;
    resumePagePolicyReason = "public_sector_government";
    resumePagePolicyLabel = "2-page locked - Government / public sector";
    reason =
      "Federal, provincial, municipal, Crown agency, public agency, regulatory, and public-sector policy applications always use a two-page resume.";
  } else if (isExplicitConsultingJob(input, roleFamily)) {
    resumeTargetPages = 1;
    resumePagePolicyReason = "consulting";
    resumePagePolicyLabel = "1-page locked · Consulting";
    reason =
      "Explicit consulting and advisory applications always use a one-page resume.";
  } else {
    resumePagePolicyMode = "manual";
    resumePagePolicyReason = "manual";
    resumeTargetPages = input.resumeTargetPagesOverride ?? 2;
    resumePagePolicyLabel = `Manual · ${resumeTargetPages} ${resumeTargetPages === 1 ? "page" : "pages"}`;
    reason =
      "Non-government, non-consulting applications use the user's selected one-page or two-page resume target.";
  }

  return {
    roleFamily,
    roleLabel: APPLICATION_ROLE_FAMILY_LABELS[roleFamily],
    resumeTargetPages,
    resumePagePolicyMode,
    resumePagePolicyReason,
    resumePagePolicyLabel,
    allowsManualResumeTargetPages: resumePagePolicyMode === "manual",
    coverLetter: {
      maxWords: 400,
      targetBodyWords: 330,
      salutation: "To Whom It May Concern:",
      requirePersonalHeader: true,
      requireReLine: true,
    },
    reason,
  };
}

export function buildResumePolicyInstructions(policy: DocumentPolicy): string {
  const sharedRules = [
    `Resume target length: ${policy.resumeTargetPages} ${policy.resumeTargetPages === 1 ? "page" : "pages"}.`,
    "Keep the existing section hierarchy unless the requested target length requires compression.",
    "Do not invent metrics, employers, projects, tools, credentials, or responsibilities.",
  ];

  if (policy.resumeTargetPages === 1) {
    return [
      ...sharedRules,
      "For one-page consulting resumes, use a compact SUMMARY paragraph rather than a long SUMMARY OF QUALIFICATIONS list.",
      "Prioritize problem structuring, analysis, client-ready recommendations, executive communication, decks, workshops, and implementation materials.",
      "Keep project selection tight. Prefer one highly relevant project over a broad project list.",
      "Limit skills to the strongest job-relevant groups and remove low-signal wording.",
    ].join("\n");
  }

  return [
    ...sharedRules,
    "For two-page resumes, preserve enough evidence for policy, research, public-sector, analyst, and non-consulting roles.",
    "A SUMMARY OF QUALIFICATIONS style is acceptable when the role requires detailed public-sector, policy, or analytical evidence.",
    "Use the extra space for stronger responsibilities, public-sector context, data/research methods, and implementation evidence rather than filler.",
  ].join("\n");
}

export function buildCoverLetterPolicyInstructions(
  policy: DocumentPolicy,
  profile?: ResumeProfile,
): string {
  const header = buildCoverLetterHeader(profile);
  const headerInstructions =
    header.length > 0
      ? [
          "- Use this personal header from the candidate profile:",
          ...header.map((line) => `  ${line}`),
        ]
      : [
          "- Use the candidate's personal header from the profile when available. Do not invent missing contact details.",
        ];
  const signoffName = profile?.basics?.name?.trim();

  return [
    "Cover letter format policy:",
    `- The final cover letter must be no more than ${policy.coverLetter.maxWords} visible words total, including header, salutation, Re line, body, and signoff.`,
    `- Aim for about ${policy.coverLetter.targetBodyWords} body words so the fixed header still fits under the limit.`,
    ...headerInstructions,
    `- Always use the salutation: ${policy.coverLetter.salutation}`,
    "- Always include a Re line immediately after the salutation.",
    "- If a job ID or posting number is available, format it as: Re: Job ID [id], [Job Title], [Employer].",
    "- If no job ID is available, format it as: Re: [Job Title], [Employer].",
    "- Use concise paragraphs. Do not use bullets unless the user explicitly asks.",
    signoffName
      ? `- End with: Sincerely, followed by ${signoffName}.`
      : "- End with: Sincerely, followed by the candidate's name from the profile.",
  ].join("\n");
}

export function countVisibleWords(text: string): number {
  const matches = text
    .replace(/https?:\/\/\S+/gi, " ")
    .match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g);
  return matches?.length ?? 0;
}

export function validateCoverLetterWordLimit(
  text: string,
  policy: CoverLetterPolicy,
): { ok: boolean; wordCount: number; maxWords: number } {
  const wordCount = countVisibleWords(text);
  return {
    ok: wordCount <= policy.maxWords,
    wordCount,
    maxWords: policy.maxWords,
  };
}
