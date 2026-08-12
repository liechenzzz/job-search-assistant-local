import {
  allowedEvidenceSectionsForQualification,
  hasSemanticCoverage,
  hasWeakSemanticCoverage,
  inferQualificationSemanticType,
  normalizeEvidenceSection,
} from "./qualification-semantics.js";
import type {
  JdQualificationProfile,
  ResumeCoveragePlan,
  ResumeCoveragePlanItem,
  ResumeReferenceScanItem,
} from "./types";

const STOPWORDS = new Set([
  "and",
  "are",
  "but",
  "for",
  "from",
  "have",
  "into",
  "that",
  "the",
  "their",
  "this",
  "with",
  "work",
  "your",
  "ability",
  "experience",
  "including",
  "knowledge",
  "qualification",
  "requirements",
  "skills",
]);

const TRANSFERABLE_SIGNAL_GROUPS: Array<{
  triggers: string[];
  signals: string[];
  targetSections: string[];
}> = [
  {
    triggers: [
      "strategy",
      "strategic",
      "planning",
      "roadmap",
      "prioritization",
    ],
    signals: [
      "strategy",
      "strategic planning",
      "business planning",
      "roadmap",
      "prioritization",
      "recommendations",
      "decision-ready",
      "executive-ready",
    ],
    targetSections: ["summary", "experience", "projects"],
  },
  {
    triggers: ["stakeholder", "engagement", "consultation", "relationship"],
    signals: [
      "stakeholder",
      "engagement",
      "consultation",
      "client-facing",
      "cross-functional",
      "workshop",
      "interview",
      "presentation",
    ],
    targetSections: ["summary", "experience"],
  },
  {
    triggers: [
      "data",
      "analytics",
      "analysis",
      "dashboard",
      "reporting",
      "kpi",
    ],
    signals: [
      "data analysis",
      "analytics",
      "dashboard",
      "reporting",
      "kpi",
      "quality assurance",
      "excel",
      "power bi",
      "python",
      "sql",
    ],
    targetSections: ["summary", "skills", "experience", "projects"],
  },
  {
    triggers: ["policy", "research", "briefing", "writing", "synthesis"],
    signals: [
      "policy analysis",
      "research",
      "briefing",
      "writing",
      "synthesis",
      "comparative review",
      "recommendations",
      "memo",
    ],
    targetSections: ["summary", "experience", "skills"],
  },
  {
    triggers: [
      "project",
      "coordination",
      "manage",
      "implementation",
      "timeline",
    ],
    signals: [
      "project coordination",
      "project management",
      "implementation",
      "timeline",
      "deliverables",
      "cross-functional",
      "work plan",
    ],
    targetSections: ["experience", "projects"],
  },
  {
    triggers: ["presentation", "communication", "executive", "leadership"],
    signals: [
      "presentation",
      "communication",
      "executive-ready",
      "leadership",
      "briefing",
      "storytelling",
      "client-facing",
    ],
    targetSections: ["summary", "experience"],
  },
];

