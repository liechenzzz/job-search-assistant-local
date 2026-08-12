import type { ResumeQualificationSemanticType } from "./types";

export const SEMANTIC_QUALIFICATION_ENGINE_VERSION = "semantic-v4";

export function inferQualificationSemanticType(
  qualification: string,
): ResumeQualificationSemanticType {
  const normalized = normalizeText(qualification);
  if (!normalized || isNonScoredQualificationText(normalized)) return "admin/non_scored";
  if (
    /\b(degree|diploma|university|college|bachelor|master|education credential|educational credential)\b/.test(
      normalized,
    )
  ) {
    return "education";
  }
  if (/\b(license|licence|licensed|certification|certified|designation|registered)\b/.test(normalized)) {
    return "credential/license";
  }
  if (/\b(french|english|bilingual|language)\b/.test(normalized)) return "language";
  if (/\b(excel|power bi|tableau|sql|python|sas|salesforce|sharepoint|software|proficien)\b/.test(normalized)) {
    return "skill/tool";
  }
  if (/\b(years?|experience|performed duties|related experience)\b/.test(normalized)) {
    return "experience";
  }
  if (/\b(knowledge|familiarity|understanding|principles|practices|processes|naics|classification)\b/.test(normalized)) {
    return "knowledge/domain";
  }
  if (/\b(ability|demonstrated ability|able to|conduct|develop|analyz|communicat|present|write)\b/.test(normalized)) {
    return "ability";
  }
  return "ability";
}

export function allowedEvidenceSectionsForQualification(
  qualification: string,
  semanticType = inferQualificationSemanticType(qualification),
): string[] {
  const normalized = normalizeText(qualification);
  if (semanticType === "admin/non_scored") return [];
  if (semanticType === "education") {
    const sections = ["education"];
    if (
      /\b(equivalent combination of education and experience|education and experience|experience may substitute|related experience may substitute)\b/.test(
        normalized,
      )
    ) {
      sections.push("experience");
    }
    return sections;
  }
  if (semanticType === "credential/license") return ["education", "skills"];
  if (semanticType === "language") return ["skills", "experience", "education"];
  if (semanticType === "skill/tool") return ["skills", "experience", "projects"];
  if (semanticType === "knowledge/domain") {
    return ["experience", "skills", "projects", "summary"];
  }
  return ["experience", "projects", "summary"];
}

