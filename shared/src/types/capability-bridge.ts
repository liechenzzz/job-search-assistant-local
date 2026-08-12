/** Types for the capability bridge judge and claim-level verification. */

// -- Framing decision from bridge judge --

export type ClaimScope =
  | "framing"
  | "audience"
  | "domain"
  | "method"
  | "output";

export type FramingLegality = "allowed" | "blocked" | "uncertain";

export interface FramingDecision {
  /** The candidate claim text, e.g. "market intelligence" */
  framing: string;
  claimScope: ClaimScope;
  experienceId: string;
  /** Which JD requirements this claim addresses */
  requirementIds: string[];
  legality: FramingLegality;
  relevantToCurrentJd: boolean;
  /** MUST cite JD text that supports relevance */
  jdPhrasesSupportingRelevance: string[];
  /** MUST cite evidence chunk IDs that support legality */
  evidenceIdsSupportingLegality: string[];
  risk: "low" | "medium" | "high";
  /** 1-2 sentence rationale */
  rationale: string;
}

// -- Framing memory (persisted per-experience) --

export type FramingMemoryStatus = "observed" | "approved" | "rejected";

export interface FramingMemoryEntry {
  normalizedFraming: string;
  displayFraming: string;
  status: FramingMemoryStatus;
  source: "judge" | "user";
  lastRisk?: "low" | "medium" | "high";
  lastRationale?: string;
  lastEvidenceIds?: string[];
  confirmedAt?: string;
  lastJudgedAt: string;
}

export interface ExperienceFramingMemory {
  experienceAnchorId: string;
  sourceDigestHash: string;
  entries: FramingMemoryEntry[];
}

// -- Bridge judge result --

export interface FramingJudgeResult {
  /** All judged items (full detail for trace/debug) */
  decisions: FramingDecision[];
  /** Framing scope only, legal=allowed + relevant → feeds allowedTranslations */
  activeFramingsByExperience: Record<string, FramingDecision[]>;
  /** All scopes, legal=allowed → verifier reference only */
  allowedClaimsByExperience: Record<string, FramingDecision[]>;
  /** All scopes, legal=blocked → verifier enforcement + blockedClaims */
  blockedByExperience: Record<string, FramingDecision[]>;
  /** Flat deduplicated lists for prompt summary injection only */
  activeFramings: string[];
  blockedClaims: string[];
  summary: {
    totalJudged: number;
    activeFramings: number;
    blocked: number;
    highRisk: number;
  };
}

// -- Candidate pooling (internal to framing-judge) --

export type CandidateSource =
  | "memory"
  | "selected_evidence"
  | "digest"
  | "coverage_plan"
  | "jd_phrase";

export type CandidateKind = ClaimScope | "action";

export interface FramingCandidate {
  /** The candidate text */
  text: string;
  kind: CandidateKind;
  experienceId: string;
  requirementIds: string[];
  source: CandidateSource;
  /** Evidence chunk IDs that may support this candidate */
  evidenceChunkIds: string[];
  /** For JD phrase candidates: the original JD phrase */
  jdPhrase?: string;
  /** For explicit blocked candidates: already known to be blocked */
  preBlocked?: boolean;
  defaultRisk?: "low" | "medium" | "high";
}

// -- Claim extraction (v1c) --

export type ClaimVerdict = "pass" | "blocked" | "uncertain";

export interface ExtractedClaim {
  type: "action" | "method" | "framing" | "audience";
  text: string;
  verdict: ClaimVerdict;
  reason?: string;
}
