import type {
  JdNormalizedRequirement,
  JdQualificationProfile,
  JdRequirementCategory,
} from "./types";
import { isNonScoredQualificationText } from "./qualification-semantics.js";

const REQUIRED_HEADINGS = [
  "qualifications",
  "requirements",
  "minimum qualifications",
  "our culture and qualifications of the job",
  "required qualifications",
  "what you bring",
  "what you'll bring",
  "skills and qualifications",
  "education and experience",
  "who you are",
  "what you need to succeed",
  "what we're looking for",
  "required skills and experience",
  "skills and experience",
  "your qualifications",
  "what you have",
  "desired skills and experience",
  "the ideal candidate",
  "about you",
  "qualifications and skills",
  "knowledge skills and abilities",
  "minimum requirements",
  "job requirements",
  "position requirements",
  "what it takes",
  "what you will need",
  "essential qualifications",
  "core competencies",
];

const STOP_HEADINGS = [
  "responsibilities",
  "duties",
  "what you will do",
  "what you'll do",
  "about",
  "benefits",
  "compensation",
  "conditions of employment",
  "collective agreement",
  "employment terms",
  "hours",
  "pay",
  "pay range",
  "salary",
  "wage",
  "how to apply",
  "application",
  "why join",
  "summary",
  "what we offer",
  "equal opportunity",
  "accommodation",
  "about us",
  "about the company",
  "about the team",
  "about the role",
  "company description",
  "our story",
  "our values",
  "our culture",
  "life at",
  "working at",
  "why work",
  "perks",
  "we offer",
  "what's in it for you",
  "diversity",
  "inclusion",
  "accessibility",
  "our commitment",
  "who we are",
  "about our organization",
  "the company",
  "the organization",
  "company overview",
  "overview",
  "introduction",
  "background",
  "work environment",
  "hybrid work",
  "remote work",
  "work arrangement",
  "work location",
  "location",
  "schedule",
  "employment type",
  "job type",
  "closing date",
  "deadline",
  "apply by",
  "to apply",
  "application instructions",
  "application process",
  "selection process",
  "hiring process",
  "next steps",
  "note",
  "disclaimer",
  "legal",
];

const PREFERRED_RE = /\b(preferred|asset|nice to have|considered an asset|bonus|ideally|would be an asset)\b/i;
const REQUIRED_RE = /\b(required|must|minimum|need|needs|qualification|experience|degree|diploma|proficien|ability|knowledge|skill|familiarity)\b/i;

const KEYWORD_PHRASES = [
  "stakeholder engagement",
  "stakeholder relations",
  "policy analysis",
  "public policy",
  "public-private partnership",
  "public private partnership",
  "government relations",
  "advocacy",
  "member relations",
  "communications",
  "briefing",
  "briefing notes",
  "research",
  "project coordination",
  "project management",
  "program management",
  "strategic planning",
  "enterprise strategy",
  "business planning",
  "data analysis",
  "data analytics",
  "reporting",
  "dashboard",
  "quality assurance",
  "excel",
  "power bi",
  "tableau",
  "sql",
  "python",
  "sas",
  "statistics canada",
  "market research",
  "industry research",
  "writing",
  "presentation",
  "consultation",
  "infrastructure",
  "procurement",
  "partnerships",
  "bilingual",
  "french",
];

export function buildJdQualificationProfile(args: {
  title?: string | null;
  employer?: string | null;
  jobDescription?: string | null;
}): JdQualificationProfile {
  const jd = normalizeWhitespace(args.jobDescription ?? "");
  const section = extractQualificationSection(jd);
  const lines = splitRequirementLines(section.text);
  const required: string[] = [];
  const preferred: string[] = [];
  const ignoredAdminLines: string[] = [...section.ignoredAdminLines];

  for (const line of lines) {
    const label = compactLabel(line);
    if (!label) continue;
    const adminTag = getAdministrativeLineTag(label);
    if (adminTag) {
      pushUnique(ignoredAdminLines, adminTag, 8);
      continue;
    }
    if (isNonScoredQualificationLine(label)) continue;
    if (PREFERRED_RE.test(label)) {
      pushUnique(preferred, label, 5);
      continue;
    }
    if (section.found || REQUIRED_RE.test(label)) {
      pushUnique(required, label, 8);
    }
  }

  if (required.length === 0) {
    for (const line of splitRequirementLines(jd)) {
      const label = compactLabel(line);
      const adminTag = getAdministrativeLineTag(label);
      if (adminTag) {
        pushUnique(ignoredAdminLines, adminTag, 8);
        continue;
      }
      if (isNonScoredQualificationLine(label)) continue;
      if (!REQUIRED_RE.test(label)) continue;
      pushUnique(required, label, 8);
      if (required.length >= 4) break;
    }
  }

  const keywords = extractKeywords([
    args.title ?? "",
    required.join(" "),
    preferred.join(" "),
  ].join("\n"));

  return {
    required: required.slice(0, 8),
    preferred: preferred.slice(0, 5),
    keywords: keywords.slice(0, 20),
    confidence: section.found
      ? required.length >= 3
        ? "high"
        : "medium"
      : "low",
    ignoredAdminLines: ignoredAdminLines.slice(0, 8),
    requirements: buildNormalizedRequirements({
      required: required.slice(0, 8),
      preferred: preferred.slice(0, 5),
      keywords: keywords.slice(0, 20),
    }),
  };
}