export function buildResumeCoveragePlan(args: {
  qualificationProfile: JdQualificationProfile;
  resumeSections: Record<string, string>;
  referenceItems?: ResumeReferenceScanItem[];
}): ResumeCoveragePlan {
  const resumeEntries = Object.entries(args.resumeSections).map(
    ([section, text]) => [section, normalizeText(text)] as const,
  );
  const referenceEntries = (args.referenceItems ?? []).map((item) => ({
    source: item.relativePath || item.fileName,
    sections: item.sections.map(normalizeEvidenceSection),
    item,
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
  }));

  const items: ResumeCoveragePlanItem[] = args.qualificationProfile.required
    .slice(0, 8)
    .map((qualification) => {
      const semanticType = inferQualificationSemanticType(qualification);
      const allowedEvidenceSections = allowedEvidenceSectionsForQualification(
        qualification,
        semanticType,
      );
      const keywords = requirementKeywords(qualification);
      const allowedWordingHints = buildAllowedWordingHints(qualification);
      const targetSections = inferTargetSections(
        qualification,
        allowedWordingHints,
        semanticType,
      );
      const allowedResumeEntries = resumeEntries.filter(([section]) =>
        isAllowedEvidenceSection(section, allowedEvidenceSections),
      );
      const allowedReferenceEntries = referenceEntries.filter((entry) =>
        entry.sections.some((section) =>
          isAllowedEvidenceSection(section, allowedEvidenceSections),
        ),
      );
      const strongSections = allowedResumeEntries
        .filter(([, text]) =>
          hasSemanticCoverage({ text, qualification, keywords, semanticType }),
        )
        .map(([section]) => section);
      const transferableSections = allowedResumeEntries
        .filter(
          ([section, text]) =>
            !strongSections.includes(section) &&
            semanticType !== "education" &&
            hasStrongCoverage(text, allowedWordingHints),
        )
        .map(([section]) => section);
      const weakSections = allowedResumeEntries
        .filter(
          ([section, text]) =>
            !strongSections.includes(section) &&
            !transferableSections.includes(section) &&
            hasWeakSemanticCoverage({
              text,
              qualification,
              keywords: [...keywords, ...allowedWordingHints],
              semanticType,
            }),
        )
        .map(([section]) => section);
      const directReferenceSources = allowedReferenceEntries
        .filter((entry) =>
          hasSemanticCoverage({
            text: buildReferenceTextForSemantic(entry.item, semanticType),
            qualification,
            keywords,
            semanticType,
          }),
        )
        .map((entry) => entry.source)
        .slice(0, 3);
      const transferableReferenceSources = allowedReferenceEntries
        .filter(
          (entry) =>
            !directReferenceSources.includes(entry.source) &&
            semanticType !== "education" &&
            hasStrongCoverage(entry.text, allowedWordingHints),
        )
        .map((entry) => entry.source)
        .slice(0, 3);
      const referenceSources = [
        ...directReferenceSources,
        ...transferableReferenceSources,
      ].slice(0, 3);
      const evidenceStatus =
        strongSections.length > 0 || directReferenceSources.length > 0
          ? "direct"
          : transferableSections.length > 0 ||
              weakSections.length > 0 ||
              transferableReferenceSources.length > 0
            ? "transferable"
            : "none";
      const sourceType =
        directReferenceSources.length > 0
          ? "reference"
          : strongSections.length > 0
            ? "master"
            : referenceSources.length > 0
              ? "reference"
              : transferableSections.length > 0 || weakSections.length > 0
                ? "master"
                : "none";
      const status =
        strongSections.length > 0
          ? "covered"
          : transferableSections.length > 0 ||
              weakSections.length > 0 ||
              referenceSources.length > 0
            ? "partial"
            : "missing";

      return {
        qualification,
        semanticType,
        status,
        sections:
          strongSections.length > 0
            ? strongSections
            : [...transferableSections, ...weakSections],
        evidenceSources: [
          ...strongSections.map((section) => `resume:${section}`),
          ...transferableSections.map((section) => `resume:${section}`),
          ...weakSections.map((section) => `resume:${section}`),
          ...directReferenceSources.map((source) => `reference:${source}`),
          ...transferableReferenceSources.map(
            (source) => `reference:${source}`,
          ),
        ].slice(0, 5),
        evidenceStatus,
        targetSections,
        allowedEvidenceSections,
        allowedWordingHints,
        sourceType,
      };
    });

  return {
    items,
    missingRequired: items
      .filter((item) => item.status === "missing")
      .map((item) => item.qualification)
      .slice(0, 5),
    partialRequired: items
      .filter((item) => item.status === "partial")
      .map((item) => item.qualification)
      .slice(0, 5),
    referenceUsed: Array.from(
      new Set(
        items.flatMap((item) =>
          item.evidenceSources
            .filter((source) => source.startsWith("reference:"))
            .map((source) => source.slice("reference:".length)),
        ),
      ),
    ).slice(0, 5),
  };
}

export function formatResumeCoveragePlanInstructions(
  plan: ResumeCoveragePlan,
): string {
  if (plan.items.length === 0) {
    return "No clear required qualifications were detected; tailor cautiously from JD keywords and do not invent missing evidence.";
  }
  return plan.items
    .slice(0, 8)
    .map((item) => {
      const sections = item.sections.length ? item.sections.join(", ") : "none";
      const sources = item.evidenceSources.length
        ? item.evidenceSources.join("; ")
        : "no supporting evidence found";
      const targets = item.targetSections.length
        ? item.targetSections.join(", ")
        : sections;
      const hints = item.allowedWordingHints.length
        ? ` | allowed JD wording: ${item.allowedWordingHints.slice(0, 8).join(", ")}`
        : "";
      const semantic = item.semanticType ? `; ${item.semanticType}` : "";
      const allowed = item.allowedEvidenceSections?.length
        ? ` | allowed evidence sections: ${item.allowedEvidenceSections.join(", ")}`
        : "";
      return `- [${item.status}; ${item.evidenceStatus}; ${item.sourceType}${semantic}] ${item.qualification} | visible/source sections: ${sections} | target sections: ${targets}${allowed} | evidence: ${sources}${hints}`;
    })
    .join("\n");
}

