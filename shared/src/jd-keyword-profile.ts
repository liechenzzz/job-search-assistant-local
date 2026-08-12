import {
  detectApplicationRoleFamily,
  type RoleDetectionInput,
} from "./application-writing";
import type { JdKeywordProfile } from "./types/jobs";

type KeywordRule = {
  label: string;
  pattern: RegExp;
  focus?: string;
};

const REQUIRED_KEYWORD_RULES: KeywordRule[] = [
  { label: "SQL", pattern: /\bsql\b/i, focus: "querying and data extraction" },
  { label: "Python", pattern: /\bpython\b/i, focus: "Python analysis" },
  { label: "Excel", pattern: /\bexcel\b/i, focus: "Excel analysis and reporting" },
  { label: "Power BI", pattern: /\bpower\s*bi\b/i, focus: "dashboarding" },
  { label: "Tableau", pattern: /\btableau\b/i, focus: "dashboarding" },
  { label: "dashboard", pattern: /\bdashboards?\b/i, focus: "dashboarding" },
  { label: "reporting", pattern: /\breporting|reports?\b/i, focus: "reporting" },
  { label: "data quality", pattern: /\bdata quality|quality assurance|qa\b/i, focus: "QA and validation" },
  { label: "KPI", pattern: /\bkpis?\b/i, focus: "KPI reporting" },
  { label: "stakeholder", pattern: /\bstakeholders?\b/i, focus: "stakeholder synthesis" },
  { label: "research", pattern: /\bresearch|analysis|analytical\b/i, focus: "analysis and research" },
  { label: "policy analysis", pattern: /\bpolicy analysis|policy research\b/i, focus: "policy analysis" },
  { label: "program evaluation", pattern: /\bprogram evaluation|evaluation framework\b/i, focus: "program evaluation" },
  { label: "market research", pattern: /\bmarket research|consumer insights|survey\b/i, focus: "research insights" },
  { label: "strategy", pattern: /\bstrategy|strategic\b/i, focus: "strategy work" },
  { label: "project management", pattern: /\bproject management|implementation|delivery\b/i, focus: "project delivery" },
];

const DOMAIN_KEYWORD_RULES: KeywordRule[] = [
  { label: "NOC", pattern: /\bnoc\b|\bnational occupational classification\b/i },
  { label: "NAICS", pattern: /\bnaics\b|\bnorth american industry classification\b/i },
  { label: "RTRA", pattern: /\brtra\b|\breal time remote access\b/i },
  { label: "municipal", pattern: /\bmunicipal|city of|regional government\b/i },
  { label: "public sector", pattern: /\bpublic sector|government|province of|ontario public service|\bops\b/i },
  { label: "economic development", pattern: /\beconomic development\b/i },
  { label: "labour market", pattern: /\blabou?r market|workforce\b/i },
  { label: "jurisdictional scan", pattern: /\bjurisdictional scan|jurisdictional review\b/i },
];

const BLOCKED_DOMAIN_TERMS = [
  "NOC",
  "NAICS",
  "RTRA",
  "municipal stakeholder",
  "public sector",
  "economic development",
  "jurisdictional scan",
];

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function matchingLabels(rules: KeywordRule[], text: string): string[] {
  return unique(
    rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label),
  );
}

function matchingFocus(text: string): string[] {
  return unique(
    REQUIRED_KEYWORD_RULES.filter((rule) => rule.pattern.test(text))
      .map((rule) => rule.focus ?? rule.label)
      .slice(0, 8),
  );
}

function resolveRoleFamily(input: RoleDetectionInput): JdKeywordProfile["roleFamily"] {
  const detected = detectApplicationRoleFamily(input);
  const text = [input.title, input.employer, input.jobDescription]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const dataSignals = matchingLabels(REQUIRED_KEYWORD_RULES, text).filter((value) =>
    /sql|python|excel|power bi|tableau|dashboard|reporting|data quality|kpi/i.test(
      value,
    ),
  ).length;
  const policySignals = matchingLabels(DOMAIN_KEYWORD_RULES, text).length;

  if (
    dataSignals >= 2 &&
    policySignals === 0 &&
    detected === "public_sector_policy_economic_development"
  ) {
    return "data_analytics_operations";
  }
  return detected;
}

export function buildJdKeywordProfile(
  input: RoleDetectionInput,
): JdKeywordProfile {
  const text = [input.title, input.employer, input.jobDescription]
    .filter(Boolean)
    .join("\n");
  const domainKeywordsPresent = matchingLabels(DOMAIN_KEYWORD_RULES, text);
  const blockedUnlessPresent = BLOCKED_DOMAIN_TERMS.filter(
    (term) =>
      !domainKeywordsPresent.some((present) =>
        term.toLowerCase().includes(present.toLowerCase()),
      ),
  );

  return {
    roleFamily: resolveRoleFamily(input),
    requiredKeywords: matchingLabels(REQUIRED_KEYWORD_RULES, text),
    domainKeywordsPresent,
    blockedUnlessPresent,
    experienceFocus: matchingFocus(text),
  };
}

export function buildJdKeywordProfileInstructions(
  profile: JdKeywordProfile,
): string {
  return [
    `Detected role family: ${profile.roleFamily}.`,
    `Required JD keywords to prioritize: ${profile.requiredKeywords.join(", ") || "none detected"}.`,
    `Domain terms present in JD: ${profile.domainKeywordsPresent.join(", ") || "none"}.`,
    `Do not introduce these domain terms unless the JD explicitly asks for them: ${profile.blockedUnlessPresent.join(", ") || "none"}.`,
    `Experience rewrite focus: ${profile.experienceFocus.join(", ") || "general evidence match"}.`,
    "If a source bullet contains a blocked term but the JD does not ask for it, generalize it without changing the underlying evidence.",
  ].join("\n");
}
