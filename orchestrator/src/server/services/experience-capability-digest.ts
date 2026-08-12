import type {
  ExperienceCapabilityDigest,
  ExperienceAnchorSummary,
  JdNormalizedRequirement,
  JdQualificationProfile,
  ResumeProfile,
  SelectedResumeEvidence,
  SelectedResumeEvidenceChunk,
} from "@shared/types";
import type { JsonSchemaDefinition } from "./llm/types";

export type ExperienceDigestSource = {
  id: string;
  sourceText: string;
};

type VisibleExperience = {
  id: string;
  label: string;
  company: string;
  position: string;
  sourceText: string;
};

type DigestCandidate = {
  experience: VisibleExperience;
  matchedEvidence: Array<{
    requirementId?: string;
    requirement: string;
    status: SelectedResumeEvidence["status"];
    fit?: SelectedResumeEvidence["fit"];
    chunk: SelectedResumeEvidenceChunk;
  }>;
};

type ExperienceDigestLlmClient = {
  callJson<T>(args: {
    model: string;
    messages: Array<{ role: "user"; content: string }>;
    jsonSchema: JsonSchemaDefinition;
    stage?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): Promise<{ success: true; data: T } | { success: false; error: string }>;
};

type DigestLlmResponse = {
  items: ExperienceCapabilityDigest[];
};

const EXPERIENCE_DIGEST_SCHEMA: JsonSchemaDefinition = {
  name: "experience_capability_digest",
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            experienceId: { type: "string" },
            label: { type: "string" },
            fitLevel: {
              type: "string",
              enum: ["primary", "relevant", "background"],
            },
            capabilitySummary: { type: "string" },
            coreClaims: { type: "array", items: { type: "string" } },
            transferableClaims: { type: "array", items: { type: "string" } },
            matchedRequirementIds: { type: "array", items: { type: "string" } },
            recommendedBulletThemes: { type: "array", items: { type: "string" } },
            sourceChunkIds: { type: "array", items: { type: "string" } },
            blockedClaims: { type: "array", items: { type: "string" } },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
          },
          required: [
            "experienceId",
            "label",
            "fitLevel",
            "capabilitySummary",
            "coreClaims",
            "transferableClaims",
            "matchedRequirementIds",
            "recommendedBulletThemes",
            "sourceChunkIds",
            "blockedClaims",
            "confidence",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

export async function buildExperienceCapabilityDigests(args: {
  profile: ResumeProfile;
  sourceExperiences: ExperienceDigestSource[];
  qualificationProfile: JdQualificationProfile;
  selectedEvidence: SelectedResumeEvidence[];
  experienceAnchors?: ExperienceAnchorSummary[];
  llm?: ExperienceDigestLlmClient;
  model?: string;
}): Promise<ExperienceCapabilityDigest[]> {
  const experiences = collectVisibleExperiences(args.profile, args.sourceExperiences);
  if (experiences.length === 0) return [];

  const requirements = getRequirements(args.qualificationProfile);
  const candidates = experiences.map((experience) => ({
    experience,
    matchedEvidence: matchEvidenceToExperience({
      experience,
      selectedEvidence: args.selectedEvidence,
    }),
  }));
  if (args.experienceAnchors?.length) {
    return candidates.map((candidate) =>
      buildAnchorBackedDigest({
        candidate,
        requirements,
        selectedEvidence: args.selectedEvidence,
        experienceAnchors: args.experienceAnchors ?? [],
      }),
    );
  }
  const fallback = candidates.map((candidate) =>
    buildFallbackDigest(candidate, requirements, args.selectedEvidence),
  );

  const hasSelectedChunks = candidates.some(
    (candidate) => candidate.matchedEvidence.length > 0,
  );
  if (!args.llm || !args.model || !hasSelectedChunks) return fallback;

  const result = await args.llm.callJson<DigestLlmResponse>({
    model: args.model,
    messages: [
      {
        role: "user",
        content: buildDigestPrompt({
          candidates,
          requirements,
          fallback,
          selectedEvidence: args.selectedEvidence,
        }),
      },
    ],
    jsonSchema: EXPERIENCE_DIGEST_SCHEMA,
    stage: "experience_capability_digest",
    metadata: { generatedVisibleContent: false },
  });
  if (!result.success) return fallback;

  return mergeLlmDigests({
    fallback,
    llmItems: sanitizeDigestResponse(result.data),
  });
}

export function formatExperienceCapabilityDigestsForPrompt(
  digests: ExperienceCapabilityDigest[],
): string {
  if (digests.length === 0) return "No visible experience digests.";
  return digests
    .map((digest) =>
      [
        `### ${digest.experienceId} | ${digest.fitLevel} | confidence=${digest.confidence}`,
        `Label: ${digest.label}`,
        `Capability summary: ${digest.capabilitySummary}`,
        `Matched requirements: ${digest.matchedRequirementIds.join(", ") || "none"}`,
        `Core claims: ${digest.coreClaims.slice(0, 8).join("; ") || "none"}`,
        `Transferable claims: ${digest.transferableClaims.slice(0, 6).join("; ") || "none"}`,
        `Required bullet themes: ${digest.recommendedBulletThemes.slice(0, 10).join("; ") || "none"}`,
        `Source chunks: ${digest.sourceChunkIds.slice(0, 8).join(", ") || "none"}`,
        `Blocked claims: ${digest.blockedClaims.slice(0, 6).join("; ") || "none"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function collectVisibleExperiences(
  profile: ResumeProfile,
  sourceExperiences: ExperienceDigestSource[],
): VisibleExperience[] {
  return (
    profile.sections?.experience?.items
      ?.filter((item) => {
        const record = item as typeof item & { hidden?: boolean };
        return item.visible !== false && record.hidden !== true;
      })
      .map((item, index) => {
        const record = item as typeof item & {
          description?: string;
          period?: string;
        };
        const id = item.id || `experience-${index}`;
        const sourceText =
          sourceExperiences.find((source) => source.id === id)?.sourceText ??
          stripHtml([item.summary, record.description].filter(Boolean).join("\n"));
        const label = [item.position, item.company].filter(Boolean).join(" at ");
        return {
          id,
          label: label || id,
          company: item.company ?? "",
          position: item.position ?? "",
          sourceText,
        };
      }) ?? []
  );
}

function matchEvidenceToExperience(args: {
  experience: VisibleExperience;
  selectedEvidence: SelectedResumeEvidence[];
}): DigestCandidate["matchedEvidence"] {
  const experienceText = normalize(
    [
      args.experience.company,
      args.experience.position,
      args.experience.sourceText,
    ].join(" "),
  );
  const company = normalize(args.experience.company);
  const position = normalize(args.experience.position);
  const experienceTerms = tokenize(experienceText).slice(0, 24);

  return args.selectedEvidence.flatMap((item) =>
    item.chunks
      .filter((chunk) => {
        const chunkText = normalize(chunk.rawText);
        if (company && chunkText.includes(company)) return true;
        if (position && chunkText.includes(position)) return true;
        const keywordOverlap = chunk.keywords.filter((keyword) =>
          experienceText.includes(normalize(keyword)),
        ).length;
        if (keywordOverlap >= 1) return true;
        const overlap = experienceTerms.filter((term) => chunkText.includes(term)).length;
        return overlap >= 3;
      })
      .map((chunk) => ({
        requirementId: item.requirementId,
        requirement: item.requirement,
        status: item.status,
        fit: item.fit,
        chunk,
      })),
  );
}

function buildFallbackDigest(
  candidate: DigestCandidate,
  requirements: JdNormalizedRequirement[],
  selectedEvidence: SelectedResumeEvidence[],
): ExperienceCapabilityDigest {
  const matchedRequirementIds = Array.from(
    new Set(
      candidate.matchedEvidence
        .map((item) => item.requirementId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const sourceChunkIds = Array.from(
    new Set(candidate.matchedEvidence.map((item) => item.chunk.chunkId)),
  ).slice(0, 10);
  const directCount = candidate.matchedEvidence.filter(
    (item) => item.status === "selected" || item.fit === "direct",
  ).length;
  const claims = uniqueList([
    ...extractFallbackClaims(candidate.experience.sourceText),
    ...candidate.matchedEvidence.flatMap((item) =>
      extractFallbackClaims(item.chunk.rawText),
    ),
  ]).slice(0, 10);
  const transferableClaims = uniqueList(
    selectedEvidence
      .filter((item) =>
        item.requirementId
          ? matchedRequirementIds.includes(item.requirementId)
          : false,
      )
      .flatMap((item) => item.allowedClaims ?? []),
  ).slice(0, 8);
  const blockedClaims = uniqueList(
    selectedEvidence
      .filter((item) =>
        item.requirementId
          ? matchedRequirementIds.includes(item.requirementId)
          : item.status === "no_evidence" || item.status === "weak_evidence",
      )
      .flatMap((item) => item.blockedClaims ?? []),
  ).slice(0, 8);
  const matchedRequirements = requirements.filter((requirement) =>
    matchedRequirementIds.includes(requirement.id),
  );
  const recommendedBulletThemes = uniqueList([
    ...matchedRequirements.map((item) => item.text),
    ...claims,
    ...transferableClaims,
  ]).slice(0, 10);

  const fitLevel =
    directCount >= 2 || matchedRequirementIds.length >= 2
      ? "primary"
      : matchedRequirementIds.length > 0 || sourceChunkIds.length > 0
        ? "relevant"
        : "background";
  const confidence =
    sourceChunkIds.length >= 2
      ? "high"
      : claims.length >= 4 || sourceChunkIds.length === 1
        ? "medium"
        : "low";

  return {
    experienceId: candidate.experience.id,
    label: candidate.experience.label,
    fitLevel,
    capabilitySummary:
      claims.slice(0, 2).join(" ") ||
      `${candidate.experience.label} has sparse source evidence; keep claims close to the master resume text.`,
    coreClaims: claims.slice(0, 8),
    transferableClaims,
    matchedRequirementIds,
    recommendedBulletThemes,
    sourceChunkIds,
    blockedClaims,
    confidence,
  };
}

function buildAnchorBackedDigest(args: {
  candidate: DigestCandidate;
  requirements: JdNormalizedRequirement[];
  selectedEvidence: SelectedResumeEvidence[];
  experienceAnchors: ExperienceAnchorSummary[];
}): ExperienceCapabilityDigest {
  const matchedAnchors = findMatchedAnchors({
    experience: args.candidate.experience,
    matchedEvidence: args.candidate.matchedEvidence,
    experienceAnchors: args.experienceAnchors,
  });
  if (matchedAnchors.length === 0) {
    return buildFallbackDigest(
      args.candidate,
      args.requirements,
      args.selectedEvidence,
    );
  }

  const matchedAnchorIds = new Set(
    matchedAnchors.map((anchor) => anchor.experienceAnchorId),
  );
  const selectedByAnchor = args.selectedEvidence.filter((item) =>
    item.chunks.some(
      (chunk) =>
        chunk.experienceAnchorId && matchedAnchorIds.has(chunk.experienceAnchorId),
    ),
  );
  const matchedRequirementIds = Array.from(
    new Set(
      selectedByAnchor
        .map((item) => item.requirementId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const sourceChunkIds = Array.from(
    new Set([
      ...matchedAnchors.flatMap((anchor) => anchor.sourceChunkIds),
      ...args.candidate.matchedEvidence.map((item) => item.chunk.chunkId),
    ]),
  ).slice(0, 16);
  const anchorClaims = uniqueList(
    matchedAnchors.flatMap((anchor) => [
      anchor.roleOverview.text,
      ...anchor.responsibilityAreas.map((item) => item.text),
      ...anchor.majorProjects.map((item) => item.text),
      ...anchor.measurableOutcomes.map((item) => item.text),
      ...anchor.stakeholders.map((item) => item.text),
    ]),
  );
  const transferableClaims = uniqueList([
    ...matchedAnchors.flatMap((anchor) => [
      ...anchor.toolsAndMethods.map((item) => item.text),
      ...anchor.domains.map((item) => item.text),
      ...anchor.transferableStrengths.map((item) => item.text),
    ]),
    ...selectedByAnchor.flatMap((item) => item.allowedClaims ?? []),
  ]).slice(0, 10);
  const blockedClaims = uniqueList([
    ...matchedAnchors.flatMap((anchor) =>
      anchor.limitationsOrUnverifiedClaims.map((item) => item.text),
    ),
    ...selectedByAnchor.flatMap((item) => item.blockedClaims ?? []),
  ]).slice(0, 10);
  const matchedRequirements = args.requirements.filter((requirement) =>
    matchedRequirementIds.includes(requirement.id),
  );
  const recommendedBulletThemes = uniqueList([
    ...matchedRequirements.map((item) => item.text),
    ...anchorClaims,
    ...transferableClaims,
  ]).slice(0, 12);
  const directEvidenceCount = selectedByAnchor.filter(
    (item) => item.status === "selected" || item.fit === "direct",
  ).length;
  const fitLevel =
    directEvidenceCount >= 2 || matchedRequirementIds.length >= 2
      ? "primary"
      : matchedRequirementIds.length > 0 || anchorClaims.length >= 4
        ? "relevant"
        : "background";
  const confidence = combineAnchorConfidence(matchedAnchors);

  return {
    experienceId: args.candidate.experience.id,
    label: args.candidate.experience.label,
    fitLevel,
    capabilitySummary:
      matchedAnchors
        .map((anchor) => anchor.roleOverview.text)
        .filter(Boolean)
        .slice(0, 2)
        .join(" ") ||
      `${args.candidate.experience.label} is backed by persisted experience anchors.`,
    coreClaims: anchorClaims.slice(0, 10),
    transferableClaims,
    matchedRequirementIds,
    recommendedBulletThemes,
    sourceChunkIds,
    blockedClaims,
    confidence,
  };
}

function findMatchedAnchors(args: {
  experience: VisibleExperience;
  matchedEvidence: DigestCandidate["matchedEvidence"];
  experienceAnchors: ExperienceAnchorSummary[];
}): ExperienceAnchorSummary[] {
  const anchorIdsFromEvidence = new Set(
    args.matchedEvidence
      .map((item) => item.chunk.experienceAnchorId)
      .filter((id): id is string => Boolean(id)),
  );
  const byEvidence = args.experienceAnchors.filter((anchor) =>
    anchorIdsFromEvidence.has(anchor.experienceAnchorId),
  );
  if (byEvidence.length) return byEvidence;

  const experienceText = normalize(
    [
      args.experience.company,
      args.experience.position,
      args.experience.sourceText,
    ].join(" "),
  );
  const company = normalize(args.experience.company);
  const position = normalize(args.experience.position);
  return args.experienceAnchors
    .map((anchor) => ({
      anchor,
      score:
        (company && normalize(anchor.identity.company).includes(company) ? 20 : 0) +
        (position && normalize(anchor.identity.title).includes(position) ? 20 : 0) +
        tokenize(
          [
            anchor.identity.company,
            anchor.identity.title,
            anchor.roleOverview.text,
            ...anchor.responsibilityAreas.map((item) => item.text),
          ].join(" "),
        ).filter((term) => experienceText.includes(term)).length,
    }))
    .filter((entry) => entry.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((entry) => entry.anchor);
}

function combineAnchorConfidence(
  anchors: ExperienceAnchorSummary[],
): "high" | "medium" | "low" {
  if (anchors.some((anchor) => anchor.confidence === "high")) return "high";
  if (anchors.some((anchor) => anchor.confidence === "medium")) return "medium";
  return "low";
}

function buildDigestPrompt(args: {
  candidates: DigestCandidate[];
  requirements: JdNormalizedRequirement[];
  fallback: ExperienceCapabilityDigest[];
  selectedEvidence: SelectedResumeEvidence[];
}): string {
  const requirements = args.requirements
    .slice(0, 12)
    .map(
      (item) =>
        `- ${item.id} | ${item.category} | priority=${item.priority} | mustHave=${item.mustHave ? "yes" : "no"}: ${item.text}`,
    )
    .join("\n");
  const experiences = args.candidates
    .map((candidate) => {
      const evidence = candidate.matchedEvidence
        .slice(0, 10)
        .map(
          (item) =>
            `  - requirement=${item.requirementId ?? item.requirement} | status=${item.status} | chunk=${item.chunk.chunkId}: ${truncate(item.chunk.rawText, 420)}`,
        )
        .join("\n");
      const fallback = args.fallback.find(
        (item) => item.experienceId === candidate.experience.id,
      );
      return [
        `Experience ${candidate.experience.id}: ${candidate.experience.label}`,
        `Master/source text: ${truncate(candidate.experience.sourceText, 900)}`,
        `Fallback claims: ${fallback?.coreClaims.join("; ") || "none"}`,
        "Matched selected evidence:",
        evidence || "  none",
      ].join("\n");
    })
    .join("\n\n");

  return [
    "Build a capability digest for each resume experience before writing the resume.",
    "Each digest should describe what the experience can truthfully support, which JD requirements it covers, and what claims would overreach.",
    "Do not invent employers, tools, metrics, credentials, dates, or direct responsibilities not supported by the master/source text or selected evidence.",
    "fitLevel: primary means it supports multiple core JD themes; relevant means it supports at least one JD theme; background means keep it for continuity with careful wording.",
    "recommendedBulletThemes should contain 6-10 concise themes that can become resume bullets.",
    "",
    "JD REQUIREMENTS:",
    requirements || "No structured requirements.",
    "",
    "EXPERIENCE INPUTS:",
    experiences,
  ].join("\n");
}

function sanitizeDigestResponse(
  value: Partial<DigestLlmResponse> | undefined,
): ExperienceCapabilityDigest[] {
  const items = Array.isArray(value?.items) ? value.items : [];
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as unknown as Record<string, unknown>;
      const experienceId = stringValue(record.experienceId);
      const label = stringValue(record.label);
      const fitLevel = record.fitLevel;
      const confidence = record.confidence;
      if (!experienceId || !label) return null;
      if (fitLevel !== "primary" && fitLevel !== "relevant" && fitLevel !== "background") {
        return null;
      }
      if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
        return null;
      }
      return {
        experienceId,
        label,
        fitLevel,
        capabilitySummary: truncate(stringValue(record.capabilitySummary), 700),
        coreClaims: sanitizeStringList(record.coreClaims, 10),
        transferableClaims: sanitizeStringList(record.transferableClaims, 8),
        matchedRequirementIds: sanitizeStringList(record.matchedRequirementIds, 12),
        recommendedBulletThemes: sanitizeStringList(record.recommendedBulletThemes, 10),
        sourceChunkIds: sanitizeStringList(record.sourceChunkIds, 12),
        blockedClaims: sanitizeStringList(record.blockedClaims, 10),
        confidence,
      };
    })
    .filter((item): item is ExperienceCapabilityDigest => Boolean(item));
}

function mergeLlmDigests(args: {
  fallback: ExperienceCapabilityDigest[];
  llmItems: ExperienceCapabilityDigest[];
}): ExperienceCapabilityDigest[] {
  const llmById = new Map(args.llmItems.map((item) => [item.experienceId, item]));
  return args.fallback.map((fallback) => {
    const llm = llmById.get(fallback.experienceId);
    if (!llm) return fallback;
    return {
      ...fallback,
      ...llm,
      label: llm.label || fallback.label,
      coreClaims: llm.coreClaims.length ? llm.coreClaims : fallback.coreClaims,
      recommendedBulletThemes: llm.recommendedBulletThemes.length
        ? llm.recommendedBulletThemes
        : fallback.recommendedBulletThemes,
      sourceChunkIds: llm.sourceChunkIds.length ? llm.sourceChunkIds : fallback.sourceChunkIds,
      matchedRequirementIds: llm.matchedRequirementIds.length
        ? llm.matchedRequirementIds
        : fallback.matchedRequirementIds,
    };
  });
}

function getRequirements(profile: JdQualificationProfile): JdNormalizedRequirement[] {
  if (profile.requirements?.length) return profile.requirements.slice(0, 12);
  return profile.required.slice(0, 8).map((text, index) => ({
    id: `req-${index + 1}`,
    text,
    category: "experience",
    priority: 3,
    targetSections: ["summary", "experience", "skills"],
    mustHave: true,
    evidenceNeeded: "direct",
  }));
}

function extractFallbackClaims(text: string): string[] {
  const normalized = stripHtml(text);
  const bulletLike = normalized
    .split(/(?:\n|\u2022|- |\* )/)
    .map(sanitizeText)
    .filter((line) => line.length >= 24);
  const candidates = bulletLike.length
    ? bulletLike
    : normalized
        .split(/(?<=[.!?])\s+/)
        .map(sanitizeText)
        .filter((line) => line.length >= 24);
  return candidates.slice(0, 10);
}

function sanitizeStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueList(
    value
      .map((item) => (typeof item === "string" ? sanitizeText(item) : ""))
      .filter((item) => item.length > 0),
  ).slice(0, maxItems);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = sanitizeText(value);
    if (!cleaned) continue;
    const key = normalize(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      normalize(text)
        .split(/[^a-z0-9+#.-]+/)
        .filter((term) => term.length >= 4)
        .filter((term) => !STOPWORDS.has(term)),
    ),
  );
}

function sanitizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripHtml(text: string): string {
  return text
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function truncate(text: string, max: number): string {
  const cleaned = sanitizeText(text);
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 3)}...`;
}

const STOPWORDS = new Set([
  "with",
  "from",
  "that",
  "this",
  "will",
  "your",
  "have",
  "must",
  "able",
  "such",
  "work",
  "role",
  "team",
  "skills",
  "experience",
  "knowledge",
]);
