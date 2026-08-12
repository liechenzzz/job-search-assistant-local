import { describe, expect, it, vi } from "vitest";
import {
  formatJdServiceValueBriefForPrompt,
  generateJdServiceValueBrief,
  sanitizeResumeServiceFitReport,
  verifyResumeServiceFit,
} from "./resume-service-value";

const keywordProfile = {
  roleFamily: "market_intelligence",
  domainTerms: ["health", "market intelligence"],
  blockedTerms: [],
} as never;

const qualificationProfile = {
  required: ["market research", "health sector interest"],
  preferred: ["PowerPoint"],
  responsibilities: ["lead market research projects"],
} as never;

const selectedEvidence = [
  {
    requirement: "market research",
    status: "selected",
    chunks: [
      {
        chunkId: "chunk-1",
        sourceFile: "resume.docx",
        section: "experience",
        rawText:
          "Prepared sector research and client-ready recommendations for economic development stakeholders.",
      },
    ],
  },
] as never;

const contentPlan = {
  experienceAllocations: [],
  sectionBudgets: { skillGroups: { min: 3, target: 3, max: 3 } },
} as never;

const serviceBrief = {
  buyerNeed:
    "Market intelligence for high-growth health and technology ventures making growth decisions.",
  targetStakeholders: ["venture clients", "market intelligence team"],
  businessDecisionsSupported: ["market opportunity assessment"],
  expectedDeliverables: ["client-ready recommendations"],
  mustSignalConcepts: ["market intelligence", "market opportunity"],
  avoidDominantFrames: ["generic public-sector workforce analytics"],
  candidateValueProposition:
    "Translate sector research into client-ready market intelligence recommendations.",
  evidenceTranslationTargets: [
    {
      jdNeed: "venture market intelligence",
      resumeProofTheme: "sector research and recommendations",
      acceptableWording: "market intelligence recommendations",
      overclaimRisk: "Do not claim direct venture-client ownership.",
    },
  ],
};

describe("resume service-value agents", () => {
  it("formats partial service-value briefs without throwing", () => {
    const text = formatJdServiceValueBriefForPrompt({
      buyerNeed:
        "Market intelligence for venture teams making growth decisions.",
      candidateValueProposition:
        "Translate sector research into market intelligence recommendations.",
    } as never);

    expect(text).toContain("Market intelligence");
    expect(text).toContain("Target stakeholders: None listed.");
    expect(text).toContain("Expected deliverables: None listed.");
  });

  it("sanitizes a MaRS-style JD service-value brief around buyer need", async () => {
    const llm = {
      callJson: vi.fn(async () => ({
        success: true as const,
        data: serviceBrief,
      })),
    };

    const result = await generateJdServiceValueBrief({
      llm: llm as never,
      model: "test-model",
      jobDescription:
        "Analyst, Market Intelligence - Health. Lead market research for high-growth ventures.",
      jobTitle: "Analyst, Market Intelligence - Health",
      employer: "MaRS Discovery District",
      jdKeywordProfile: keywordProfile,
      jdQualificationProfile: qualificationProfile,
      selectedEvidence,
      experienceDigests: [],
      contentPlan,
    });

    expect(result?.buyerNeed).toContain("Market intelligence");
    expect(result?.targetStakeholders).toContain("venture clients");
    expect(result?.avoidDominantFrames).toContain(
      "generic public-sector workforce analytics",
    );
    expect(llm.callJson).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonSchema: expect.objectContaining({ name: "jd_service_value_brief" }),
      }),
    );
  });

  it("returns null when JD service-value agent fails", async () => {
    const llm = {
      callJson: vi.fn(async () => ({
        success: false as const,
        error: "model unavailable",
      })),
    };

    const result = await generateJdServiceValueBrief({
      llm: llm as never,
      model: "test-model",
      jobDescription: "Lead market research.",
      jdKeywordProfile: keywordProfile,
      jdQualificationProfile: qualificationProfile,
      selectedEvidence,
      experienceDigests: [],
      contentPlan,
    });

    expect(result).toBeNull();
  });

  it("reports weak MaRS service fit and unsupported claims without failing", async () => {
    const llm = {
      callJson: vi.fn(async () => ({
        success: true as const,
        data: {
          status: "needs_review",
          score: 64,
          targetBuyerNeed: serviceBrief.buyerNeed,
          resumeCurrentlySignals: ["workforce development analytics"],
          matchedServiceValues: ["research and reporting"],
          missingOrWeakServiceValues: [
            "under-signals venture-client market intelligence",
          ],
          oldFrameRisks: ["summary remains public-sector workforce heavy"],
          unsupportedOrNeedsConfirmation: [
            {
              claim: "Salesforce and Asana workflow ownership",
              severity: "high",
              recommendation: "Remove unless confirmed by user evidence.",
            },
            {
              claim: "TAM model development",
              severity: "medium",
              recommendation: "Soften to market sizing exposure if true.",
            },
          ],
          manualFixSuggestions: [
            {
              section: "summary",
              issue:
                "First impression is workforce analytics, not market intelligence.",
              suggestedDirection:
                "Lead with market intelligence and client-ready recommendations.",
            },
          ],
        },
      })),
    };

    const report = await verifyResumeServiceFit({
      llm: llm as never,
      model: "test-model",
      jdServiceValueBrief: serviceBrief,
      resumePositioningPlan: null,
      headline: "Workforce Development Analyst",
      summary:
        "Workforce development analyst preparing public-sector labour-market reports.",
      skills: [],
      experience: [],
      selectedEvidence,
      generationTrace: {},
    });

    expect(report.status).toBe("needs_review");
    expect(report.oldFrameRisks[0]).toMatch(/workforce/i);
    expect(report.unsupportedOrNeedsConfirmation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: "Salesforce and Asana workflow ownership",
          severity: "high",
        }),
      ]),
    );
  });

  it("sanitizes unsupported claims as advisory report items", () => {
    const report = sanitizeResumeServiceFitReport(
      {
        status: "weak_fit",
        score: 42.4,
        targetBuyerNeed: serviceBrief.buyerNeed,
        unsupportedOrNeedsConfirmation: [
          { claim: "direct venture-client ownership", severity: "high" },
          { claim: "health-sector depth", severity: "unknown" },
        ],
        manualFixSuggestions: [
          {
            section: "experience",
            issue: "Old frame dominates",
            suggestedDirection: "Translate toward market opportunity evidence.",
          },
        ],
      },
      serviceBrief,
    );

    expect(report?.score).toBe(42);
    expect(report?.unsupportedOrNeedsConfirmation).toEqual([
      {
        claim: "direct venture-client ownership",
        severity: "high",
        recommendation: "",
      },
      {
        claim: "health-sector depth",
        severity: "soft",
        recommendation: "",
      },
    ]);
  });

  it("turns unclear service signal reports into actionable repair gaps", () => {
    const report = sanitizeResumeServiceFitReport(
      {
        status: "needs_review",
        score: 60,
        targetBuyerNeed: serviceBrief.buyerNeed,
        resumeCurrentlySignals: ["No clear service-value signal detected."],
        matchedServiceValues: [],
        missingOrWeakServiceValues: [],
        oldFrameRisks: [],
        unsupportedOrNeedsConfirmation: [],
        manualFixSuggestions: [],
      },
      serviceBrief,
    );

    expect(report?.missingOrWeakServiceValues.join(" ")).toMatch(
      /target buyer need/i,
    );
    expect(report?.oldFrameRisks.join(" ")).toMatch(/public-sector workforce/i);
    expect(report?.manualFixSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: "summary" }),
        expect.objectContaining({ section: "experience" }),
      ]),
    );
  });
});
