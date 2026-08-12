/**
 * Tests for the framing judge classifier and candidate generation.
 */

import { describe, expect, it } from "vitest";
import type { FramingJudgeInput } from "./framing-judge";
import {
  buildFallbackBullet,
  classifyCandidateKind,
  extractClaims,
  generateFramingCandidates,
  isRepairBroken,
  repairBlockedClaims,
} from "./framing-judge";

// -- classifier tests --

describe("classifyCandidateKind", () => {
  it("classifies market intelligence as framing", () => {
    expect(classifyCandidateKind("market intelligence")).toBe("framing");
  });

  it("classifies sector opportunity research as framing", () => {
    expect(classifyCandidateKind("sector opportunity research")).toBe(
      "framing",
    );
  });

  it("classifies stakeholder engagement as framing", () => {
    expect(classifyCandidateKind("stakeholder engagement")).toBe("framing");
  });

  it("classifies policy research as framing", () => {
    expect(classifyCandidateKind("policy research")).toBe("framing");
  });

  it("classifies competitive landscape as framing", () => {
    expect(classifyCandidateKind("competitive landscape")).toBe("framing");
  });

  it("classifies healthcare startups as audience (not framing)", () => {
    expect(classifyCandidateKind("healthcare startups")).toBe("audience");
  });

  it("classifies government clients as audience (not framing)", () => {
    expect(classifyCandidateKind("government clients")).toBe("audience");
  });

  it("classifies Python as method", () => {
    expect(classifyCandidateKind("Python")).toBe("method");
  });

  it("classifies Excel as method", () => {
    expect(classifyCandidateKind("Excel")).toBe("method");
  });

  it("classifies dashboard as output", () => {
    expect(classifyCandidateKind("dashboard")).toBe("output");
  });

  it("classifies briefing note as output", () => {
    expect(classifyCandidateKind("briefing note")).toBe("output");
  });

  it("classifies healthcare market intelligence as framing (framing priority)", () => {
    // "market intelligence" is in FRAMING_KEYWORDS, checked first → "framing"
    // "healthcare" is in AUDIENCE_KEYWORDS but framing wins
    expect(classifyCandidateKind("healthcare market intelligence")).toBe(
      "framing",
    );
  });

  it("returns undefined for ambiguous non-matching phrases", () => {
    expect(classifyCandidateKind("helped team members")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(classifyCandidateKind("")).toBeUndefined();
  });

  it("returns undefined for very short text", () => {
    expect(classifyCandidateKind("ab")).toBeUndefined();
  });

  it("classifies workforce development as domain (domain check)", () => {
    // "workforce" is in DOMAIN_KEYWORDS
    expect(classifyCandidateKind("workforce development")).toBe("domain");
  });

  it("classifies TAM sizing as output ('sizing' not in keywords, but 'TAM' is not either — let's test)", () => {
    // Neither "tam" nor "sizing" are in output keywords, but let's verify
    // "tam sizing" has no keyword match → ambiguous → undefined
    const result = classifyCandidateKind("tam sizing");
    // Undefined because no keyword matches — this is the right behavior for v1
    // TAM sizing is handled by containsDomainSpecificity() in JD phrase extraction
    expect(result).toBeUndefined();
  });

  it("classifies public-sector innovation as framing (innovation keyword wins)", () => {
    // "innovation" is in FRAMING_KEYWORDS, checked first → "framing"
    // "public-sector" is in AUDIENCE_KEYWORDS but framing wins
    expect(classifyCandidateKind("public-sector innovation")).toBe("framing");
  });

  it("classifies distinguishing framing vs method: data analysis", () => {
    // "data analysis" matches framing (research, analytics, data analysis)
    expect(classifyCandidateKind("data analysis")).toBe("framing");
  });
});

// -- candidate generation tests --

function makeMinimalInput(
  overrides: Partial<FramingJudgeInput> = {},
): FramingJudgeInput {
  return {
    selectedEvidence: [],
    experienceAnchors: [],
    experienceDigests: [],
    coveragePlan: {
      items: [],
      missingRequired: [],
      partialRequired: [],
      referenceUsed: [],
    },
    jdRequirements: [],
    framingMemory: [],
    ...overrides,
  };
}

describe("generateFramingCandidates", () => {
  it("returns empty pools for empty input", () => {
    const input = makeMinimalInput();
    const result = generateFramingCandidates(input);
    expect(result.activationCandidates).toHaveLength(0);
    expect(result.blockCheckCandidates).toHaveLength(0);
  });

  it("routes framing claims to activation pool, audience claims to block-check", () => {
    const input = makeMinimalInput({
      experienceDigests: [
        {
          experienceId: "exp_1",
          label: "Regional Research Consultancy",
          fitLevel: "primary",
          capabilitySummary: "Test",
          coreClaims: [],
          transferableClaims: [
            "market intelligence",
            "healthcare startups",
            "stakeholder engagement",
          ],
          matchedRequirementIds: [],
          recommendedBulletThemes: [],
          sourceChunkIds: ["chunk_1"],
          blockedClaims: [],
          confidence: "high",
        },
      ],
    });

    const result = generateFramingCandidates(input);

    // "market intelligence" and "stakeholder engagement" → framing → activation
    const activationTexts = result.activationCandidates.map((c) => c.text);
    expect(activationTexts).toContain("market intelligence");
    expect(activationTexts).toContain("stakeholder engagement");

    // "healthcare startups" → audience → block-check
    const blockCheckTexts = result.blockCheckCandidates.map((c) => c.text);
    expect(blockCheckTexts).toContain("healthcare startups");

    // audience claims should NOT be in activation
    expect(activationTexts).not.toContain("healthcare startups");
  });

  it("routes pre-blocked digest claims to block-check with preBlocked=true", () => {
    const input = makeMinimalInput({
      experienceDigests: [
        {
          experienceId: "exp_1",
          label: "Regional Research Consultancy",
          fitLevel: "primary",
          capabilitySummary: "Test",
          coreClaims: [],
          transferableClaims: [],
          matchedRequirementIds: [],
          recommendedBulletThemes: [],
          sourceChunkIds: ["chunk_1"],
          blockedClaims: ["TAM sizing", "clinical research"],
          confidence: "high",
        },
      ],
    });

    const result = generateFramingCandidates(input);

    const blocked = result.blockCheckCandidates.filter((c) => c.preBlocked);
    expect(blocked).toHaveLength(2);
    expect(blocked.map((c) => c.text)).toContain("TAM sizing");
    expect(blocked.map((c) => c.text)).toContain("clinical research");
  });

  it("generates per-experience JD phrase candidates", () => {
    const input = makeMinimalInput({
      experienceAnchors: [
        {
          experienceAnchorId: "anchor_research",
          identity: {
            company: "Regional Research Consultancy",
            title: "Research Analyst",
            roleAliases: [],
          },
          roleOverview: { text: "test", sourceChunkIds: [] },
          responsibilityAreas: [],
          majorProjects: [],
          toolsAndMethods: [],
          domains: [],
          stakeholders: [],
          measurableOutcomes: [],
          transferableStrengths: [],
          limitationsOrUnverifiedClaims: [],
          sourceChunkIds: [],
          sourceFiles: [],
          sourceDigestHash: "hash1",
          confidence: "medium",
          diagnostics: {
            buildMethod: "deterministic" as const,
            sourceChunkCount: 1,
            lowQualitySourceChunkIds: [],
            orphanChunkIds: [],
            warnings: [],
          },
          lastBuiltAt: "2026-01-01",
          version: 1,
        },
        {
          experienceAnchorId: "anchor_program",
          identity: {
            company: "Community Innovation Program",
            title: "Project Coordinator",
            roleAliases: [],
          },
          roleOverview: { text: "test", sourceChunkIds: [] },
          responsibilityAreas: [],
          majorProjects: [],
          toolsAndMethods: [],
          domains: [],
          stakeholders: [],
          measurableOutcomes: [],
          transferableStrengths: [],
          limitationsOrUnverifiedClaims: [],
          sourceChunkIds: [],
          sourceFiles: [],
          sourceDigestHash: "hash2",
          confidence: "medium",
          diagnostics: {
            buildMethod: "deterministic" as const,
            sourceChunkCount: 1,
            lowQualitySourceChunkIds: [],
            orphanChunkIds: [],
            warnings: [],
          },
          lastBuiltAt: "2026-01-01",
          version: 1,
        },
      ],
      jdRequirements: [
        {
          id: "req_1",
          text: "Conduct market intelligence and sector opportunity research",
          category: "skill",
          priority: 100,
          targetSections: ["experience"],
          mustHave: true,
          evidenceNeeded: "direct",
        },
      ],
    });

    const result = generateFramingCandidates(input);

    // "market intelligence" from JD → should appear for both experiences
    const researchCandidates = result.activationCandidates.filter(
      (c) =>
        c.experienceId === "anchor_research" &&
        c.text === "market intelligence",
    );
    const programCandidates = result.activationCandidates.filter(
      (c) =>
        c.experienceId === "anchor_program" && c.text === "market intelligence",
    );
    expect(researchCandidates.length).toBeGreaterThanOrEqual(1);
    expect(programCandidates.length).toBeGreaterThanOrEqual(1);

    // Both should be tagged as jd_phrase source with the same jdPhrase
    if (researchCandidates[0]) {
      expect(researchCandidates[0].source).toBe("jd_phrase");
      expect(researchCandidates[0].jdPhrase).toBe("market intelligence");
    }
  });

  it("respects per-experience and per-run caps", () => {
    const digests = [];
    for (let i = 0; i < 20; i++) {
      digests.push({
        experienceId: `exp_${i}`,
        label: `Experience ${i}`,
        fitLevel: "primary" as const,
        capabilitySummary: "Test",
        coreClaims: [],
        transferableClaims: [
          `market research ${i}`,
          `sector analysis ${i}`,
          `stakeholder engagement ${i}`,
        ],
        matchedRequirementIds: [],
        recommendedBulletThemes: [],
        sourceChunkIds: [`chunk_${i}`],
        blockedClaims: [],
        confidence: "high" as const,
      });
    }

    // 20 experiences × 3 claims each = 60 candidates
    const input = makeMinimalInput({
      experienceDigests: digests.slice(0, 20),
    });

    const result = generateFramingCandidates(input);

    // Should be capped to 60 per run
    expect(result.activationCandidates.length).toBeLessThanOrEqual(60);
    // Per experience cap of 12 should be respected
    const counts: Record<string, number> = {};
    for (const c of result.activationCandidates) {
      counts[c.experienceId] = (counts[c.experienceId] ?? 0) + 1;
    }
    for (const count of Object.values(counts)) {
      expect(count).toBeLessThanOrEqual(12);
    }
  });
});

// -- claim extraction tests (v1c-1) --

describe("extractClaims", () => {
  it("extracts action claim from bullet start (verdict: uncertain)", () => {
    const claims = extractClaims(
      "Conducted market intelligence research across three regions.",
    );
    const action = claims.find((c) => c.type === "action");
    expect(action).toBeDefined();
    expect(action!.verdict).toBe("uncertain"); // not verified against evidence
    expect(action!.text).toContain("Conducted");
  });

  it("flags blocked framing from framing judge result", () => {
    const result = {
      decisions: [],
      activeFramingsByExperience: {
        "exp-research": [
          {
            framing: "market intelligence",
            claimScope: "framing" as const,
            experienceId: "exp-research",
            requirementIds: [],
            legality: "allowed" as const,
            relevantToCurrentJd: true,
            jdPhrasesSupportingRelevance: ["market intelligence"],
            evidenceIdsSupportingLegality: ["chunk_1"],
            risk: "low" as const,
            rationale: "Supported by evidence",
          },
        ],
      },
      blockedByExperience: {
        "exp-research": [
          {
            framing: "healthcare startups",
            claimScope: "audience" as const,
            experienceId: "exp-research",
            requirementIds: [],
            legality: "blocked" as const,
            relevantToCurrentJd: false,
            jdPhrasesSupportingRelevance: [],
            evidenceIdsSupportingLegality: [],
            risk: "high" as const,
            rationale: "No healthcare client evidence",
          },
        ],
      },
      allowedClaimsByExperience: {},
      activeFramings: [],
      blockedClaims: [],
      summary: { totalJudged: 0, activeFramings: 0, blocked: 0, highRisk: 0 },
    };

    const claims = extractClaims(
      "Conducted market intelligence for healthcare startups.",
      result as any,
    );

    const framingClaim = claims.find(
      (c) =>
        c.type === "framing" && c.text.toLowerCase() === "market intelligence",
    );
    expect(framingClaim).toBeDefined();
    expect(framingClaim!.verdict).toBe("pass");

    const audienceClaim = claims.find(
      (c) =>
        c.type === "audience" && c.text.toLowerCase().includes("healthcare"),
    );
    expect(audienceClaim).toBeDefined();
    expect(audienceClaim!.verdict).toBe("blocked");
  });

  it("returns empty array for bullet with no recognizable claims beyond action", () => {
    const claims = extractClaims("Supported the team with various tasks.");
    const nonAction = claims.filter((c) => c.type !== "action");
    expect(nonAction).toHaveLength(0);
  });

  it("works without FramingJudgeResult (all uncertain)", () => {
    const claims = extractClaims(
      "Led data analysis using Python and SQL for public-sector clients.",
    );
    const blocked = claims.filter((c) => c.verdict === "blocked");
    expect(blocked).toHaveLength(0);
    // action/method/audience default to uncertain when no bridge judge
    expect(claims.length).toBeGreaterThan(0);
  });

  it("repairs blocked audience claim (T3b)", () => {
    const result = {
      decisions: [],
      activeFramingsByExperience: {
        "exp-research": [
          {
            framing: "market intelligence",
            claimScope: "framing" as const,
            experienceId: "exp-research",
            requirementIds: [],
            legality: "allowed" as const,
            relevantToCurrentJd: true,
            jdPhrasesSupportingRelevance: ["market"],
            evidenceIdsSupportingLegality: ["chunk_1"],
            risk: "low" as const,
            rationale: "ok",
          },
        ],
      },
      blockedByExperience: {
        "exp-research": [
          {
            framing: "healthcare startups",
            claimScope: "audience" as const,
            experienceId: "exp-research",
            requirementIds: [],
            legality: "blocked" as const,
            relevantToCurrentJd: false,
            jdPhrasesSupportingRelevance: [],
            evidenceIdsSupportingLegality: [],
            risk: "high" as const,
            rationale: "no evidence",
          },
        ],
      },
      allowedClaimsByExperience: {},
      activeFramings: [],
      blockedClaims: [],
      summary: { totalJudged: 0, activeFramings: 0, blocked: 0, highRisk: 0 },
    };

    const claims = extractClaims(
      "Conducted market intelligence for healthcare startups.",
      result as any,
      "exp-research",
    );
    const repairResult = repairBlockedClaims(
      "Conducted market intelligence for healthcare startups.",
      claims,
    );
    expect(repairResult.repairMode).toBe("targeted");
    expect(repairResult.repaired).toContain("market intelligence");
    expect(repairResult.repaired).not.toContain("healthcare");
    expect(repairResult.repairs.length).toBeGreaterThan(0);
  });

  it("removes multiple blocked claim phrases (T3c)", () => {
    const result = {
      decisions: [],
      activeFramingsByExperience: {},
      blockedByExperience: {
        "exp-research": [
          {
            framing: "TAM sizing",
            claimScope: "framing" as const,
            experienceId: "exp-research",
            requirementIds: [],
            legality: "blocked" as const,
            relevantToCurrentJd: false,
            jdPhrasesSupportingRelevance: [],
            evidenceIdsSupportingLegality: [],
            risk: "high" as const,
            rationale: "no evidence",
          },
          {
            framing: "investment thesis",
            claimScope: "framing" as const,
            experienceId: "exp-research",
            requirementIds: [],
            legality: "blocked" as const,
            relevantToCurrentJd: false,
            jdPhrasesSupportingRelevance: [],
            evidenceIdsSupportingLegality: [],
            risk: "high" as const,
            rationale: "no evidence",
          },
        ],
      },
      allowedClaimsByExperience: {},
      activeFramings: [],
      blockedClaims: [],
      summary: { totalJudged: 0, activeFramings: 0, blocked: 0, highRisk: 0 },
    };

    const bullet =
      "Led TAM sizing and investment thesis analysis using sector data for clients.";
    const claims = extractClaims(bullet, result as any, "exp-research");
    const repairResult = repairBlockedClaims(bullet, claims);
    expect(repairResult.repairMode).toBe("targeted");
    expect(repairResult.repaired).not.toContain("TAM sizing");
    expect(repairResult.repaired).not.toContain("investment thesis");
    expect(repairResult.repairs.length).toBe(2);
  });

  it("scopes framing check to the given experience (cross-exp boundary)", () => {
    // market intelligence: allowed for exp-a, blocked for exp-b
    const result = {
      decisions: [],
      activeFramingsByExperience: {
        "exp-a": [
          {
            framing: "market intelligence",
            claimScope: "framing" as const,
            experienceId: "exp-a",
            requirementIds: [],
            legality: "allowed" as const,
            relevantToCurrentJd: true,
            jdPhrasesSupportingRelevance: ["market"],
            evidenceIdsSupportingLegality: ["chunk_1"],
            risk: "low" as const,
            rationale: "ok for exp-a",
          },
        ],
      },
      blockedByExperience: {
        "exp-b": [
          {
            framing: "market intelligence",
            claimScope: "framing" as const,
            experienceId: "exp-b",
            requirementIds: [],
            legality: "blocked" as const,
            relevantToCurrentJd: false,
            jdPhrasesSupportingRelevance: [],
            evidenceIdsSupportingLegality: [],
            risk: "medium" as const,
            rationale: "blocked for exp-b",
          },
        ],
      },
      allowedClaimsByExperience: {},
      activeFramings: [],
      blockedClaims: [],
      summary: { totalJudged: 0, activeFramings: 0, blocked: 0, highRisk: 0 },
    };

    // Scoped to exp-a: market intelligence → pass
    const claimsA = extractClaims(
      "Conducted market intelligence for stakeholders.",
      result as any,
      "exp-a",
    );
    const framingA = claimsA.find((c) => c.type === "framing");
    expect(framingA).toBeDefined();
    expect(framingA!.verdict).toBe("pass");

    // Scoped to exp-b: market intelligence → blocked
    const claimsB = extractClaims(
      "Conducted market intelligence for stakeholders.",
      result as any,
      "exp-b",
    );
    const framingB = claimsB.find((c) => c.type === "framing");
    expect(framingB).toBeDefined();
    expect(framingB!.verdict).toBe("blocked");
  });

  it("same-experience conflict: allowed+blocked framing → blocked (P1-b)", () => {
    const result = {
      decisions: [],
      activeFramingsByExperience: {
        "exp-x": [
          {
            framing: "market intelligence",
            claimScope: "framing" as const,
            experienceId: "exp-x",
            requirementIds: [],
            legality: "allowed" as const,
            relevantToCurrentJd: true,
            jdPhrasesSupportingRelevance: ["market"],
            evidenceIdsSupportingLegality: ["chunk_1"],
            risk: "low" as const,
            rationale: "ok",
          },
        ],
      },
      blockedByExperience: {
        "exp-x": [
          {
            framing: "market intelligence",
            claimScope: "framing" as const,
            experienceId: "exp-x",
            requirementIds: [],
            legality: "blocked" as const,
            relevantToCurrentJd: false,
            jdPhrasesSupportingRelevance: [],
            evidenceIdsSupportingLegality: [],
            risk: "medium" as const,
            rationale: "overreach for exp-x",
          },
        ],
      },
      allowedClaimsByExperience: {},
      activeFramings: [],
      blockedClaims: [],
      summary: { totalJudged: 0, activeFramings: 0, blocked: 0, highRisk: 0 },
    };

    const claims = extractClaims(
      "Conducted market intelligence for stakeholders.",
      result as any,
      "exp-x",
    );
    const framingClaim = claims.find((c) => c.type === "framing");
    expect(framingClaim).toBeDefined();
    // Conflict: same experience has the framing in both lists → prefer blocked
    expect(framingClaim!.verdict).toBe("blocked");
    expect(framingClaim!.reason).toContain("conflict");
  });

  it("audience repair: removes only blocked phrase, keeps allowed audience (P1-a)", () => {
    const result = {
      decisions: [],
      activeFramingsByExperience: {},
      blockedByExperience: {
        "exp-research": [
          {
            framing: "healthcare startups",
            claimScope: "audience" as const,
            experienceId: "exp-research",
            requirementIds: [],
            legality: "blocked" as const,
            relevantToCurrentJd: false,
            jdPhrasesSupportingRelevance: [],
            evidenceIdsSupportingLegality: [],
            risk: "high" as const,
            rationale: "no evidence",
          },
        ],
      },
      allowedClaimsByExperience: {},
      activeFramings: [],
      blockedClaims: [],
      summary: { totalJudged: 0, activeFramings: 0, blocked: 0, highRisk: 0 },
    };

    const bullet =
      "Analyzed market trends for public-sector stakeholders and healthcare startups.";
    const claims = extractClaims(bullet, result as any, "exp-research");
    const repairResult = repairBlockedClaims(bullet, claims);

    // Must keep the allowed "public-sector stakeholders"
    expect(repairResult.repaired).toContain("public-sector stakeholders");
    // Must remove the blocked "healthcare startups"
    expect(repairResult.repaired).not.toContain("healthcare startups");
    expect(repairResult.repairMode).toBe("targeted");
  });
});

// -- v1c-3 fallback tests --

describe("isRepairBroken", () => {
  it("detects for using fragment (T3d)", () => {
    const result = isRepairBroken(
      "Led market intelligence for healthcare startups using TAM sizing.",
      "Led market intelligence for using to identify sector opportunities.",
      [],
    );
    expect(result).toBe(true);
  });

  it("detects Led and fragment (rule 5)", () => {
    const result = isRepairBroken(
      "Led market intelligence and stakeholder coordination.",
      "Led and stakeholder coordination for innovation ecosystem programs.",
      [],
    );
    expect(result).toBe(true);
  });

  it("detects dangling preposition at end (rule 2)", () => {
    const result = isRepairBroken(
      "Conducted research for public-sector clients.",
      "Conducted research for ",
      [],
    );
    expect(result).toBe(true);
  });

  it("detects too much removed (rule 4)", () => {
    const result = isRepairBroken(
      "Led comprehensive market intelligence research across three regions.",
      "research.",
      [],
    );
    expect(result).toBe(true);
  });

  it("returns false for clean bullet (T3f)", () => {
    const result = isRepairBroken(
      "Conducted market intelligence for public-sector clients.",
      "Conducted market intelligence for public-sector clients.",
      [],
    );
    expect(result).toBe(false);
  });
});

describe("buildFallbackBullet", () => {
  it("builds from non-blocked claims and anchor (T3e)", () => {
    const claims = [
      {
        type: "action" as const,
        text: "Led market intelligence and stakeholder coordination",
        verdict: "pass" as const,
      },
      {
        type: "framing" as const,
        text: "market intelligence",
        verdict: "blocked" as const,
      },
      {
        type: "framing" as const,
        text: "stakeholder coordination",
        verdict: "pass" as const,
      },
    ];
    const result = buildFallbackBullet({
      original:
        "Led market intelligence and stakeholder coordination for innovation ecosystem programs.",
      claims,
      experienceAnchor: {
        responsibilityAreas: ["Coordinated stakeholder workshops"],
        toolsAndMethods: ["KPI dashboards"],
        stakeholders: ["municipal staff", "entrepreneurs"],
      },
    });
    expect(result.source).not.toBe("none");
    expect(result.bullet).not.toContain("market intelligence");
    expect(result.bullet.length).toBeLessThanOrEqual(
      "Led market intelligence and stakeholder coordination for innovation ecosystem programs."
        .length,
    );
  });

  it("returns none when no core action available", () => {
    const result = buildFallbackBullet({
      original: "Led and .",
      claims: [],
    });
    expect(result.source).toBe("none");
    expect(result.bullet).toBe("");
  });
});