export function isNonScoredQualificationText(text: string): boolean {
  const normalized = normalizeText(
    text
      .replace(/\bwe're\b/gi, "we are")
      .replace(/\bwe've\b/gi, "we have")
      .replace(/\bwe'll\b/gi, "we will")
      .replace(/\bit's\b/gi, "it is")
      .replace(/\bthat's\b/gi, "that is")
      .replace(/\bdon't\b/gi, "do not")
      .replace(/\bcan't\b/gi, "cannot"),
  );
  return (
    /\bequally important to what we do is how we do it\b/.test(normalized) ||
    /\bfurther information is available\b/.test(normalized) ||
    /\bhttps?:\/\/|\bwww\./.test(normalized) ||
    /\beducation equivalency policy\b/.test(normalized) ||
    /\bposition equivalency code\b/.test(normalized) ||
    /\bcollective agreement|cupe|bargaining unit|pay range|pay level|normal hours of work|hours per week\b/.test(
      normalized,
    ) ||
    /\b(final base salary|base salary|salary will be determined|non-discriminatory factors|compensation range|compensation package that aligns|compensation package is|salary range for this|salary will be commensurate)\b/.test(
      normalized,
    ) ||
    /\b(our approach is|human-centric|global network|expert teams|cultural knowledge|industry experience)\b/.test(
      normalized,
    ) ||
    /\b(founded in|we are a|we are a leading|is a leading|is one of the|a fortune|a global leader|global leader in)\b/.test(
      normalized,
    ) ||
    /\b(we are committed to|we are proud to|we celebrate|we embrace diversity|equal opportunity employer|committed to building a|committed to creating a)\b/.test(
      normalized,
    ) ||
    /\b(proud to be|a great place to work|best place to work|top employer|award winning|recognized as a)\b/.test(
      normalized,
    ) ||
    /\b(hybrid work|remote work|work arrangement|flexible work|work-life balance|work life balance)\b/.test(
      normalized,
    ) ||
    /\b(competitive salary|competitive compensation|comprehensive benefits|extended health|dental coverage|vision coverage|rrsp|retirement savings|tuition reimbursement)\b/.test(
      normalized,
    ) ||
    /\b(apply now|apply today|click apply|submit your|send your resume|send your cv|upload your)\b/.test(normalized) ||
    /\bthis posting (represents|is|has been|will|may)\b/.test(normalized) ||
    /^(we are|we have|we offer|we value|we believe|at .{3,40} (we|our|is))/.test(normalized)
  );
}

export function hasSemanticCoverage(args: {
  text: string;
  qualification: string;
  keywords: string[];
  semanticType?: ResumeQualificationSemanticType;
}): boolean {
  const semanticType =
    args.semanticType ?? inferQualificationSemanticType(args.qualification);
  const text = normalizeText(args.text);
  if (!text || semanticType === "admin/non_scored") return false;
  if (semanticType === "education") {
    return hasEducationCoverage(text, args.qualification);
  }
  return hasKeywordCoverage(text, args.keywords);
}

export function hasWeakSemanticCoverage(args: {
  text: string;
  qualification: string;
  keywords: string[];
  semanticType?: ResumeQualificationSemanticType;
}): boolean {
  const semanticType =
    args.semanticType ?? inferQualificationSemanticType(args.qualification);
  const text = normalizeText(args.text);
  if (!text || semanticType === "admin/non_scored") return false;
  if (semanticType === "education") {
    return hasEducationLevelCoverage(text) || hasEducationFieldCoverage(text, args.qualification);
  }
  return args.keywords.some((keyword) => text.includes(keyword));
}

function hasEducationCoverage(text: string, qualification: string): boolean {
  if (!hasEducationLevelCoverage(text)) return false;
  return hasEducationFieldCoverage(text, qualification);
}

function hasEducationLevelCoverage(text: string): boolean {
  return /\b(bachelor|master|university|college|degree|ba|b\.a|ma|m\.a|mii|university of toronto)\b/.test(
    text,
  );
}

function hasEducationFieldCoverage(text: string, qualification: string): boolean {
  const required = normalizeText(qualification);
  if (/\b(related|relevant|appropriate|similar)\s+field\b/.test(required)) {
    return true;
  }
  const hasFieldConstraint =
    /\bin\s+[a-z0-9, /\-]+/.test(required) ||
    /\b(social sciences?|communications?|business|economics?|statistics|market research|public policy|urban studies|city studies|psychology|sociology)\b/.test(
      required,
    );
  if (!hasFieldConstraint || /\bor equivalent\b/.test(required)) {
    if (
      /\b(social sciences?|communications?)\b/.test(required) &&
      hasSocialScienceAdjacentEducation(text)
    ) {
      return true;
    }
    return true;
  }
  if (
    /\b(social sciences?|communications?)\b/.test(required) &&
    hasSocialScienceAdjacentEducation(text)
  ) {
    return true;
  }
  if (/\bbusiness\b/.test(required) && /\bbusiness\b/.test(text)) return true;
  if (/\beconomics?\b/.test(required) && /\beconomics?\b/.test(text)) return true;
  if (/\bstatistics?\b/.test(required) && /\bstatistics?\b/.test(text)) return true;
  if (/\bmarket research\b/.test(required) && /\bmarket research\b/.test(text)) return true;
  if (/\bpublic policy\b/.test(required) && /\bpublic policy\b/.test(text)) return true;
  if (/\bpsychology|sociology\b/.test(required) && hasSocialScienceAdjacentEducation(text)) return true;
  return false;
}

function hasSocialScienceAdjacentEducation(text: string): boolean {
  return /\b(social sciences?|communications?|media studies|city studies|urban studies|public policy|public administration|political science|sociology|psychology)\b/.test(
    text,
  );
}

function hasKeywordCoverage(text: string, keywords: string[]): boolean {
  if (!text || keywords.length === 0) return false;
  if (keywords.some((keyword) => keyword.includes(" ") && text.includes(keyword))) {
    return true;
  }
  const wordHits = keywords.filter(
    (keyword) => !keyword.includes(" ") && text.includes(keyword),
  ).length;
  return wordHits >= Math.min(2, keywords.length);
}

export function normalizeEvidenceSection(section: string): string {
  const normalized = normalizeText(section);
  if (/\beducation|degree|university|college\b/.test(normalized)) return "education";
  if (/\bskill|technical|tool\b/.test(normalized)) return "skills";
  if (/\bproject\b/.test(normalized)) return "projects";
  if (/\bsummary|profile|qualification\b/.test(normalized)) return "summary";
  if (/\bexperience|employment|work\b/.test(normalized)) return "experience";
  return normalized;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9+#.\s/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
