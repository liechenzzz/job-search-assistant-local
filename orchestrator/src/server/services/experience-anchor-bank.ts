import { createHash } from "node:crypto";
import type {
  ExperienceAnchorFact,
  ExperienceAnchorSummary,
  JdQualificationProfile,
  ResumeReferenceChunk,
  ResumeReferenceScanItem,
  SelectedResumeEvidence,
} from "@shared/types";

const ANCHOR_SCHEMA_VERSION = 1;
const MAX_FACTS_PER_SECTION = 12;

export type ExperienceAnchorBuildResult = {
  chunks: ResumeReferenceChunk[];
  anchors: ExperienceAnchorSummary[];
  diagnostics: {
    anchorCount: number;
    orphanEvidenceChunks: Array<{
      chunkId: string;
      sourceFile: string;
      reason: string;
    }>;
    staleAnchorWarnings: string[];
  };
};

type AnchorGroup = {
  key: string;
  identity: ExperienceAnchorSummary["identity"];
  chunks: ResumeReferenceChunk[];
  sourceFiles: Set<string>;
};

export function buildExperienceAnchorBank(args: {
  items: ResumeReferenceScanItem[];
  chunks: ResumeReferenceChunk[];
  builtAt?: string;
}): ExperienceAnchorBuildResult {
  const builtAt = args.builtAt ?? new Date().toISOString();
  const itemsByPath = new Map(
    args.items.map((item) => [item.relativePath, item]),
  );
  const groups = new Map<string, AnchorGroup>();
  const orphanEvidenceChunks: ExperienceAnchorBuildResult["diagnostics"]["orphanEvidenceChunks"] =
    [];

  for (const inputChunk of args.chunks) {
    const chunk = enrichAnchorChunk(
      inputChunk,
      itemsByPath.get(inputChunk.relativePath),
    );
    if (!isAnchorEligible(chunk)) {
      orphanEvidenceChunks.push({
        chunkId: chunk.id,
        sourceFile: chunk.fileName,
        reason:
          "Chunk is too sparse or comes from an unsupported reference kind.",
      });
      continue;
    }

    const identity = inferAnchorIdentity(
      chunk,
      itemsByPath.get(chunk.relativePath),
    );
    const key = anchorGroupKey(identity, chunk);
    const group =
      groups.get(key) ??
      ({
        key,
        identity,
        chunks: [],
        sourceFiles: new Set<string>(),
      } satisfies AnchorGroup);
    group.chunks.push(chunk);
    group.sourceFiles.add(chunk.relativePath || chunk.fileName);
    groups.set(key, group);
  }

  const anchors = Array.from(groups.values())
    .map((group) => buildAnchorSummary(group, builtAt))
    .sort((a, b) => b.sourceChunkIds.length - a.sourceChunkIds.length);
  const anchorIdByChunk = new Map<string, string>();
  for (const anchor of anchors) {
    for (const chunkId of anchor.sourceChunkIds) {
      anchorIdByChunk.set(chunkId, anchor.experienceAnchorId);
    }
  }

  const chunks = args.chunks.map((chunk) => {
    const enriched = enrichAnchorChunk(
      chunk,
      itemsByPath.get(chunk.relativePath),
    );
    const experienceAnchorId = anchorIdByChunk.get(enriched.id);
    return experienceAnchorId ? { ...enriched, experienceAnchorId } : enriched;
  });

  return {
    chunks,
    anchors,
    diagnostics: {
      anchorCount: anchors.length,
      orphanEvidenceChunks,
      staleAnchorWarnings: [],
    },
  };
}