function buildNormalizedRequirements(args: {
  required: string[];
  preferred: string[];
  keywords: string[];
}): JdNormalizedRequirement[] {
  const requirements: JdNormalizedRequirement[] = [];
  const seen = new Set<string>();
  for (const [index, text] of args.required.entries()) {
    const key = normalizeRequirementKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      id: `req-${requirements.length + 1}`,
      text,
      category: inferRequirementCategory(text),
      priority: 100 - index,
      targetSections: inferRequirementTargetSections(text),
      mustHave: true,
      evidenceNeeded: "direct",
    });
  }
  for (const [index, text] of args.preferred.entries()) {
    const key = normalizeRequirementKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      id: `pref-${requirements.length + 1}`,
      text,
      category: inferRequirementCategory(text),
      priority: 60 - index,
      targetSections: inferRequirementTargetSections(text),
      mustHave: false,
      evidenceNeeded: "transferable",
    });
  }
  for (const [index, keyword] of args.keywords.entries()) {
    const text = keyword.trim();
    const key = normalizeRequirementKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const category = inferRequirementCategory(text);
    requirements.push({
      id: `kw-${requirements.length + 1}`,
      text,
      category,
      priority: category === "tool" || category === "domain" ? 45 - index : 35 - index,
      targetSections: category === "tool" || category === "skill" ? ["skills"] : ["summary"],
      mustHave: false,
      evidenceNeeded: "optional",
    });
  }
  return requirements
    .sort((a, b) => {
      if (a.mustHave !== b.mustHave) return a.mustHave ? -1 : 1;
      return b.priority - a.priority;
    })
    .slice(0, 12);
}

function normalizeRequirementKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();
}

function inferRequirementCategory(text: string): JdRequirementCategory {
  const lower = text.toLowerCase();
  if (/\b(degree|diploma|bachelor|master|education|academic)\b/.test(lower)) {
    return "education";
  }
  if (/\b(sql|python|excel|power\s*bi|tableau|sas|r\b|javascript|typescript|crm|salesforce)\b/.test(lower)) {
    return "tool";
  }
  if (/\b(policy|government|public sector|market|industry|infrastructure|procurement|healthcare|finance|insurance)\b/.test(lower)) {
    return "domain";
  }
  if (/\b(communicat|stakeholder|presentation|collaborat|leadership|relationship|interpersonal)\b/.test(lower)) {
    return "soft_skill";
  }
  if (/\b(responsib|coordinate|manage|lead|deliver|develop|prepare|conduct|analy[sz]e|report|research|support)\b/.test(lower)) {
    return "responsibility";
  }
  if (/\b(skill|proficien|ability|knowledge|familiarity)\b/.test(lower)) {
    return "skill";
  }
  return "experience";
}

function inferRequirementTargetSections(text: string): string[] {
  const category = inferRequirementCategory(text);
  if (category === "education") return ["education"];
  if (category === "tool" || category === "skill") return ["skills", "experience"];
  if (category === "domain") return ["summary", "experience", "skills"];
  if (category === "soft_skill") return ["summary", "experience"];
  return ["experience", "projects", "summary"];
}

