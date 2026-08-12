import type {
  EvidenceFitReport,
  JdQualificationProfile,
  ResumeAlignmentReport,
  ResumeCoveragePlan,
  ResumeCoveragePlanItem,
  ResumeReferenceScanItem,
} from "./types";
import {
  allowedEvidenceSectionsForQualification,
  hasSemanticCoverage,
  hasWeakSemanticCoverage,
  inferQualificationSemanticType,
  normalizeEvidenceSection,
  SEMANTIC_QUALIFICATION_ENGINE_VERSION,
} from "./qualification-semantics.js";

const STOPWORDS = new Set([
  "and",
  "are",
  "but",
  "for",
  "from",
  "have",
  "the",
  "this",
  "that",
  "with",
  "will",
  "your",
  "you",
  "our",
  "their",
  "role",
  "work",
  "ability",
  "experience",
  "knowledge",
  "skills",
  "including",
]);

const SKILL_ALWAYS_ALLOW = new Set([
  "excel",
  "power bi",
  "tableau",
  "sql",
  "python",
  "sas",
  "r",
  "salesforce",
  "sharepoint",
]);

export function buildResumeAlignmentReport(args: {
  qualificationProfile: JdQualificationProfile;
  resumeSections: Record<string, string>;
  referenceItems?: ResumeReferenceScanItem[];
  coveragePlan?: ResumeCoveragePlan;
}): ResumeAlignmentReport {
  const required = args.qualificationProfile.required.slice(0, 8);
  if (required.length === 0) {
    return {
      engineVersion: SEMANTIC_QUALIFICATION_ENGINE_VERSION,
      score: 0,
      status: "warning",
      missingRequired: [],
      partialRequired: ["No clear required qualifications detected in JD"],
      matchedSections: {},
      referenceUsed: [],
      humanInputNeeded: [],
      repairableRequired: [],
      evidenceFit: buildEvidenceFitReport(args.coveragePlan),
      alignmentSource: "deterministic",
    };
  }
  const referenceTextByFile = new Map(
    (args.referenceItems ?? []).map((item) => {
      const sections = item.sections.map(normalizeEvidenceSection);
      return [
        item.relativePath || item.fileName,
        {
          sections,
          text: normalizeText(
            [
              item.fileName,
              item.inferredRole,
              item.sections.join(" "),
              item.keywords?.join(" "),
              item.snippets?.summary,
              item.snippets?.experience,
              item.snippets?.coverLetter,
            ]
              .filter(Boolean)
              .join(" "),
          ),
        },
      ] as const;
    }),
  );
  const resumeSectionEntries = Object.entries(args.resumeSections).map(
    ([section, text]) => [section, normalizeText(text)] as const,
  );

  const matchedSections: Record<string, number> = {};
  const missingRequired: string[] = [];
  const partialRequired: string[] = [];
  const humanInputNeeded: string[] = [];
  const repairableRequired: string[] = [];
  const referenceUsed: string[] = [];
  let covered = 0;
  let partial = 0;

  for (const [index, requirement] of required.entries()) {
    const brief = findCoverageItem(args.coveragePlan, requirement, index);
    const semanticType =
      brief?.semanticType ?? inferQualificationSemanticType(requirement);
    if (semanticType === "admin/non_scored") continue;
    const allowedEvidenceSections =
      brief?.allowedEvidenceSections ??
      allowedEvidenceSectionsForQualification(requirement, semanticType);
    const keywords = mergeUnique([
      ...requirementKeywords(requirement),
      ...(brief?.allowedWordingHints ?? []),
    ]);
    const allowedResumeSections = resumeSectionEntries.filter(([section]) =>
      isAllowedEvidenceSection(section, allowedEvidenceSections),
    );
    const matched = allowedResumeSections.filter(([, text]) =>
      hasSemanticCoverage({ text, qualification: requirement, keywords, semanticType }),
    );
    if (matched.length > 0) {
      if (brief?.evidenceStatus === "transferable" && isSpecificRequirement(requirement)) {
        partial += 1;
        if (partialRequired.length < 5) partialRequired.push(requirement);
      } else {
        covered += 1;
      }
      for (const [section] of matched) {
        matchedSections[section] = (matchedSections[section] ?? 0) + 1;
      }
      continue;
    }

    const weakResumeMatch = allowedResumeSections.some(([, text]) =>
      hasWeakSemanticCoverage({
        text,
        qualification: requirement,
        keywords,
        semanticType,
      }),
    );
    const referenceMatch = [...referenceTextByFile.entries()].find(([, entry]) =>
      entry.sections.some((section) =>
        isAllowedEvidenceSection(section, allowedEvidenceSections),
      ) &&
      hasSemanticCoverage({
        text: entry.text,
        qualification: requirement,
        keywords,
        semanticType,
      }),
    );

    const hasEvidenceBrief = brief && brief.evidenceStatus !== "none";
    if (weakResumeMatch || referenceMatch || hasEvidenceBrief) {
      partial += 1;
      if (partialRequired.length < 5) partialRequired.push(requirement);
      if (hasEvidenceBrief && repairableRequired.length < 5) {
        repairableRequired.push(requirement);
      }
      if (referenceMatch) pushUnique(referenceUsed, referenceMatch[0], 5);
      for (const source of brief?.evidenceSources ?? []) {
        if (source.startsWith("reference:")) {
          pushUnique(referenceUsed, source.slice("reference:".length), 5);
        }
      }
      continue;
    }

    if (missingRequired.length < 5) missingRequired.push(requirement);
    if (humanInputNeeded.length < 5) humanInputNeeded.push(requirement);
  }

  const requiredCount = Math.max(required.length, 1);
  const preferredBonus = args.qualificationProfile.preferred
    .slice(0, 5)
    .filter((item) => {
      const keywords = requirementKeywords(item);
      return resumeSectionEntries.some(([, text]) =>
        hasKeywordCoverage(text, keywords),
      );
    }).length;
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(((covered + partial * 0.5) / requiredCount) * 90) +
        Math.min(10, preferredBonus * 2),
    ),
  );
  const status =
    missingRequired.length >= 2
      ? "failed"
      : missingRequired.length === 1 || partialRequired.length > 0
        ? "warning"
        : "pass";

  return {
    engineVersion: SEMANTIC_QUALIFICATION_ENGINE_VERSION,
    score,
    status,
    missingRequired,
    partialRequired,
    matchedSections,
    referenceUsed,
    humanInputNeeded,
    repairableRequired,
    evidenceFit: buildEvidenceFitReport(args.coveragePlan),
    alignmentSource: "deterministic",
  };
}

