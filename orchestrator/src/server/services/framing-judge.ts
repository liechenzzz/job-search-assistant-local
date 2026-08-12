/**
 * Framing Bridge Judge — v1a.
 *
 * Generates candidate framings from existing preparation data and judges
 * their legality (evidence support) and relevance (JD fit) via LLM.
 * Not yet connected to the pipeline — produces FramingJudgeResult only.
 */

import { logger } from "@infra/logger";
import type {
  CandidateKind,
  CandidateSource,
  ExperienceAnchorSummary,
  ExperienceCapabilityDigest,
  ExtractedClaim,
  FramingCandidate,
  FramingDecision,
  FramingJudgeResult,
  JdNormalizedRequirement,
  ResumeCoveragePlan,
  ResumeCoveragePlanItem,
  SelectedResumeEvidence,
} from "@shared/types";
import type { JsonSchemaDefinition } from "./llm/types";

// -- LLM client interface (minimal, matches callJson) --

export interface FramingJudgeLlmClient {
  callJson<T>(options: {
    model: string;
    messages: Array<{ role: "user" | "system"; content: string }>;
    jsonSchema: JsonSchemaDefinition;
    stage?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): Promise<{ success: true; data: T } | { success: false; error: string }>;
}

// -- Input types --

export interface FramingJudgeInput {
  selectedEvidence: SelectedResumeEvidence[];
  experienceAnchors: ExperienceAnchorSummary[];
  experienceDigests: ExperienceCapabilityDigest[];
  coveragePlan: ResumeCoveragePlan;
  jdRequirements: JdNormalizedRequirement[];
  /** v1: empty until Step 5 persistence exists */
  framingMemory?: Array<{
    experienceAnchorId: string;
    entries: Array<{ normalizedFraming: string; status: string }>;
  }>;
}

/** Evidence context bundled with each candidate for judge prompt injection */
export interface CandidateEvidenceContext {
  experienceId: string;
  /** Anchor summary: responsibility areas, tools, domains, stakeholders */
  anchorFacts: {
    responsibilityAreas: string[];
    toolsAndMethods: string[];
    domains: string[];
    stakeholders: string[];
    measurableOutcomes: string[];
    transferableStrengths: string[];
  };
  /** Digest core + transferable claims */
  digestClaims: { core: string[]; transferable: string[] };
  /** Up to 3 selected evidence chunk texts for this experience */
  evidenceSnippets: Array<{ chunkId: string; rawText: string }>;
}

// -- JSON Schema for LLM judge output --

type JudgeResponseItem = {
  framing: string;
  claimScope: "framing" | "audience" | "domain" | "method" | "output";
  experienceId: string;
  requirementIds: string[];
  legality: "allowed" | "blocked" | "uncertain";
  relevantToCurrentJd: boolean;
  jdPhrasesSupportingRelevance: string[];
  evidenceIdsSupportingLegality: string[];
  risk: "low" | "medium" | "high";
  rationale: string;
};

type JudgeResponse = { items: JudgeResponseItem[] };

const FRAMING_JUDGE_SCHEMA: JsonSchemaDefinition = {
  name: "framing_judge",
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            framing: { type: "string" },
            claimScope: {
              type: "string",
              enum: ["framing", "audience", "domain", "method", "output"],
            },
            experienceId: { type: "string" },
            requirementIds: {
              type: "array",
              items: { type: "string" },
            },
            legality: {
              type: "string",
              enum: ["allowed", "blocked", "uncertain"],
            },
            relevantToCurrentJd: { type: "boolean" },
            jdPhrasesSupportingRelevance: {
              type: "array",
              items: { type: "string" },
            },
            evidenceIdsSupportingLegality: {
              type: "array",
              items: { type: "string" },
            },
            risk: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
            rationale: { type: "string" },
          },
          required: [
            "framing",
            "claimScope",
            "experienceId",
            "requirementIds",
            "legality",
            "relevantToCurrentJd",
            "jdPhrasesSupportingRelevance",
            "evidenceIdsSupportingLegality",
            "risk",
            "rationale",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

// -- Candidate kind classifier --

const FRAMING_KEYWORDS = new Set([
  "market intelligence",
  "market research",
  "market opportunity",
  "market analysis",
  "sector analysis",
  "sector research",
  "sector opportunity",
  "competitive",
  "landscape",
  "industry analysis",
  "industry trends",
  "policy research",
  "policy analysis",
  "program evaluation",
  "stakeholder engagement",
  "stakeholder management",
  "client relationship",
  "client management",
  "partner coordination",
  "cross-functional",
  "strategy",
  "strategic",
  "innovation",
  "advisory",
  "consulting",
  "research",
  "analytics",
  "data analysis",
  "data-driven",
  "evidence-based",
  "reporting",
  "communications",
  "program support",
  "performance measurement",
  "kpi",
  "monitoring",
]);

const AUDIENCE_KEYWORDS = new Set([
  "client",
  "clients",
  "stakeholder",
  "stakeholders",
  "startups",
  "startup",
  "public-sector",
  "public sector",
  "government",
  "municipal",
  "healthcare",
  "enterprise",
  "executive",
  "senior",
  "leadership",
  "board",
  "investor",
  "partner",
  "vendor",
  "customer",
  "patient",
  "physician",
  "clinical",
]);

const DOMAIN_KEYWORDS = new Set([
  "healthcare",
  "health",
  "clinical",
  "medical",
  "pharma",
  "biotech",
  "workforce",
  "labour",
  "labor",
  "economic",
  "finance",
  "financial",
  "investment",
  "banking",
  "insurance",
  "education",
  "technology",
  "tech",
  "software",
  "manufacturing",
  "retail",
  "energy",
  "government",
  "public policy",
  "defense",
  "nonprofit",
  "social",
]);

const METHOD_KEYWORDS = new Set([
  "excel",
  "python",
  "sql",
  "power bi",
  "tableau",
  "sas",
  "spss",
  "stata",
  "regression",
  "statistical",
  "modeling",
  "survey",
  "interview",
  "focus group",
  "literature review",
  "systematic review",
  "meta-analysis",
  "qualitative",
  "quantitative",
  "mixed methods",
  "gis",
  "qgis",
  "arcgis",
  "visualization",
  "machine learning",
  "data mining",
  "forecasting",
]);

const OUTPUT_KEYWORDS = new Set([
  "report",
  "dashboard",
  "presentation",
  "briefing note",
  "memo",
  "thesis",
  "white paper",
  "policy brief",
  "executive summary",
  "model",
  "framework",
  "toolkit",
  "playbook",
  "recommendation",
  "roadmap",
  "metric",
  "benchmark",
  "deliverable",
]);

/**
 * Deterministic classifier for candidate claims.
 * Rules (priority order):
 * 1. Framing keywords first (explicit JD/domain labels) → "framing"
 * 2. Audience keywords → "audience"
 * 3. Method keywords → "method"
 * 4. Output keywords → "output"
 * 5. Domain keywords → "domain"
 * 6. Ambiguous → returns undefined (not eligible for activation pool)
 */
export function classifyCandidateKind(text: string): CandidateKind | undefined {
  const lower = text.toLowerCase().trim();
  if (!lower || lower.length < 3) return undefined;

  // Priority: framing > output > method > audience > domain
  // Framing first — explicit JD-domain labels. Output before audience/method
  // to handle "dashboard" (output) not matching "board" (audience keyword).
  if (containsKeyword(lower, FRAMING_KEYWORDS)) return "framing";
  if (containsKeyword(lower, OUTPUT_KEYWORDS)) return "output";
  if (containsKeyword(lower, METHOD_KEYWORDS)) return "method";
  if (containsKeyword(lower, AUDIENCE_KEYWORDS)) return "audience";
  if (containsKeyword(lower, DOMAIN_KEYWORDS)) return "domain";

  // Ambiguous — not eligible for activation
  return undefined;
}

function containsKeyword(text: string, keywords: Set<string>): boolean {
  for (const kw of keywords) {
    // Whole-word or whole-phrase matching
    if (kw.length === 1) {
      // Single-letter keyword: must appear as a standalone word
      if (new RegExp(`\\b${escapeRegex(kw)}\\b`, "i").test(text)) return true;
    } else if (text.includes(kw)) {
      return true;
    }
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -- Candidate generation --

export function generateFramingCandidates(input: FramingJudgeInput): {
  activationCandidates: FramingCandidate[];
  blockCheckCandidates: FramingCandidate[];
} {
  const activationCandidates: FramingCandidate[] = [];
  const blockCheckCandidates: FramingCandidate[] = [];
  const seen = new Set<string>();

  const addCandidate = (
    c: FramingCandidate,
    pool: "activation" | "block_check",
  ) => {
    const key = `${c.experienceId}|${c.text}|${c.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (pool === "activation") activationCandidates.push(c);
    else blockCheckCandidates.push(c);
  };

  // Source 1: Persisted memory (v1: empty, code path handles empty array)
  const memoryEntries = input.framingMemory ?? [];
  for (const mem of memoryEntries) {
    // Only observed/approved framings from memory become candidates
    const status = mem.entries[0]?.status;
    if (status !== "observed" && status !== "approved") continue;
    for (const entry of mem.entries) {
      if (entry.status !== "observed" && entry.status !== "approved") continue;
      const kind = classifyCandidateKind(entry.normalizedFraming);
      if (!kind) continue;
      addCandidate(
        {
          text: entry.normalizedFraming,
          kind,
          experienceId: mem.experienceAnchorId,
          requirementIds: [],
          source: "memory",
          evidenceChunkIds: [],
        },
        kind === "framing" ? "activation" : "block_check",
      );
    }
  }

  // Source 2: Experience digests
  for (const digest of input.experienceDigests) {
    for (const claim of digest.transferableClaims) {
      const kind = classifyCandidateKind(claim);
      if (!kind) continue;
      addCandidate(
        {
          text: claim,
          kind,
          experienceId: digest.experienceId,
          requirementIds: digest.matchedRequirementIds,
          source: "digest",
          evidenceChunkIds: digest.sourceChunkIds,
        },
        kind === "framing" ? "activation" : "block_check",
      );
    }
    // Explicit blocked claims from digest — direct to block-check
    for (const blocked of digest.blockedClaims) {
      const kind = classifyCandidateKind(blocked) ?? "framing";
      addCandidate(
        {
          text: blocked,
          kind,
          experienceId: digest.experienceId,
          requirementIds: digest.matchedRequirementIds,
          source: "digest",
          evidenceChunkIds: digest.sourceChunkIds,
          preBlocked: true,
        },
        "block_check",
      );
    }
  }

  // Source 3: Selected evidence
  for (const evidence of input.selectedEvidence) {
    const expId = findExperienceIdForEvidence(
      evidence,
      input.experienceAnchors,
    );
    const reqId = evidence.requirementId;

    // allowedClaims — classify and route
    for (const claim of evidence.allowedClaims ?? []) {
      const kind = classifyCandidateKind(claim);
      if (!kind) continue;
      addCandidate(
        {
          text: claim,
          kind,
          experienceId: expId,
          requirementIds: reqId ? [reqId] : [],
          source: "selected_evidence",
          evidenceChunkIds: evidence.chunks.map((c) => c.chunkId),
        },
        kind === "framing" ? "activation" : "block_check",
      );
    }
    // blockedClaims — direct to block-check, preBlocked
    for (const blocked of evidence.blockedClaims ?? []) {
      const kind = classifyCandidateKind(blocked) ?? "framing";
      addCandidate(
        {
          text: blocked,
          kind,
          experienceId: expId,
          requirementIds: reqId ? [reqId] : [],
          source: "selected_evidence",
          evidenceChunkIds: evidence.chunks.map((c) => c.chunkId),
          preBlocked: true,
        },
        "block_check",
      );
    }
  }

  // Source 4: Coverage plan
  for (const item of input.coveragePlan.items) {
    const expId = findExperienceIdForCoverageItem(
      item,
      input.experienceAnchors,
    );
    for (const hint of item.allowedWordingHints) {
      const kind = classifyCandidateKind(hint);
      if (!kind) continue;
      addCandidate(
        {
          text: hint,
          kind,
          experienceId: expId,
          requirementIds: [],
          source: "coverage_plan",
          evidenceChunkIds: item.evidenceSources,
        },
        kind === "framing" ? "activation" : "block_check",
      );
    }
  }

  // Source 5: JD requirement phrases
  for (const req of input.jdRequirements) {
    const phrases = extractNounPhrases(req.text);
    for (const jdPhrase of phrases.slice(0, 5)) {
      const hasHighRisk = containsDomainSpecificity(jdPhrase);
      // Expand to per-experience
      for (const anchor of input.experienceAnchors) {
        const kind = classifyCandidateKind(jdPhrase) ?? "framing";
        addCandidate(
          {
            text: jdPhrase,
            kind,
            experienceId: anchor.experienceAnchorId,
            requirementIds: [req.id],
            source: "jd_phrase",
            evidenceChunkIds: [],
            jdPhrase,
            defaultRisk: hasHighRisk ? "high" : undefined,
          },
          kind === "framing" ? "activation" : "block_check",
        );
      }
    }
  }

  // Apply caps
  return {
    activationCandidates: capCandidates(activationCandidates, 12, 60),
    blockCheckCandidates: capCandidates(blockCheckCandidates, 12, 60),
  };
}

// -- Bridge judge --

export async function judgeFramingCandidates(args: {
  llm: FramingJudgeLlmClient;
  model: string;
  input: FramingJudgeInput;
  /** Optional: pre-generated candidates. If absent, candidates are generated from input. */
  candidates?: {
    activationCandidates: FramingCandidate[];
    blockCheckCandidates: FramingCandidate[];
  };
}): Promise<FramingJudgeResult> {
  const { activationCandidates, blockCheckCandidates } =
    args.candidates ?? generateFramingCandidates(args.input);

  const allCandidates = [...activationCandidates, ...blockCheckCandidates];

  if (allCandidates.length === 0) {
    return emptyResult();
  }

  // Build evidence context for each experience (for prompt injection)
  const evidenceContexts = buildEvidenceContexts(
    args.input.experienceAnchors,
    args.input.experienceDigests,
    args.input.selectedEvidence,
  );

  // Separate pre-blocked from judge-needed
  const preBlocked = allCandidates.filter((c) => c.preBlocked);
  const judgeNeeded = allCandidates.filter((c) => !c.preBlocked);

  let llmDecisions: FramingDecision[] = [];
  if (judgeNeeded.length > 0) {
    try {
      const result = await args.llm.callJson<JudgeResponse>({
        model: args.model,
        messages: [
          {
            role: "user",
            content: buildFramingJudgePrompt(
              judgeNeeded,
              args.input.jdRequirements,
              evidenceContexts,
            ),
          },
        ],
        jsonSchema: FRAMING_JUDGE_SCHEMA,
        stage: "framing_judge",
        metadata: { generatedVisibleContent: false },
      });
      if (result?.success) {
        llmDecisions = result.data.items.map(sanitizeJudgeItem);
      } else {
        logger.warn("Framing judge LLM call failed", {
          error:
            (result as { error?: string } | undefined)?.error ?? "no response",
        });
      }
    } catch (error) {
      logger.warn("Framing judge threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Convert pre-blocked candidates to decisions
  const preBlockedDecisions: FramingDecision[] = preBlocked.map((c) => ({
    framing: c.text,
    claimScope: toClaimScope(c.kind),
    experienceId: c.experienceId,
    requirementIds: c.requirementIds,
    legality: "blocked" as const,
    relevantToCurrentJd: false,
    jdPhrasesSupportingRelevance: [],
    evidenceIdsSupportingLegality: c.evidenceChunkIds,
    risk: c.defaultRisk ?? "medium",
    rationale: "Explicitly blocked by evidence source",
  }));

  const allDecisions = [...preBlockedDecisions, ...llmDecisions];

  // Handle uncertain: check which candidates were in activation pool
  const activationTexts = new Set(
    activationCandidates.map((c) => `${c.experienceId}|${c.text}`),
  );
  for (const decision of allDecisions) {
    if (decision.legality !== "uncertain") continue;
    const key = `${decision.experienceId}|${decision.framing}`;
    if (activationTexts.has(key)) {
      // Uncertain activation → inactive (not activeFramings)
      decision.legality = "blocked";
      decision.risk = "medium";
    }
    // Uncertain block-check → stays allowedClaims with low risk (handled in assembly)
  }

  return assembleResult(allDecisions, activationCandidates);
}

// -- Helpers: assembling result --

function assembleResult(
  decisions: FramingDecision[],
  activationCandidates: FramingCandidate[],
): FramingJudgeResult {
  const activationTexts = new Set(
    activationCandidates.map((c) => `${c.experienceId}|${c.text}|${c.kind}`),
  );

  const activeFramingsByExperience: Record<string, FramingDecision[]> = {};
  const allowedClaimsByExperience: Record<string, FramingDecision[]> = {};
  const blockedByExperience: Record<string, FramingDecision[]> = {};
  const activeFramingsSet = new Set<string>();
  const blockedClaimsSet = new Set<string>();

  for (const d of decisions) {
    const isActivation =
      d.claimScope === "framing" &&
      activationTexts.has(`${d.experienceId}|${d.framing}|${d.claimScope}`);

    if (
      isActivation &&
      d.legality === "allowed" &&
      d.relevantToCurrentJd &&
      d.evidenceIdsSupportingLegality.length > 0 &&
      d.jdPhrasesSupportingRelevance.length > 0
    ) {
      if (!activeFramingsByExperience[d.experienceId]) {
        activeFramingsByExperience[d.experienceId] = [];
      }
      activeFramingsByExperience[d.experienceId].push(d);
      activeFramingsSet.add(d.framing);
    }

    if (d.legality === "allowed") {
      if (!allowedClaimsByExperience[d.experienceId]) {
        allowedClaimsByExperience[d.experienceId] = [];
      }
      allowedClaimsByExperience[d.experienceId].push(d);
    }

    if (d.legality === "blocked") {
      if (!blockedByExperience[d.experienceId]) {
        blockedByExperience[d.experienceId] = [];
      }
      blockedByExperience[d.experienceId].push(d);
      blockedClaimsSet.add(d.framing);
    }
  }

  return {
    decisions,
    activeFramingsByExperience,
    allowedClaimsByExperience,
    blockedByExperience,
    activeFramings: [...activeFramingsSet],
    blockedClaims: [...blockedClaimsSet],
    summary: {
      totalJudged: decisions.length,
      activeFramings: activeFramingsSet.size,
      blocked: blockedClaimsSet.size,
      highRisk: decisions.filter((d) => d.risk === "high").length,
    },
  };
}

function emptyResult(): FramingJudgeResult {
  return {
    decisions: [],
    activeFramingsByExperience: {},
    allowedClaimsByExperience: {},
    blockedByExperience: {},
    activeFramings: [],
    blockedClaims: [],
    summary: { totalJudged: 0, activeFramings: 0, blocked: 0, highRisk: 0 },
  };
}

// -- Helpers: evidence context --

function buildEvidenceContexts(
  anchors: ExperienceAnchorSummary[],
  digests: ExperienceCapabilityDigest[],
  selectedEvidence: SelectedResumeEvidence[],
): Map<string, CandidateEvidenceContext> {
  const map = new Map<string, CandidateEvidenceContext>();
  for (const anchor of anchors) {
    const digest = digests.find(
      (d) => d.experienceId === anchor.experienceAnchorId,
    );
    const evidenceSnippets = selectedEvidence
      .flatMap((ev) => ev.chunks)
      .filter((ch) => ch.experienceAnchorId === anchor.experienceAnchorId)
      .slice(0, 3)
      .map((ch) => ({
        chunkId: ch.chunkId,
        rawText: ch.rawText.slice(0, 300),
      }));

    map.set(anchor.experienceAnchorId, {
      experienceId: anchor.experienceAnchorId,
      anchorFacts: {
        responsibilityAreas: anchor.responsibilityAreas.map((a) => a.text),
        toolsAndMethods: anchor.toolsAndMethods.map((a) => a.text),
        domains: anchor.domains.map((a) => a.text),
        stakeholders: anchor.stakeholders.map((a) => a.text),
        measurableOutcomes: anchor.measurableOutcomes.map((a) => a.text),
        transferableStrengths: anchor.transferableStrengths.map((a) => a.text),
      },
      digestClaims: {
        core: digest?.coreClaims ?? [],
        transferable: digest?.transferableClaims ?? [],
      },
      evidenceSnippets,
    });
  }
  return map;
}

// -- Helpers: prompt building --

function buildFramingJudgePrompt(
  candidates: FramingCandidate[],
  jdRequirements: JdNormalizedRequirement[],
  evidenceContexts: Map<string, CandidateEvidenceContext>,
): string {
  // Group candidates by experience for evidence context
  const byExperience = new Map<string, FramingCandidate[]>();
  for (const c of candidates) {
    const list = byExperience.get(c.experienceId) ?? [];
    list.push(c);
    byExperience.set(c.experienceId, list);
  }

  const sections: string[] = [];
  for (const [expId, expCandidates] of byExperience) {
    const ctx = evidenceContexts.get(expId);
    const evidenceBlock = ctx
      ? [
          "",
          `--- EVIDENCE FOR ${expId} ---`,
          `Responsibilities: ${ctx.anchorFacts.responsibilityAreas.slice(0, 5).join("; ") || "none"}`,
          `Tools/Methods: ${ctx.anchorFacts.toolsAndMethods.slice(0, 5).join("; ") || "none"}`,
          `Domains: ${ctx.anchorFacts.domains.slice(0, 3).join("; ") || "none"}`,
          `Stakeholders: ${ctx.anchorFacts.stakeholders.slice(0, 3).join("; ") || "none"}`,
          `Outcomes: ${ctx.anchorFacts.measurableOutcomes.slice(0, 3).join("; ") || "none"}`,
          `Transferable: ${ctx.anchorFacts.transferableStrengths.slice(0, 3).join("; ") || "none"}`,
          `Core claims: ${ctx.digestClaims.core.slice(0, 4).join("; ") || "none"}`,
          `Transferable claims: ${ctx.digestClaims.transferable.slice(0, 4).join("; ") || "none"}`,
          `Evidence chunks: ${ctx.evidenceSnippets.map((s) => `[${s.chunkId}] ${s.rawText.slice(0, 200)}`).join("\n  ") || "none"}`,
          `--- END EVIDENCE ---`,
        ].join("\n")
      : `[No evidence context for ${expId}]`;

    const candidateLines = expCandidates.map((c) => {
      const riskNote = c.defaultRisk ? ` [defaultRisk: ${c.defaultRisk}]` : "";
      const preBlockedNote = c.preBlocked ? " [EXPLICITLY BLOCKED]" : "";
      return `- "${c.text}" (kind: ${c.kind}, reqs: [${c.requirementIds.join(", ")}], source: ${c.source}${riskNote}${preBlockedNote})`;
    });

    sections.push(
      evidenceBlock,
      "",
      `Candidates for ${expId}:`,
      candidateLines.join("\n"),
    );
  }

  const jdLines = jdRequirements.map(
    (r) =>
      `- [${r.id}] ${r.text} (mustHave: ${r.mustHave}, priority: ${r.priority})`,
  );

  return [
    "You are a candidate claim legality + relevance judge, not a resume writer.",
    "For each candidate claim, determine (1) whether evidence supports it,",
    "and (2) whether this JD needs it.",
    "",
    "CLAIM SCOPES: framing, audience, domain, method, output.",
    "- Framing candidates that pass both checks may enter allowedTranslations.",
    "- Block-check candidates (all scopes) that are blocked enter blockedClaims.",
    "- Block-check candidates that pass become allowedClaims (verifier reference).",
    "",
    "APPROVE (legality=allowed) only when ALL of:",
    "1. The claim is supported by the cited evidence chunks.",
    "   For framing claims: the analytical action must be equivalent",
    '   ("workforce sector analysis" can become "market sector analysis"',
    "   if the analytical method is the same). Domain labels can differ.",
    "2. The claim does not upgrade specificity beyond evidence:",
    "   - Method/tool not inflated (Excel stays Excel)",
    '   - Audience not made more specific ("public-sector clients" must not',
    '     become "healthcare startups" without evidence)',
    '   - Output not upgraded ("briefing" must not become "investment thesis")',
    "   - Role ownership not inflated (supported must not become led)",
    "",
    "BLOCK (legality=blocked) when:",
    "- The claim introduces a domain, audience, method, or output absent from evidence",
    "- It adds specificity or upgrades role beyond evidence",
    "- Explicitly pre-blocked candidates MUST return legality=blocked",
    "",
    "When uncertain:",
    "- For activation candidates (kind=framing, not pre-blocked): prefer blocked.",
    "- For block-check candidates: uncertain is acceptable as allowed with low confidence.",
    "",
    "RELEVANCE (judged separately, same call, distinct field):",
    "- Mark relevant ONLY if the JD explicitly asks for this or a close concept.",
    "  Cite exact JD phrase(s) in jdPhrasesSupportingRelevance.",
    "- Do NOT mark relevant because a claim sounds impressive.",
    "- Each relevance decision must cite at least one JD phrase.",
    "- Relevance gates activeFramingsByExperience (framing + allowed + relevant).",
    "  allowedClaimsByExperience includes claims regardless of relevance.",
    "",
    "INPUT — JD QUALIFICATIONS:",
    jdLines.join("\n"),
    "",
    `INPUT — EVIDENCE & CANDIDATES (${candidates.length} to judge):`,
    sections.join("\n"),
    "",
    "Return JSON with an items array. Judge EVERY candidate.",
  ].join("\n");
}

function sanitizeJudgeItem(item: Partial<JudgeResponseItem>): FramingDecision {
  const claimScope = (
    ["framing", "audience", "domain", "method", "output"] as const
  ).includes(item.claimScope as never)
    ? (item.claimScope as FramingDecision["claimScope"])
    : "framing";

  const legality = (["allowed", "blocked", "uncertain"] as const).includes(
    item.legality as never,
  )
    ? (item.legality as FramingDecision["legality"])
    : "uncertain";

  const risk = (["low", "medium", "high"] as const).includes(item.risk as never)
    ? (item.risk as FramingDecision["risk"])
    : "medium";

  return {
    framing: String(item.framing ?? "").slice(0, 200),
    claimScope,
    experienceId: String(item.experienceId ?? ""),
    requirementIds: (Array.isArray(item.requirementIds)
      ? item.requirementIds.map(String)
      : []
    ).slice(0, 10),
    legality,
    relevantToCurrentJd: Boolean(item.relevantToCurrentJd),
    jdPhrasesSupportingRelevance: (Array.isArray(
      item.jdPhrasesSupportingRelevance,
    )
      ? item.jdPhrasesSupportingRelevance.map(String)
      : []
    ).slice(0, 5),
    evidenceIdsSupportingLegality: (Array.isArray(
      item.evidenceIdsSupportingLegality,
    )
      ? item.evidenceIdsSupportingLegality.map(String)
      : []
    ).slice(0, 10),
    risk,
    rationale: String(item.rationale ?? "").slice(0, 500),
  };
}

// -- Helpers: noun phrase extraction from JD text --

function extractNounPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 2) return [];

  const seen = new Set<string>();
  const concise: string[] = [];
  const longer: string[] = [];

  // Extract 2-grams first (most useful), then 3-4 grams
  for (const len of [2, 3, 4]) {
    for (let i = 0; i <= words.length - len; i++) {
      const phrase = words.slice(i, i + len).join(" ");
      if (phrase.length < 8 || isStopPhrase(phrase) || seen.has(phrase))
        continue;
      seen.add(phrase);
      if (len === 2) concise.push(phrase);
      else longer.push(phrase);
    }
  }

  // Concise phrases first (most likely framing candidates), longer for context
  return [...concise, ...longer].slice(0, 10);
}

function isStopPhrase(phrase: string): boolean {
  const stops = new Set([
    "years of experience",
    "the successful candidate",
    "we are looking",
    "you will be",
    "ability to work",
    "strong communication skills",
    "excellent written and",
    "and verbal communication",
    "work in a fast",
    "in a fast paced",
    "fast paced environment",
  ]);
  return stops.has(phrase);
}

function containsDomainSpecificity(phrase: string): boolean {
  const highRisk = [
    "healthcare",
    "clinical",
    "medical",
    "pharma",
    "investment",
    "venture",
    "startup",
    "tam",
    "market sizing",
    "due diligence",
    "patient",
    "physician",
    "biotech",
  ];
  const lower = phrase.toLowerCase();
  return highRisk.some((t) => lower.includes(t));
}

// -- Helpers: caps --

function capCandidates(
  candidates: FramingCandidate[],
  perExperience: number,
  perRun: number,
): FramingCandidate[] {
  const priorityOrder: CandidateSource[] = [
    "memory",
    "selected_evidence",
    "digest",
    "coverage_plan",
    "jd_phrase",
  ];

  // Sort by priority
  const sorted = [...candidates].sort((a, b) => {
    const pa = priorityOrder.indexOf(a.source);
    const pb = priorityOrder.indexOf(b.source);
    return pa - pb;
  });

  // Per-experience cap
  const expCounts: Record<string, number> = {};
  const result: FramingCandidate[] = [];
  for (const c of sorted) {
    const count = expCounts[c.experienceId] ?? 0;
    if (count >= perExperience) continue;
    expCounts[c.experienceId] = count + 1;
    result.push(c);
  }

  // Per-run cap
  return result.slice(0, perRun);
}

// -- Helpers: experience ID mapping --

function findExperienceIdForEvidence(
  evidence: SelectedResumeEvidence,
  anchors: ExperienceAnchorSummary[],
): string {
  // Use the first chunk's experienceAnchorId
  for (const chunk of evidence.chunks) {
    if (chunk.experienceAnchorId) return chunk.experienceAnchorId;
  }
  // Fallback: match by keyword overlap with anchor identity
  for (const anchor of anchors) {
    const anchorStr =
      `${anchor.identity.company} ${anchor.identity.title}`.toLowerCase();
    if (
      evidence.requirement &&
      anchorStr.includes(evidence.requirement.toLowerCase().slice(0, 5))
    ) {
      return anchor.experienceAnchorId;
    }
  }
  return anchors[0]?.experienceAnchorId ?? "unknown";
}

function findExperienceIdForCoverageItem(
  item: ResumeCoveragePlanItem,
  anchors: ExperienceAnchorSummary[],
): string {
  // Map by evidence sources matching anchor chunk IDs
  for (const source of item.evidenceSources) {
    for (const anchor of anchors) {
      if (anchor.sourceChunkIds.includes(source)) {
        return anchor.experienceAnchorId;
      }
    }
  }
  return anchors[0]?.experienceAnchorId ?? "unknown";
}

function toClaimScope(kind: CandidateKind): FramingDecision["claimScope"] {
  if (kind === "action") return "framing"; // action isn't a bridge judge scope, fallback
  return kind;
}

// -- Claim extraction for v1c (deterministic, no LLM) --

/**
 * Extract claims from a generated bullet and check them against
 * the bridge judge's framing boundaries.
 * Deterministic — regex patterns + keyword matching. No LLM.
 */
export function extractClaims(
  bullet: string,
  framingJudgeResult?: FramingJudgeResult,
  /** Scope to a specific experience. When absent, checks all experiences (cross-experience). */
  experienceId?: string,
): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];

  // -- Action claim: leading verb phrase --
  const actionMatch = bullet.match(
    /^(Conducted|Led|Supported|Contributed to|Managed|Directed|Owned|Advised|Applied|Developed|Built|Designed|Created|Analyzed|Synthesized|Presented|Delivered|Prepared|Coordinated)\s+(.+?)(?:,|;|\.|$|\s+for\s|\s+to\s|\s+using\s|\s+across\s|\s+with\s)/i,
  );
  if (actionMatch) {
    claims.push({
      type: "action",
      text: actionMatch[0].trim(),
      verdict: "uncertain", // not verified against evidence in v1c-1
    });
  }

  // -- Method claims: tool/data keywords --
  const methodKeywords = [
    /\b(Python|SQL|Excel|Power BI|Tableau|SAS|SPSS|Stata|R\b(?!\w))/gi,
    /\b(regression|statistical\s+modeling|quantitative|qualitative|machine\s+learning|data\s+mining|forecasting)\b/gi,
    /\b(dashboard|visualization|GIS|QGIS|ArcGIS|survey|interview|focus\s+group)\b/gi,
  ];
  for (const pattern of methodKeywords) {
    let m = pattern.exec(bullet);
    while (m !== null) {
      claims.push({
        type: "method",
        text: m[0],
        verdict: "uncertain", // not verified against anchor evidence in v1c-1
      });
      m = pattern.exec(bullet);
    }
  }

  // -- Framing claims: check against THIS experience's boundaries only --
  const bulletLower = bullet.toLowerCase();
  if (framingJudgeResult) {
    const expIds = experienceId
      ? [experienceId]
      : [
          ...new Set([
            ...Object.keys(framingJudgeResult.activeFramingsByExperience),
            ...Object.keys(framingJudgeResult.blockedByExperience),
          ]),
        ];

    for (const expId of expIds) {
      const allowedTerms = new Set(
        (framingJudgeResult.activeFramingsByExperience[expId] ?? []).map((d) =>
          d.framing.toLowerCase(),
        ),
      );
      const blockedTerms = new Set(
        (framingJudgeResult.blockedByExperience[expId] ?? []).map((d) =>
          d.framing.toLowerCase(),
        ),
      );
      const allTerms = new Set([...allowedTerms, ...blockedTerms]);
      for (const term of allTerms) {
        if (!bulletLower.includes(term)) continue;
        const inAllowed = allowedTerms.has(term);
        const inBlocked = blockedTerms.has(term);
        if (inAllowed && inBlocked) {
          claims.push({
            type: "framing",
            text: term,
            verdict: "blocked",
            reason: `conflict: both allowed and blocked for ${expId}`,
          });
        } else if (inAllowed) {
          claims.push({
            type: "framing",
            text: term,
            verdict: "pass",
            reason: `allowed for ${expId}`,
          });
        } else {
          claims.push({
            type: "framing",
            text: term,
            verdict: "blocked",
            reason: `blocked for ${expId}`,
          });
        }
      }
    }

    // -- Audience claims: check against THIS experience's blockedByExperience --
    const audienceMatch = bullet.match(
      /\b(?:for|to)\s+([a-z\s]+?(?:clients?|stakeholders?|startups?|ventures?|organizations?|teams?))\b/i,
    );
    if (audienceMatch) {
      const audienceText = audienceMatch[1].trim();
      let verdict: ExtractedClaim["verdict"] = "uncertain";
      let reason: string | undefined;
      for (const expId of expIds) {
        const blockedTerms =
          framingJudgeResult.blockedByExperience[expId] ?? [];
        for (const decision of blockedTerms) {
          if (
            audienceText.toLowerCase().includes(decision.framing.toLowerCase())
          ) {
            verdict = "blocked";
            reason = `audience blocked for ${expId}: ${decision.framing}`;
          }
        }
      }
      claims.push({ type: "audience", text: audienceText, verdict, reason });
    }
  } else {
    // No bridge judge context: audience defaults to uncertain
    const audienceMatch = bullet.match(
      /\b(?:for|to)\s+([a-z\s]+?(?:clients?|stakeholders?|startups?|ventures?|organizations?|teams?))\b/i,
    );
    if (audienceMatch) {
      claims.push({
        type: "audience",
        text: audienceMatch[1].trim(),
        verdict: "uncertain",
      });
    }
  }

  return claims;
}

/**
 * Check if a bullet has any blocked claims — quick gate before attempting repair.
 */
export function hasBlockedClaims(claims: ExtractedClaim[]): boolean {
  return claims.some((c) => c.verdict === "blocked");
}

/**
 * Get only the blocked claims from a bullet.
 */
export function getBlockedClaims(claims: ExtractedClaim[]): ExtractedClaim[] {
  return claims.filter((c) => c.verdict === "blocked");
}

// -- Targeted repair for v1c-2 --

export interface RepairResult {
  repaired: string;
  repairMode: "targeted" | "none";
  repairs: string[];
}

/**
 * Repair a bullet by removing/replacing blocked framing and audience claims.
 * Only touches blocked claims (verdict === "blocked", type framing or audience).
 * Action/method uncertain claims are ignored.
 *
 * Grammar safety gate: if repaired text < 50% of original length, repair is
 * skipped and repairMode = "none" — let the existing verifier handle it.
 */
export function repairBlockedClaims(
  bullet: string,
  claims: ExtractedClaim[],
): RepairResult {
  const blocked = claims.filter(
    (c) =>
      c.verdict === "blocked" &&
      (c.type === "framing" || c.type === "audience"),
  );
  if (blocked.length === 0)
    return { repaired: bullet, repairMode: "none", repairs: [] };

  let repaired = bullet;
  const repairs: string[] = [];

  for (const claim of blocked) {
    if (claim.type === "audience") {
      // P1-a: Narrow audience repair to minimum phrase containing blocked claim text
      const blockedTerm = claim.text.toLowerCase();
      const clauseMatch = repaired.match(
        /\b(?:for|to)\s+([a-z\s]+?(?:clients?|stakeholders?|startups?|ventures?|organizations?|teams?|executives?|leadership|management|boards?))\b/i,
      );
      if (clauseMatch) {
        const fullClause = clauseMatch[0];
        const innerText = clauseMatch[1].toLowerCase();
        if (innerText.includes(blockedTerm)) {
          const escaped = claim.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const narrowed = fullClause
            .replace(
              new RegExp("\\s*" + escaped + "\\s*(?:and|or)?\\s*", "gi"),
              " ",
            )
            .replace(/\s{2,}/g, " ")
            .replace(/\s+$/, "")
            .trim();
          repaired = repaired.replace(fullClause, narrowed);
          repairs.push(
            'audience: removed "' +
              claim.text +
              '" from clause "' +
              fullClause +
              '"',
          );
        }
      }
    } else {
      // Blocked framing: remove the phrase (case-insensitive)
      const escaped = claim.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const before = repaired;
      repaired = repaired.replace(new RegExp(escaped, "gi"), "").trim();
      repaired = repaired
        .replace(/\s{2,}/g, " ")
        .replace(/\s+(?:and|or)\s+(?:for|to|with|at|in|on)\b/gi, " for")
        .replace(/\b(?:and|or)\s+(?=[,.;]|\s*$)/gi, "")
        .replace(/\s+(?:and|or)\s*$/gi, "")
        .replace(/,\s*,/g, ",")
        .replace(/^\s*,\s*/, "")
        .replace(/\s+for\s*$/g, "")
        .trim();
      if (repaired !== before) {
        repairs.push('framing: removed "' + claim.text + '"');
      }
    }
  }

  // Grammar safety gate
  if (repaired.length < bullet.length * 0.5 || repaired.length < 20) {
    return { repaired: bullet, repairMode: "none", repairs: [] };
  }

  return { repaired, repairMode: "targeted", repairs };
}

// -- Fallback bullet for v1c-3 --

/**
 * Check whether targeted repair produced a grammatically broken bullet.
 * Deterministic — 6 rules, any of which triggers "broken".
 */
export function isRepairBroken(
  original: string,
  repaired: string,
  claims: ExtractedClaim[],
  framingJudgeResult?: FramingJudgeResult,
  experienceId?: string,
): boolean {
  const lower = repaired.toLowerCase().trim();

  // Rule 1: dangling fragments left by blocked phrase removal
  if (/\bfor\s+using\b/i.test(lower)) return true;
  if (/\bfor\s+to\b/i.test(lower)) return true;
  if (/\band\s+and\b/i.test(lower)) return true;
  if (/\b(?:Led|Conducted|Managed|Supported)\s+and\b/i.test(lower)) return true;

  // Rule 2: dangling preposition at end
  if (/\b(?:for|to|using|with)\s*$/i.test(lower)) return true;

  // Rule 3: space before punctuation (cleanup artifact)
  if (/\s+[,.]/.test(repaired)) return true;

  // Rule 4: too much removed
  if (repaired.length < original.length * 0.6) return true;

  // Rule 5: action verb directly followed by "and"
  if (
    /\b(?:Led|Conducted|Managed|Supported|Owned|Directed|Advised)\s+and\b/i.test(
      repaired,
    )
  )
    return true;

  // Rule 6: re-extract claims — still has blocked
  if (framingJudgeResult) {
    const recheck = extractClaims(repaired, framingJudgeResult, experienceId);
    if (recheck.some((c) => c.verdict === "blocked")) return true;
  }

  return false;
}

export interface FallbackResult {
  bullet: string;
  source: "repaired_cleanup" | "anchor_fallback" | "none";
  reasons: string[];
}

/**
 * Build a clean, conservative bullet from allowed claims and anchor evidence.
 * Does NOT call LLM. Does NOT pull new words from JD.
 */
export function buildFallbackBullet(args: {
  original: string;
  claims: ExtractedClaim[];
  framingJudgeResult?: FramingJudgeResult;
  experienceId?: string;
  experienceAnchor?: {
    responsibilityAreas: string[];
    toolsAndMethods: string[];
    stakeholders: string[];
  };
  experienceDigest?: { coreClaims: string[] };
}): FallbackResult {
  const allowedClaims = args.claims.filter((c) => c.verdict !== "blocked");
  const nonBlockedFramings = allowedClaims
    .filter((c) => c.type === "framing")
    .map((c) => c.text);
  const nonBlockedMethods = allowedClaims
    .filter((c) => c.type === "method")
    .map((c) => c.text);
  const nonBlockedAudiences = allowedClaims
    .filter((c) => c.type === "audience")
    .map((c) => c.text);
  const actionClaim = allowedClaims.find((c) => c.type === "action");

  // Safe verb
  const safeVerb = actionClaim ? actionClaim.text.split(/\s+/)[0] : "Conducted";

  // Core action: non-blocked framing from original, or active framing with token overlap,
  // or first coreClaim from digest, or first responsibilityArea from anchor
  const activeFramings =
    args.framingJudgeResult?.activeFramingsByExperience[
      args.experienceId ?? ""
    ] ?? [];
  const activeFramingTexts = activeFramings.map((d) => d.framing);

  let coreAction = "";
  const reasons: string[] = [];

  if (nonBlockedFramings.length > 0) {
    coreAction = nonBlockedFramings[0];
    reasons.push("used non-blocked framing from original bullet");
  } else {
    // Find active framing with token overlap against any non-blocked claim
    const nonBlockedTexts = allowedClaims.map((c) => c.text.toLowerCase());
    const matched = activeFramingTexts.find((af) =>
      nonBlockedTexts.some((nb) => hasTokenOverlap(af, nb)),
    );
    if (matched) {
      coreAction = matched;
      reasons.push(`used active framing "${matched}" with token overlap`);
    }
  }

  // Fall back to digest/anchor
  if (!coreAction && args.experienceDigest?.coreClaims.length) {
    coreAction = args.experienceDigest.coreClaims[0];
    reasons.push("used digest coreClaim");
  }
  if (!coreAction && args.experienceAnchor?.responsibilityAreas.length) {
    coreAction = args.experienceAnchor.responsibilityAreas[0];
    reasons.push("used anchor responsibilityArea");
  }
  if (!coreAction) {
    return {
      bullet: "",
      source: "none",
      reasons: ["no core action available"],
    };
  }

  // Assemble: base clause required, method/audience optional
  let bullet = `${safeVerb} ${coreAction}`;

  // Method clause: only if explicit safe method
  if (nonBlockedMethods.length > 0) {
    bullet += ` using ${nonBlockedMethods[0]}`;
  } else if (args.experienceAnchor?.toolsAndMethods.length) {
    bullet += ` using ${args.experienceAnchor.toolsAndMethods[0]}`;
  }

  // Audience clause: only if explicit safe audience and doesn't inflate
  if (nonBlockedAudiences.length > 0) {
    const audienceAddon = ` for ${nonBlockedAudiences[0]}`;
    if (bullet.length + audienceAddon.length <= 180) {
      bullet += audienceAddon;
    }
  } else if (args.experienceAnchor?.stakeholders.length) {
    const audienceAddon = ` for ${args.experienceAnchor.stakeholders[0]}`;
    if (bullet.length + audienceAddon.length <= 180) {
      bullet += audienceAddon;
    }
  }

  // Validate output is not longer than original
  if (bullet.length > args.original.length) {
    bullet = `${safeVerb} ${coreAction}`;
    reasons.push("trimmed — fallback exceeded original length");
  }

  return {
    bullet: bullet.length <= 180 ? bullet : bullet.slice(0, 177) + "...",
    source: args.experienceAnchor ? "anchor_fallback" : "repaired_cleanup",
    reasons,
  };
}

function hasTokenOverlap(a: string, b: string): boolean {
  const tokensA = new Set(a.toLowerCase().split(/\s+/));
  const tokensB = b.toLowerCase().split(/\s+/);
  return tokensB.some((t) => tokensA.has(t));
}