export function buildJdQualificationProfileInstructions(
  profile: JdQualificationProfile,
): string {
  const required = profile.required.length
    ? profile.required.map((item) => `- ${item}`).join("\n")
    : "- No clear required qualifications detected; infer cautiously from the full JD.";
  const preferred = profile.preferred.length
    ? profile.preferred.map((item) => `- ${item}`).join("\n")
    : "- None detected.";
  const keywords = profile.keywords.length
    ? profile.keywords.join(", ")
    : "None detected.";
  return [
    `Confidence: ${profile.confidence}`,
    "Required qualifications:",
    required,
    "Preferred qualifications:",
    preferred,
    `Core keywords: ${keywords}`,
  ].join("\n");
}

function extractQualificationSection(jd: string): {
  text: string;
  found: boolean;
  ignoredAdminLines: string[];
} {
  if (!jd.trim()) return { text: "", found: false, ignoredAdminLines: [] };
  const lines = jd.split(/\n+/).map((line) => line.trim());
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const normalized = normalizeHeading(lines[i]);
    if (isRequiredHeading(normalized)) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    // No requirement heading found — filter the full JD to remove obvious non-qualification paragraphs.
    const filtered = lines
      .filter((line) => {
        const normalized = normalizeHeading(line);
        if (isStopHeading(normalized)) return false;
        if (getAdministrativeLineTag(line)) return false;
        return true;
      })
      .join("\n")
      .trim();
    return { text: filtered || jd, found: false, ignoredAdminLines: [] };
  }

  const selected: string[] = [];
  const ignoredAdminLines: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const normalized = normalizeHeading(lines[i]);
    const adminTag = getAdministrativeLineTag(lines[i]);
    if (adminTag) {
      pushUnique(ignoredAdminLines, adminTag, 8);
      continue;
    }
    if (
      selected.length > 0 &&
      isStopHeading(normalized)
    ) {
      break;
    }
    selected.push(lines[i]);
  }

  return {
    text: selected.join("\n").trim() || jd,
    found: selected.some(Boolean),
    ignoredAdminLines,
  };
}

function isRequiredHeading(normalized: string): boolean {
  if (!normalized) return false;
  if (/\bdescription\b/.test(normalized) && /\brequirements?\b/.test(normalized)) {
    return false;
  }
  return REQUIRED_HEADINGS.some((heading) => {
    if (normalized === heading) return true;
    if (normalized.endsWith(` ${heading}`)) return true;
    return normalized.includes(heading) && normalized.length <= heading.length + 24;
  });
}

function isStopHeading(normalized: string): boolean {
  if (!normalized) return false;
  return STOP_HEADINGS.some((heading) => {
    if (normalized === heading) return true;
    if (normalized.endsWith(` ${heading}`) && normalized.length <= heading.length + 24) {
      return true;
    }
    if (normalized.startsWith(`${heading} `) && normalized.length <= heading.length + 80) {
      return true;
    }
    return false;
  });
}

function splitRequirementLines(text: string): string[] {
  return text
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\n|(?:^|\s)[*•-]\s+/)
    .flatMap((line) =>
      line.split(/(?<=[.;])(?<!\b[a-z]\.[a-z]?\.?)\s+(?=[A-Z])/),
    )
    .map((line) =>
      line
        .replace(/^(?:[-*•]\s*|\d+[.)]\s*)+/, "")
        .trim(),
    )
    .filter((line) => line.length >= 8 && line.length <= 400);
}

function compactLabel(text: string): string {
  return normalizeWhitespace(text)
    .replace(/\s+/g, " ")
    .replace(/^[,;:\s]+|[,;:\s]+$/g, "")
    .slice(0, 220)
    .trim();
}