export function selectExperienceAnchorsForGeneration(args: {
  anchors: ExperienceAnchorSummary[];
  qualificationProfile: JdQualificationProfile;
  selectedEvidence: SelectedResumeEvidence[];
  maxAnchors?: number;
}): ExperienceAnchorSummary[] {
  if (args.anchors.length === 0) return [];
  const selectedAnchorIds = new Set(
    args.selectedEvidence.flatMap((item) =>
      item.chunks
        .map((chunk) => chunk.experienceAnchorId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const requirementTerms = tokenize(
    [
      ...args.qualificationProfile.required,
      ...args.qualificationProfile.preferred,
      ...args.qualificationProfile.keywords,
      ...(args.qualificationProfile.requirements?.map((item) => item.text) ??
        []),
    ].join(" "),
  );
  const maxAnchors = Math.max(1, Math.min(args.maxAnchors ?? 8, 12));
  return args.anchors
    .map((anchor) => ({
      anchor,
      score:
        (selectedAnchorIds.has(anchor.experienceAnchorId) ? 100 : 0) +
        scoreAnchorAgainstTerms(anchor, requirementTerms) +
        anchor.sourceChunkIds.length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxAnchors)
    .map((entry) => entry.anchor);
}

export function formatExperienceAnchorsForPrompt(
  anchors: ExperienceAnchorSummary[],
): string {
  if (anchors.length === 0) return "No persisted experience anchors available.";
  return anchors
    .map((anchor) =>
      [
        `### ${anchor.experienceAnchorId} | confidence=${anchor.confidence} | version=${anchor.version}`,
        `Identity: ${anchor.identity.title || "Role"} at ${anchor.identity.company || "Unknown company"}`,
        anchor.identity.dateRange ? `Dates: ${anchor.identity.dateRange}` : "",
        `Overview: ${anchor.roleOverview.text}`,
        formatFacts("Responsibilities", anchor.responsibilityAreas, 6),
        formatFacts("Projects", anchor.majorProjects, 4),
        formatFacts("Tools/methods", anchor.toolsAndMethods, 6),
        formatFacts("Domains", anchor.domains, 5),
        formatFacts("Stakeholders", anchor.stakeholders, 4),
        formatFacts("Measured outcomes", anchor.measurableOutcomes, 5),
        formatFacts("Transferable strengths", anchor.transferableStrengths, 5),
        anchor.limitationsOrUnverifiedClaims.length
          ? formatFacts("Limitations", anchor.limitationsOrUnverifiedClaims, 4)
          : "",
        `Source chunks: ${anchor.sourceChunkIds.slice(0, 10).join(", ")}`,
        `Source files: ${anchor.sourceFiles.slice(0, 5).join(", ")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function enrichAnchorChunk(
  chunk: ResumeReferenceChunk,
  item?: ResumeReferenceScanItem,
): ResumeReferenceChunk {
  const claimType = chunk.claimType ?? inferClaimType(chunk);
  const sourceQuality =
    chunk.sourceQuality ??
    chunk.qualitySignals?.confidence ??
    qualityFromItem(item);
  return {
    ...chunk,
    claimType,
    anchorSection: chunk.anchorSection ?? anchorSectionForClaimType(claimType),
    sourceQuality,
  };
}

function isAnchorEligible(chunk: ResumeReferenceChunk): boolean {
  if (chunk.kind === "unknown") return false;
  const textLength = (chunk.rawText ?? chunk.text).trim().length;
  return textLength >= 40;
}

function inferAnchorIdentity(
  chunk: ResumeReferenceChunk,
  item?: ResumeReferenceScanItem,
): ExperienceAnchorSummary["identity"] {
  const text = cleanText(
    [chunk.rawText ?? chunk.text, item?.snippets?.experience]
      .filter(Boolean)
      .join(" "),
  );
  const atPattern = text.match(
    /\b([A-Z][A-Za-z0-9&.' /-]{2,80})\s+(?:at|with|for)\s+([A-Z][A-Za-z0-9&.' /-]{2,80})\b/,
  );
  const companyRolePattern = text.match(
    /\b([A-Z][A-Za-z0-9&.' /-]{2,80})\s+(Analyst|Consultant|Associate|Coordinator|Manager|Specialist|Researcher|Advisor|Intern)\b/,
  );
  const title =
    cleanEntityName(atPattern?.[1] ?? "") ||
    cleanEntityName(companyRolePattern?.[2] ?? "") ||
    roleLabel(chunk.roleFamily);
  const company =
    cleanEntityName(atPattern?.[2] ?? "") ||
    cleanEntityName(companyRolePattern?.[1] ?? "") ||
    cleanFileStem(item?.fileName ?? chunk.fileName);
  const dateRange = text.match(
    /\b(?:20\d{2}|19\d{2})\s*(?:[-–—]\s*(?:20\d{2}|present|current))?/i,
  )?.[0];
  return {
    company: truncate(company, 90),
    title: truncate(title, 90),
    dateRange,
    location: undefined,
    roleAliases: uniqueList([
      roleLabel(chunk.roleFamily),
      title,
      item?.inferredRole ?? "",
    ]).slice(0, 5),
  };
}

function anchorGroupKey(
  identity: ExperienceAnchorSummary["identity"],
  chunk: ResumeReferenceChunk,
): string {
  const stable = [
    normalize(identity.company),
    normalize(identity.title),
    normalize(String(chunk.roleFamily)),
  ]
    .filter(Boolean)
    .join("|");
  if (stable.length >= 12) return stable;
  return [
    chunk.relativePath || chunk.fileName,
    chunk.section,
    chunk.roleFamily,
  ].join("|");
}

function buildAnchorSummary(
  group: AnchorGroup,
  builtAt: string,
): ExperienceAnchorSummary {
  const sortedChunks = [...group.chunks].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const sourceChunkIds = sortedChunks.map((chunk) => chunk.id);
  const sourceFiles = Array.from(group.sourceFiles).sort();
  const facts = uniqueFacts(
    sortedChunks.flatMap((chunk) => factsFromChunk(chunk)),
  );
  const byType = (type: NonNullable<ResumeReferenceChunk["claimType"]>) =>
    facts.filter((fact) => fact.type === type).slice(0, MAX_FACTS_PER_SECTION);
  const responsibilities = [
    ...byType("responsibility"),
    ...byType("outcome").slice(0, 4),
  ].slice(0, MAX_FACTS_PER_SECTION);
  const projects = facts
    .filter((fact) =>
      /project|initiative|program|portfolio|implementation/i.test(fact.text),
    )
    .slice(0, 8);
  const tools = byType("tool");
  const domains = byType("domain");
  const stakeholders = byType("stakeholder");
  const outcomes = [...byType("metric"), ...byType("outcome")].slice(
    0,
    MAX_FACTS_PER_SECTION,
  );
  const strengths = facts
    .filter((fact) => !["tool", "metric"].includes(fact.type))
    .slice(0, MAX_FACTS_PER_SECTION);
  const lowQualitySourceChunkIds = sortedChunks
    .filter(
      (chunk) =>
        (chunk.sourceQuality ?? chunk.qualitySignals?.confidence) === "low",
    )
    .map((chunk) => chunk.id);
  const confidence = anchorConfidence(
    sortedChunks,
    lowQualitySourceChunkIds.length,
  );
  const overviewText =
    responsibilities[0]?.text ||
    strengths[0]?.text ||
    `Evidence-backed ${group.identity.title || "role"} experience from ${sourceFiles.slice(0, 2).join(", ")}.`;

  return {
    experienceAnchorId: buildAnchorId(group.key),
    identity: group.identity,
    roleOverview: fact(
      overviewText,
      sourceChunkIds.slice(0, 3),
      sourceFiles,
      confidence,
    ),
    responsibilityAreas: responsibilities.map(toAnchorFact),
    majorProjects: projects.map(toAnchorFact),
    toolsAndMethods: tools.map(toAnchorFact),
    domains: domains.map(toAnchorFact),
    stakeholders: stakeholders.map(toAnchorFact),
    measurableOutcomes: outcomes.map(toAnchorFact),
    transferableStrengths: strengths.map(toAnchorFact),
    limitationsOrUnverifiedClaims: lowQualitySourceChunkIds.length
      ? [
          fact(
            "Some source evidence was extracted from low-confidence or sparse text; keep claims close to cited chunks.",
            lowQualitySourceChunkIds.slice(0, 6),
            sourceFiles,
            "low",
          ),
        ]
      : [],
    sourceChunkIds,
    sourceFiles,
    sourceDigestHash: digestChunks(sortedChunks),
    confidence,
    diagnostics: {
      buildMethod: "deterministic",
      sourceChunkCount: sortedChunks.length,
      lowQualitySourceChunkIds,
      orphanChunkIds: [],
      warnings: lowQualitySourceChunkIds.length
        ? ["Anchor contains low-confidence source chunks."]
        : [],
    },
    lastBuiltAt: builtAt,
    version: ANCHOR_SCHEMA_VERSION,
  };
}

function factsFromChunk(chunk: ResumeReferenceChunk): Array<
  ExperienceAnchorFact & {
    type: NonNullable<ResumeReferenceChunk["claimType"]>;
  }
> {
  const text = cleanText(chunk.rawText ?? chunk.text);
  const pieces = splitFactText(text).slice(0, 6);
  return pieces.map((piece) => ({
    text: truncate(piece, 260),
    sourceChunkIds: [chunk.id],
    sourceFiles: [chunk.relativePath || chunk.fileName],
    confidence:
      chunk.sourceQuality ?? chunk.qualitySignals?.confidence ?? "medium",
    type: chunk.claimType ?? inferClaimType(chunk),
  }));
}

function splitFactText(text: string): string[] {
  const parts = text
    .split(/(?:\n|\u2022|•|;|\s+-\s+|(?<=[.!?])\s+)/)
    .map(cleanText)
    .filter((part) => part.length >= 24);
  return parts.length ? parts : text.length >= 24 ? [text] : [];
}

function inferClaimType(
  chunk: ResumeReferenceChunk,
): NonNullable<ResumeReferenceChunk["claimType"]> {
  const text =
    `${chunk.section} ${chunk.rawText ?? chunk.text} ${chunk.keywords.join(" ")}`.toLowerCase();
  if (
    /education|degree|university|college|certificate|certification/.test(text)
  ) {
    return "education";
  }
  if (/\b\d+(?:\.\d+)?%|\$\s?\d|\b\d{2,}\b/.test(text)) return "metric";
  if (
    /\b(power bi|tableau|sql|python|sas|excel|r\b|salesforce|jira|figma|dashboard|model|forecast|regression)\b/i.test(
      text,
    )
  ) {
    return "tool";
  }
  if (
    /\b(stakeholder|client|executive|cross-functional|partner|vendor|public|community)\b/i.test(
      text,
    )
  ) {
    return "stakeholder";
  }
  if (
    /\b(policy|market|economic|municipal|public sector|health|finance|insurance|climate|research|operations)\b/i.test(
      text,
    )
  ) {
    return "domain";
  }
  if (
    /\b(improved|increased|reduced|delivered|launched|built|created|led|managed|optimized|streamlined)\b/i.test(
      text,
    )
  ) {
    return "outcome";
  }
  if (/summary|profile/i.test(chunk.section)) return "summary";
  return "responsibility";
}

function anchorSectionForClaimType(
  claimType: NonNullable<ResumeReferenceChunk["claimType"]>,
): string {
  if (claimType === "tool") return "toolsAndMethods";
  if (claimType === "domain") return "domains";
  if (claimType === "stakeholder") return "stakeholders";
  if (claimType === "metric" || claimType === "outcome")
    return "measurableOutcomes";
  if (claimType === "summary") return "transferableStrengths";
  if (claimType === "education") return "limitationsOrUnverifiedClaims";
  return "responsibilityAreas";
}

function uniqueFacts<T extends ExperienceAnchorFact & { type: string }>(
  facts: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of facts) {
    const key = normalize(item.text).replace(/\b\d{4}\b/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function toAnchorFact(
  item: ExperienceAnchorFact & { type: string },
): ExperienceAnchorFact {
  return {
    text: item.text,
    sourceChunkIds: item.sourceChunkIds,
    sourceFiles: item.sourceFiles,
    confidence: item.confidence,
  };
}

function fact(
  text: string,
  sourceChunkIds: string[],
  sourceFiles: string[],
  confidence: "high" | "medium" | "low",
): ExperienceAnchorFact {
  return { text, sourceChunkIds, sourceFiles, confidence };
}

function anchorConfidence(
  chunks: ResumeReferenceChunk[],
  lowQualityCount: number,
): "high" | "medium" | "low" {
  if (chunks.length >= 3 && lowQualityCount === 0) return "high";
  if (chunks.length >= 2 || lowQualityCount < chunks.length) return "medium";
  return "low";
}

function digestChunks(chunks: ResumeReferenceChunk[]): string {
  return createHash("sha1")
    .update(
      chunks
        .map(
          (chunk) =>
            `${chunk.id}|${chunk.clusterId ?? ""}|${chunk.normalizedText ?? chunk.text}`,
        )
        .sort()
        .join("\n"),
    )
    .digest("hex");
}

function buildAnchorId(key: string): string {
  return `anchor:${createHash("sha1").update(key).digest("hex").slice(0, 14)}`;
}

function scoreAnchorAgainstTerms(
  anchor: ExperienceAnchorSummary,
  terms: string[],
): number {
  const haystack = normalize(
    [
      anchor.identity.company,
      anchor.identity.title,
      anchor.roleOverview.text,
      ...anchor.responsibilityAreas.map((item) => item.text),
      ...anchor.majorProjects.map((item) => item.text),
      ...anchor.toolsAndMethods.map((item) => item.text),
      ...anchor.domains.map((item) => item.text),
      ...anchor.stakeholders.map((item) => item.text),
      ...anchor.measurableOutcomes.map((item) => item.text),
      ...anchor.transferableStrengths.map((item) => item.text),
    ].join(" "),
  );
  return terms.reduce(
    (sum, term) => sum + (haystack.includes(term) ? 8 : 0),
    0,
  );
}

function formatFacts(
  label: string,
  facts: ExperienceAnchorFact[],
  max: number,
): string {
  if (facts.length === 0) return "";
  return [
    `${label}:`,
    ...facts
      .slice(0, max)
      .map(
        (item) =>
          `- ${item.text} [chunks: ${item.sourceChunkIds.slice(0, 3).join(", ")}]`,
      ),
  ].join("\n");
}

function roleLabel(roleFamily: unknown): string {
  const value = String(roleFamily ?? "general");
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function qualityFromItem(
  item?: ResumeReferenceScanItem,
): "high" | "medium" | "low" {
  if (!item) return "medium";
  if (item.kind === "combined" || item.kind === "resume") return "medium";
  return "low";
}

function cleanFileStem(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/\b(resume|cv|cover|letter|combined|application|package)\b/gi, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanEntityName(value: string): string {
  return (
    value
      .split(
        /\b(?:built|delivered|prepared|created|led|managed|developed|improved|using|with|for)\b/i,
      )[0]
      ?.replace(/[,.|;:]+$/g, "")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").replaceAll("\0", "").trim();
}

function normalize(text: string): string {
  return cleanText(text).toLowerCase();
}

function truncate(text: string, max: number): string {
  const cleaned = cleanText(text);
  return cleaned.length <= max
    ? cleaned
    : `${cleaned.slice(0, max - 3).trim()}...`;
}

function uniqueList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values.map(cleanText).filter(Boolean)) {
    const key = normalize(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      normalize(text)
        .split(/[^a-z0-9+#.-]+/)
        .filter((term) => term.length >= 4),
    ),
  ).slice(0, 40);
}