export function buildEvidenceFitReport(
  coveragePlan?: ResumeCoveragePlan,
): EvidenceFitReport | undefined {
  if (!coveragePlan || coveragePlan.items.length === 0) return undefined;
  const scored = coveragePlan.items.filter(
    (item) => item.semanticType !== "admin/non_scored",
  );
  if (scored.length === 0) return undefined;
  const evidenceBackedRequired: string[] = [];
  const noEvidenceRequired: string[] = [];
  const referenceUsed: string[] = [];
  let direct = 0;
  let transferable = 0;

  for (const item of scored) {
    if (item.evidenceStatus === "direct") {
      direct += 1;
      pushUnique(evidenceBackedRequired, item.qualification, 5);
    } else if (item.evidenceStatus === "transferable") {
      transferable += 1;
      pushUnique(evidenceBackedRequired, item.qualification, 5);
    } else {
      pushUnique(noEvidenceRequired, item.qualification, 5);
    }
    for (const source of item.evidenceSources) {
      if (source.startsWith("reference:")) {
        pushUnique(referenceUsed, source.slice("reference:".length), 5);
      }
    }
  }

  const score = Math.max(
    0,
    Math.min(100, Math.round(((direct + transferable * 0.75) / scored.length) * 100)),
  );
  const status =
    noEvidenceRequired.length >= 2
      ? "failed"
      : noEvidenceRequired.length === 1 || transferable > 0
        ? "warning"
        : "pass";

  return {
    score,
    status,
    evidenceBackedRequired,
    noEvidenceRequired,
    referenceUsed,
  };
}