function expandContractions(text: string): string {
  return text
    .replace(/\bwe're\b/gi, "we are")
    .replace(/\bwe've\b/gi, "we have")
    .replace(/\bwe'll\b/gi, "we will")
    .replace(/\bit's\b/gi, "it is")
    .replace(/\bthat's\b/gi, "that is")
    .replace(/\bdon't\b/gi, "do not")
    .replace(/\bcan't\b/gi, "cannot");
}

function getAdministrativeLineTag(text: string): string | null {
  const normalized = expandContractions(normalizeWhitespace(text).toLowerCase());
  if (!normalized) return null;
  if (/\bequally important to what we do is how we do it\b/.test(normalized)) {
    return "Values Statement";
  }
  if (/\bfurther information is available\b/.test(normalized) || /\bwww\.|https?:\/\//.test(normalized)) {
    return "JobOpps Link";
  }
  if (/\beducation equivalency policy\b/.test(normalized)) {
    return "Education Equivalency Note";
  }
  if (/\bposition equivalency code\b/.test(normalized)) {
    return "Education Equivalency Code";
  }
  if (/^(hours?|normal hours of work|work schedule)\s*:/.test(normalized)) {
    return "Hours";
  }
  if (
    /^(wage|salary|pay|pay range|rate of pay|compensation)\s*:/.test(
      normalized,
    )
  ) {
    return "Wage";
  }
  if (
    /\b(final base salary|base salary|salary will be determined|non-discriminatory factors|compensation range)\b/.test(
      normalized,
    )
  ) {
    return "Compensation";
  }
  if (
    /\b(our approach is|human-centric|global network|expert teams|cultural knowledge|industry experience)\b/.test(
      normalized,
    )
  ) {
    return "Company Description";
  }
  if (/\b(founded in|we are a|we're a leading|is a leading|is one of the|a fortune|a global|global leader)\b/.test(normalized)) {
    return "Company Description";
  }
  if (
    /\b(collective agreement|cupe|bargaining unit|union local|unionized|union position)\b/.test(
      normalized,
    )
  ) {
    return "Collective Agreement";
  }
  if (
    /^(benefits?|pension|vacation|application deadline|deadline|how to apply)\s*:/.test(
      normalized,
    )
  ) {
    return "Application Terms";
  }
  if (
    /\b(pay level|pay range|normal hours|hours per week|hours of work|work hours|probationary period|trial period)\b/.test(
      normalized,
    )
  ) {
    return "Employment Terms";
  }
  if (
    /\b(we are committed to|we are proud to|we celebrate|we embrace|diversity|inclusion|equal opportunity employer|committed to building|committed to creating)\b/.test(
      normalized,
    )
  ) {
    return "DEI Boilerplate";
  }
  if (
    /\b(proud to be|a great place to work|best place to work|top employer|award winning|recognized as)\b/.test(
      normalized,
    )
  ) {
    return "Employer Branding";
  }
  if (/\bthis posting (represents|is|has been|will|may)\b/.test(normalized)) {
    return "Posting Meta";
  }
  if (
    /\b(compensation package that aligns|compensation package is|salary range for this|the compensation range|salary will be commensurate)\b/.test(
      normalized,
    )
  ) {
    return "Compensation";
  }
  return null;
}

function isNonScoredQualificationLine(text: string): boolean {
  return (
    isQualificationSubheading(text) ||
    isCultureStatement(text) ||
    isNonScoredQualificationText(text)
  );
}

function isQualificationSubheading(text: string): boolean {
  const normalized = normalizeHeading(text);
  return (
    normalized === "education" ||
    normalized === "education degreediplomacertifications" ||
    normalized === "experience" ||
    normalized === "knowledgeskillability" ||
    normalized === "knowledge skill ability" ||
    normalized === "demonstrated ability to" ||
    normalized === "skills" ||
    normalized === "abilities"
  );
}

function isCultureStatement(text: string): boolean {
  const normalized = normalizeHeading(text);
  return (
    normalized.startsWith("corporate culture") ||
    normalized.includes("workplace values align") ||
    normalized.includes("core accountabilities") ||
    normalized.includes("how we work together")
  );
}

function extractKeywords(text: string): string[] {
  const original = normalizeWhitespace(text);
  const normalized = original.toLowerCase();
  const out: string[] = [];

  for (const phrase of KEYWORD_PHRASES) {
    if (normalized.includes(phrase)) pushUnique(out, toTitleKeyword(phrase), 20);
  }

  const acronyms = original.match(/\b[A-Z]{2,6}\b/g) ?? [];
  for (const acronym of acronyms) pushUnique(out, acronym, 20);

  const toolMatches = normalized.match(/\b(power bi|tableau|sql|python|excel|sas|r|salesforce|sharepoint)\b/gi) ?? [];
  for (const tool of toolMatches) pushUnique(out, toTitleKeyword(tool), 20);

  return out;
}

function normalizeHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").trim();
}

function pushUnique(values: string[], value: string, max: number): void {
  const normalized = value.trim();
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (values.some((existing) => existing.toLowerCase() === key)) return;
  if (values.length >= max) return;
  values.push(normalized);
}

function toTitleKeyword(value: string): string {
  const lower = value.toLowerCase();
  if (["sql", "sas"].includes(lower)) return lower.toUpperCase();
  if (lower === "power bi") return "Power BI";
  return lower.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}
