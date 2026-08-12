import type {
  JdNormalizedRequirement,
  JdQualificationProfile,
  JdRequirementEvidenceMap,
  ResumeReferenceChunk,
  SelectedResumeEvidence,
} from "@shared/types";
import type { JsonSchemaDefinition } from "./llm/types";

export interface ResumeEvidenceRerankKnowledgeHit {
  qualification: string;
  requirementId?: string;
  category?: string;
  priority?: number;
  chunks: ResumeReferenceChunk[];
}

interface EvidenceRerankResponse {
  items: JdRequirementEvidenceMap[];
}

interface EvidenceRerankLlmClient {
  callJson<T>(args: {
    model: string;
    messages: Array<{ role: "user"; content: string }>;
    jsonSchema: JsonSchemaDefinition;
    stage?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): Promise<{ success: true; data: T } | { success: false; error: string }>;
}

const EVIDENCE_RERANK_SCHEMA: JsonSchemaDefinition = {
  name: "resume_evidence_rerank",
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            requirementId: { type: "string" },
            requirement: { type: "string" },
            fit: {
              type: "string",
              enum: ["direct", "transferable", "weak", "unsupported"],
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
            selectedChunkIds: {
              type: "array",
              items: { type: "string" },
            },
            reason: { type: "string" },
            allowedClaims: {
              type: "array",
              items: { type: "string" },
            },
            blockedClaims: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: [
            "requirementId",
            "requirement",
            "fit",
            "confidence",
            "selectedChunkIds",
            "reason",
            "allowedClaims",
            "blockedClaims",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

export async function rerankSelectedResumeEvidence(args: {
  llm: EvidenceRerankLlmClient;
  model: string;
  qualificationProfile: JdQualificationProfile;
  knowledgeHits: ResumeEvidenceRerankKnowledgeHit[];
  fallbackSelectedEvidence: SelectedResumeEvidence[];
}): Promise<SelectedResumeEvidence[]> {
  const candidateCount = args.knowledgeHits.reduce(
    (sum, hit) => sum + hit.chunks.length,
    0,
  );
  if (candidateCount === 0) return args.fallbackSelectedEvidence;

  const result = await args.llm.callJson<EvidenceRerankResponse>({
    model: args.model,
    messages: [
      {
        role: "user",
        content: buildEvidenceRerankPrompt({
          qualificationProfile: args.qualificationProfile,
          knowledgeHits: args.knowledgeHits,
        }),
      },
    ],
    jsonSchema: EVIDENCE_RERANK_SCHEMA,
    stage: "evidence_rerank",
    metadata: { generatedVisibleContent: false },
  });

  if (!result.success) {
    return args.fallbackSelectedEvidence.map((item) => ({
      ...item,
      reason: [item.reason, `LLM evidence rerank unavailable: ${result.error}`]
        .filter(Boolean)
        .join(" "),
      confidence: "low",
    }));
  }

  return applyEvidenceRerank({
    qualificationProfile: args.qualificationProfile,
    knowledgeHits: args.knowledgeHits,
    fallbackSelectedEvidence: args.fallbackSelectedEvidence,
    maps: sanitizeEvidenceRerankResponse(result.data),
  });
}

function buildEvidenceRerankPrompt(args: {
  qualificationProfile: JdQualificationProfile;
  knowledgeHits: ResumeEvidenceRerankKnowledgeHit[];
}): string {
  const requirements = getTopNormalizedRequirements(args.qualificationProfile);
  const candidateBlocks = args.knowledgeHits
    .filter((hit) => hit.chunks.length > 0)
    .map((hit) => {
      const requirement = requirements.find(
        (item) =>
          item.id === hit.requirementId || item.text === hit.qualification,
      );
      const chunks = hit.chunks
        .slice(0, 16)
        .map(
          (chunk) =>
            `  - chunkId=${chunk.id} | cluster=${chunk.clusterId ?? "none"} | ${chunk.fileName} > ${chunk.section}: ${truncate(chunk.rawText ?? chunk.text, 260)}`,
        )
        .join("\n");
      return [
        `Requirement ${requirement?.id ?? hit.requirementId ?? hit.qualification}: ${hit.qualification}`,
        `Category: ${requirement?.category ?? hit.category ?? "experience"} | mustHave: ${requirement?.mustHave ? "yes" : "no"}`,
        "Candidate chunks:",
        chunks,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "You are selecting resume evidence for truthful JD tailoring.",
    "Classify whether historical resume chunks support each JD requirement.",
    "Use fit=direct only if a chunk clearly supports the same work, tool, domain, or qualification.",
    "Use fit=transferable only if a chunk supports an adjacent capability that can be worded softly.",
    "Use fit=weak for keyword-only or ambiguous matches. Use unsupported when nothing supports it.",
    "For direct/transferable, select at most 3 chunk IDs. For weak/unsupported, select no chunks.",
    "allowedClaims must be short phrases the resume may truthfully say. blockedClaims must name claims that would be overreach.",
    "",
    "REQUIREMENTS:",
    requirements
      .map(
        (item) =>
          `- ${item.id} | ${item.category} | priority=${item.priority} | mustHave=${item.mustHave ? "yes" : "no"} | ${item.text}`,
      )
      .join("\n"),
    "",
    "CANDIDATE EVIDENCE:",
    candidateBlocks || "No candidate evidence.",
  ].join("\n");
}

function sanitizeEvidenceRerankResponse(
  value: Partial<EvidenceRerankResponse> | undefined,
): JdRequirementEvidenceMap[] {
  const items = Array.isArray(value?.items) ? value.items : [];
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as unknown as Record<string, unknown>;
      const fit = record.fit;
      const confidence = record.confidence;
      if (
        fit !== "direct" &&
        fit !== "transferable" &&
        fit !== "weak" &&
        fit !== "unsupported"
      ) {
        return null;
      }
      if (
        confidence !== "high" &&
        confidence !== "medium" &&
        confidence !== "low"
      ) {
        return null;
      }
      const requirementId =
        typeof record.requirementId === "string"
          ? record.requirementId.trim()
          : "";
      const requirement =
        typeof record.requirement === "string" ? record.requirement.trim() : "";
      if (!requirementId || !requirement) return null;
      const selectedChunkIds = Array.isArray(record.selectedChunkIds)
        ? Array.from(
            new Set(
              record.selectedChunkIds
                .filter((id): id is string => typeof id === "string")
                .map((id) => id.trim())
                .filter(Boolean),
            ),
          ).slice(0, 3)
        : [];
      const allowedClaims = sanitizeClaimList(record.allowedClaims);
      const blockedClaims = sanitizeClaimList(record.blockedClaims);
      return {
        requirementId,
        requirement,
        fit,
        confidence,
        selectedChunkIds,
        reason:
          typeof record.reason === "string"
            ? truncate(record.reason.trim(), 500)
            : "",
        allowedClaims,
        blockedClaims,
      };
    })
    .filter((item): item is JdRequirementEvidenceMap => Boolean(item));
}

function applyEvidenceRerank(args: {
  qualificationProfile: JdQualificationProfile;
  knowledgeHits: ResumeEvidenceRerankKnowledgeHit[];
  fallbackSelectedEvidence: SelectedResumeEvidence[];
  maps: JdRequirementEvidenceMap[];
}): SelectedResumeEvidence[] {
  const mapsByRequirement = new Map<string, JdRequirementEvidenceMap>();
  for (const map of args.maps) {
    mapsByRequirement.set(map.requirementId, map);
    mapsByRequirement.set(normalizeComparable(map.requirement), map);
  }
  const chunksByRequirement = new Map(
    args.knowledgeHits.map((hit) => [
      hit.requirementId ?? normalizeComparable(hit.qualification),
      hit.chunks,
    ]),
  );
  const allChunks = new Map(
    args.knowledgeHits.flatMap((hit) =>
      hit.chunks.map((chunk) => [chunk.id, chunk] as const),
    ),
  );

  return getTopNormalizedRequirements(args.qualificationProfile).map(
    (requirement) => {
      const fallback =
        args.fallbackSelectedEvidence.find(
          (item) =>
            item.requirementId === requirement.id ||
            normalizeComparable(item.requirement) ===
              normalizeComparable(requirement.text),
        ) ??
        ({
          requirement: requirement.text,
          requirementId: requirement.id,
          category: requirement.category,
          priority: requirement.priority,
          status: "no_evidence",
          fit: "unsupported",
          confidence: "low",
          chunks: [],
        } satisfies SelectedResumeEvidence);
      const map =
        mapsByRequirement.get(requirement.id) ??
        mapsByRequirement.get(normalizeComparable(requirement.text));
      if (!map) return fallback;
      const candidateChunks =
        chunksByRequirement.get(requirement.id) ??
        chunksByRequirement.get(normalizeComparable(requirement.text)) ??
        [];
      const selectedRawChunks = map.selectedChunkIds
        .map((id) => allChunks.get(id))
        .filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk))
        .filter((chunk) =>
          candidateChunks.some((candidate) => candidate.id === chunk.id),
        );
      const allowedFit = map.fit === "direct" || map.fit === "transferable";
      const chunks = allowedFit
        ? selectedRawChunks.slice(0, 3).map((chunk) => ({
            chunkId: chunk.id,
            clusterId: chunk.clusterId,
            evidenceGroupId: chunk.evidenceGroupId,
            evidenceGroupLabel: chunk.evidenceGroupLabel,
            experienceAnchorId: chunk.experienceAnchorId,
            sourceFile: chunk.fileName,
            relativePath: chunk.relativePath,
            section: chunk.section,
            roleFamily: chunk.roleFamily,
            rawText: chunk.rawText ?? chunk.text,
            keywords: chunk.keywords,
            qualitySignals: chunk.qualitySignals,
            claimType: chunk.claimType,
            anchorSection: chunk.anchorSection,
            sourceQuality: chunk.sourceQuality,
            fit: map.fit,
            confidence: map.confidence,
          }))
        : [];
      const status =
        map.fit === "direct" && chunks.length
          ? "selected"
          : map.fit === "transferable" && chunks.length
            ? "transferable_only"
            : map.fit === "weak"
              ? "weak_evidence"
              : "no_evidence";
      return {
        requirement: requirement.text,
        requirementId: requirement.id,
        category: requirement.category,
        priority: requirement.priority,
        status,
        fit: chunks.length
          ? map.fit
          : map.fit === "weak"
            ? "weak"
            : "unsupported",
        confidence: map.confidence,
        chunks,
        missingReason:
          status === "no_evidence" || status === "weak_evidence"
            ? map.reason || "LLM rerank did not select usable evidence."
            : undefined,
        reason: map.reason,
        allowedClaims:
          status === "selected" || status === "transferable_only"
            ? map.allowedClaims
            : [],
        blockedClaims: map.blockedClaims.length
          ? map.blockedClaims
          : [`Do not claim ${requirement.text} without direct evidence.`],
        candidateChunkCount: candidateChunks.length,
        sourceClusterIds: Array.from(
          new Set(chunks.map((chunk) => chunk.clusterId).filter(Boolean)),
        ) as string[],
      };
    },
  );
}

function getTopNormalizedRequirements(
  profile: JdQualificationProfile,
): JdNormalizedRequirement[] {
  const explicitRequirements = Array.isArray(profile.requirements)
    ? profile.requirements
    : [];
  if (explicitRequirements.length > 0) {
    return explicitRequirements
      .slice()
      .sort(
        (a, b) =>
          Number(b.mustHave) - Number(a.mustHave) || b.priority - a.priority,
      )
      .slice(0, 12);
  }

  const items: JdNormalizedRequirement[] = [];
  let priority = 100;
  for (const text of profile.required.slice(0, 8)) {
    items.push({
      id: `req-required-${items.length + 1}`,
      text,
      category: "experience",
      priority: priority--,
      targetSections: ["experience", "skills"],
      mustHave: true,
      evidenceNeeded: "direct",
    });
  }
  for (const text of profile.preferred.slice(0, 4)) {
    items.push({
      id: `req-preferred-${items.length + 1}`,
      text,
      category: "experience",
      priority: priority--,
      targetSections: ["experience", "skills"],
      mustHave: false,
      evidenceNeeded: "transferable",
    });
  }
  return items.slice(0, 12);
}

function sanitizeClaimList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((claim): claim is string => typeof claim === "string")
        .map((claim) => claim.trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
}

function normalizeComparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