export function filterSkillsForQualificationEvidence(
  skills: Array<{ name: string; keywords: string[] }>,
  args: {
    qualificationProfile: JdQualificationProfile;
    evidenceText: string;
    maxKeywordsPerGroup?: number | null;
  },
): Array<{ name: string; keywords: string[] }> {
  const jdText = normalizeText(
    [
      args.qualificationProfile.required.join(" "),
      args.qualificationProfile.preferred.join(" "),
      args.qualificationProfile.keywords.join(" "),
    ].join(" "),
  );
  const evidenceText = normalizeText(args.evidenceText);
  const maxKeywords = Math.max(1, Math.min(args.maxKeywordsPerGroup ?? 8, 12));

  const filtered = skills
    .map((group) => {
      const keywords = group.keywords
        .filter((keyword) =>
          shouldKeepSkillKeyword(keyword, { jdText, evidenceText }),
        )
        .slice(0, maxKeywords);
      return { name: group.name, keywords };
    })
    .filter((group) => group.keywords.length > 0)
    .slice(0, 6);
  const existing = new Set(
    filtered.flatMap((group) => group.keywords.map((keyword) => normalizeText(keyword))),
  );
  const supplemental = args.qualificationProfile.keywords
    .filter((keyword) => {
      const normalized = normalizeText(keyword);
      return (
        normalized &&
        normalized.includes(" ") &&
        !existing.has(normalized) &&
        ![...existing].some(
          (existingKeyword) =>
            existingKeyword.includes(normalized) ||
            normalized.includes(existingKeyword),
        ) &&
        jdText.includes(normalized) &&
        evidenceText.includes(normalized)
      );
    })
    .slice(0, maxKeywords);
  if (supplemental.length === 0) return filtered;
  if (filtered.length === 0) {
    return [{ name: "JD Qualifications", keywords: supplemental }];
  }
  return [
    {
      ...filtered[0],
      keywords: [...filtered[0].keywords, ...supplemental].slice(0, maxKeywords),
    },
    ...filtered.slice(1),
  ];
}

function shouldKeepSkillKeyword(
  keyword: string,
  args: { jdText: string; evidenceText: string },
): boolean {
  const normalized = normalizeText(keyword);
  if (!normalized) return false;
  if (SKILL_ALWAYS_ALLOW.has(normalized)) {
    return args.jdText.includes(normalized) && args.evidenceText.includes(normalized);
  }
  if (args.jdText.includes(normalized) && args.evidenceText.includes(normalized)) {
    return true;
  }
  const pieces = normalized
    .split(/\s+/)
    .filter((part) => part.length >= 4 && !STOPWORDS.has(part));
  return pieces.some(
    (part) => args.jdText.includes(part) && args.evidenceText.includes(part),
  );
}

function requirementKeywords(requirement: string): string[] {
  const normalized = normalizeText(requirement);
  const phrases = normalized.match(/\b[a-z][a-z0-9+#.-]*(?:\s+[a-z][a-z0-9+#.-]*){1,3}\b/g) ?? [];
  const words = normalized
    .split(/[^a-z0-9+#.-]+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  const keywords = [...phrases, ...words]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const out: string[] = [];
  for (const keyword of keywords) pushUnique(out, keyword, 8);
  return out;
}

function findCoverageItem(
  plan: ResumeCoveragePlan | undefined,
  requirement: string,
  index: number,
): ResumeCoveragePlanItem | undefined {
  if (!plan) return undefined;
  const normalized = normalizeText(requirement);
  return (
    plan.items[index]?.qualification &&
    normalizeText(plan.items[index].qualification) === normalized
      ? plan.items[index]
      : plan.items.find((item) => normalizeText(item.qualification) === normalized)
  );
}

function mergeUnique(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) pushUnique(out, value, 16);
  return out;
}

function isSpecificRequirement(requirement: string): boolean {
  const normalized = normalizeText(requirement);
  return /\b(\d+\+?\s+years?|degree|bachelor|master|diploma|certification|certified|license|licensed|bilingual|french|sql|python|power bi|tableau|sas|salesforce|sharepoint)\b/.test(
    normalized,
  );
}

function hasKeywordCoverage(text: string, keywords: string[]): boolean {
  if (!text || keywords.length === 0) return false;
  const phraseHit = keywords.some(
    (keyword) => keyword.includes(" ") && text.includes(keyword),
  );
  if (phraseHit) return true;
  const wordHits = keywords.filter(
    (keyword) => !keyword.includes(" ") && text.includes(keyword),
  ).length;
  return wordHits >= Math.min(2, keywords.length);
}

function hasWeakCoverage(text: string, keywords: string[]): boolean {
  if (!text || keywords.length === 0) return false;
  return keywords.some((keyword) => text.includes(keyword));
}

function isAllowedEvidenceSection(section: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  const normalized = normalizeEvidenceSection(section);
  return allowed.some((item) => normalizeEvidenceSection(item) === normalized);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushUnique(values: string[], value: string, max: number): void {
  const normalized = value.trim();
  if (!normalized) return;
  if (values.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) {
    return;
  }
  if (values.length >= max) return;
  values.push(normalized);
}