export function hasRepairableCoverageGap(plan: ResumeCoveragePlan): boolean {
  return plan.items.some(
    (item) =>
      item.status !== "covered" &&
      item.evidenceStatus !== "none" &&
      item.evidenceSources.length > 0,
  );
}

function buildAllowedWordingHints(qualification: string): string[] {
  const normalized = normalizeText(qualification);
  const hints: string[] = [];
  for (const group of TRANSFERABLE_SIGNAL_GROUPS) {
    if (group.triggers.some((trigger) => normalized.includes(trigger))) {
      for (const signal of group.signals) pushUnique(hints, signal, 12);
    }
  }
  return hints;
}

function inferTargetSections(
  qualification: string,
  allowedWordingHints: string[],
  semanticType = inferQualificationSemanticType(qualification),
): string[] {
  const normalized = normalizeText(
    [qualification, allowedWordingHints.join(" ")].join(" "),
  );
  const sections: string[] = [];
  if (semanticType === "education") {
    return ["education"];
  }
  if (semanticType === "credential/license") {
    return ["education", "skills"];
  }
  if (
    /\b(degree|education|bachelor|master|diploma|certification)\b/.test(
      normalized,
    )
  ) {
    pushUnique(sections, "education", 5);
  }
  if (
    /\b(skill|excel|power bi|tableau|sql|python|sas|french|bilingual)\b/.test(
      normalized,
    )
  ) {
    pushUnique(sections, "skills", 5);
  }
  if (/\b(project|portfolio|case study|dashboard|report)\b/.test(normalized)) {
    pushUnique(sections, "projects", 5);
  }
  pushUnique(sections, "experience", 5);
  pushUnique(sections, "summary", 5);
  return sections;
}

function isAllowedEvidenceSection(section: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  const normalized = normalizeEvidenceSection(section);
  return allowed.some((item) => normalizeEvidenceSection(item) === normalized);
}

function buildReferenceTextForSemantic(
  item: ResumeReferenceScanItem,
  semanticType: ReturnType<typeof inferQualificationSemanticType>,
): string {
  if (semanticType === "education") {
    return normalizeText(
      [
        item.fileName,
        item.sections.join(" "),
        item.keywords?.join(" "),
        item.sections.some(
          (section) => normalizeEvidenceSection(section) === "education",
        )
          ? [item.snippets?.summary, item.snippets?.experience]
              .filter(Boolean)
              .join(" ")
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return normalizeText(
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
  );
}

function requirementKeywords(requirement: string): string[] {
  const normalized = normalizeText(requirement);
  const phrases =
    normalized.match(/\b[a-z][a-z0-9+#.-]*(?:\s+[a-z][a-z0-9+#.-]*){1,3}\b/g) ??
    [];
  const words = normalized
    .split(/[^a-z0-9+#.-]+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  const out: string[] = [];
  for (const keyword of [...phrases, ...words].sort(
    (a, b) => b.length - a.length,
  )) {
    const value = keyword.trim();
    if (!value) continue;
    if (out.some((existing) => existing === value)) continue;
    out.push(value);
    if (out.length >= 8) break;
  }
  return out;
}

function hasStrongCoverage(text: string, keywords: string[]): boolean {
  if (!text || keywords.length === 0) return false;
  if (
    keywords.some((keyword) => keyword.includes(" ") && text.includes(keyword))
  ) {
    return true;
  }
  const wordHits = keywords.filter(
    (keyword) => !keyword.includes(" ") && text.includes(keyword),
  ).length;
  return wordHits >= Math.min(2, keywords.length);
}

function hasWeakCoverage(text: string, keywords: string[]): boolean {
  if (!text || keywords.length === 0) return false;
  return keywords.some((keyword) => text.includes(keyword));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9+#.\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushUnique(values: string[], value: string, max: number): void {
  const normalized = value.trim();
  if (!normalized) return;
  if (
    values.some(
      (existing) => existing.toLowerCase() === normalized.toLowerCase(),
    )
  ) {
    return;
  }
  if (values.length >= max) return;
  values.push(normalized);
}
