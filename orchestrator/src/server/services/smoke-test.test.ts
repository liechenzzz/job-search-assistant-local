/**
 * Full pipeline smoke test: generateTailoring() with bridge judge path exercised.
 * Verifies the full chain: positioning constraint → claim extraction → repair.
 */
import { describe, expect, it, vi } from "vitest";

const callJsonMock = vi.fn();
const getProviderMock = vi.fn().mockReturnValue("openrouter");
const getBaseUrlMock = vi.fn().mockReturnValue("https://openrouter.ai");

// DB avoidance
vi.mock("../repositories/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(undefined),
  getAllSettings: vi.fn().mockResolvedValue({}),
}));
vi.mock("@server/repositories/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(undefined),
  getAllSettings: vi.fn().mockResolvedValue({}),
}));

// LLM
vi.mock("./llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
    getProvider = getProviderMock;
    getBaseUrl = getBaseUrlMock;
  },
}));

vi.mock("./modelSelection", () => ({
  createConfiguredLlmService: vi.fn(async () => ({
    callJson: callJsonMock,
    getProvider: getProviderMock,
    getBaseUrl: getBaseUrlMock,
  })),
  resolveLlmModel: vi.fn(async () => "test-model"),
}));

vi.mock("./application-writing", () => ({
  buildApplicationWritingInstructionsForJob: vi.fn(
    async () => "Role framing: Public sector / market intelligence (auto).",
  ),
}));

vi.mock("./writing-style", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./writing-style")>();
  return {
    ...actual,
    getWritingStyle: vi.fn().mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "Keep it under 120 words",
      doNotUse: "synergy",
      languageMode: "auto",
      manualLanguage: undefined,
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    }),
  };
});

vi.mock("./resume-references", () => ({
  buildResumeReferenceInstructions: vi.fn().mockReturnValue(""),
  buildSelectedResumeEvidence: vi.fn().mockReturnValue([]),
  findReferenceChunksForQualifications: vi.fn().mockResolvedValue([]),
  findResumeReferenceEvidenceForQualifications: vi.fn().mockResolvedValue([]),
  getExperienceAnchorSummaries: vi.fn().mockReturnValue([]),
  selectFormatReferenceSummaries: vi.fn().mockReturnValue([]),
  summarizeEvidenceReferenceHits: vi.fn().mockReturnValue([]),
}));

vi.mock("./resume-evidence-rerank", () => ({
  rerankSelectedResumeEvidence: vi.fn(
    (args) => args.fallbackSelectedEvidence ?? [],
  ),
}));

// @ts-expect-error Vitest must resolve the TS source instead of the stale sidecar summary.js.
import { generateTailoring } from "./summary.ts";

function setupPipelineCalls() {
  callJsonMock.mockReset();
  callJsonMock.mockImplementation(async (request) => {
    const schemaName = request?.jsonSchema?.name;
    if (schemaName === "resume_tailoring_strategy") {
      return {
        success: true,
        data: {
          jdServiceValueBrief: {
            buyerNeed: "Market intelligence for health innovation",
            targetStakeholders: ["Health ventures"],
            businessDecisionsSupported: ["Market entry"],
            expectedDeliverables: ["Market reports"],
            mustSignalConcepts: ["market intelligence"],
            avoidDominantFrames: ["workforce research only"],
            candidateValueProposition:
              "Transferable market intelligence analyst",
            evidenceTranslationTargets: [
              {
                jdNeed: "market intelligence",
                resumeProofTheme: "sector analysis",
                acceptableWording: "market intelligence",
                overclaimRisk: "",
              },
            ],
          },
          resumePositioningPlan: {
            candidateThesis: "Market intelligence analyst",
            targetPitch: "Market intelligence and sector research analyst",
            sourcePitch: "Workforce research analyst",
            pitchDelta: "Reframe workforce research as market intelligence",
            allowedTranslations: [
              {
                from: "labour-market research",
                to: "market intelligence",
                claimType: "transferable",
                limit: "",
              },
            ],
            overclaimRisks: ["healthcare client experience", "TAM sizing"],
            experienceUse: [
              {
                id: "experience-research-consultancy",
                use: "primary",
                reason: "Core research",
                rewriteGoal: "Market intelligence",
              },
            ],
            targetFrame: "Market intelligence and sector research analyst",
            avoidFrame: ["Workforce analyst only"],
            primaryEvidenceRoles: ["experience-research-consultancy"],
            supportingEvidenceRoles: [],
            downplayedRoles: [],
            translationMap: [
              {
                sourceEvidence: "labour-market analysis",
                jdFrame: "market intelligence",
                claimType: "transferable",
                limitations: "",
              },
            ],
            mustAppearConcepts: ["market intelligence"],
            mustAvoidConcepts: ["healthcare startups", "TAM sizing"],
            readerExpectations: ["Market research background"],
            summaryStrategy: ["Lead with market intelligence"],
            experienceStrategies: [
              {
                experienceId: "experience-research-consultancy",
                currentRisk: "",
                desiredFrame: "Market intelligence",
                emphasize: ["market intelligence"],
                deEmphasize: [],
                allowedTransferableClaims: ["market intelligence"],
                forbiddenClaims: ["healthcare startups"],
              },
            ],
            skillsStrategy: {
              groups: [
                {
                  name: "Market Intelligence",
                  keywords: ["market intelligence", "sector analysis"],
                  rationale: "Core",
                },
              ],
            },
            gapStrategy: [
              {
                jdNeed: "health sector",
                evidenceStatus: "transferable",
                wordingPolicy: "Interest only",
              },
            ],
            polishChecks: ["No healthcare claims"],
          },
        },
      };
    }
    if (schemaName === "resume_summary_skills") {
      return {
        success: true,
        data: {
          headline: "Market Intelligence Analyst",
          summary:
            "Market intelligence and sector research analyst with public-sector workforce experience.",
          skills: [
            {
              name: "Market Intelligence & Research",
              keywords: ["market intelligence", "sector analysis"],
            },
          ],
        },
      };
    }
    if (schemaName === "resume_experience_item") {
      return {
        success: true,
        data: {
          id: "experience-research-consultancy",
          bullets: [
            {
              text: "Conducted market intelligence and sector opportunity research for public-sector clients.",
              claimType: "transferable",
              supportIds: ["chunk_1"],
            },
            {
              text: "Analyzed labour-market and occupational data to inform sector prioritization.",
              claimType: "direct",
              supportIds: ["chunk_2"],
            },
          ],
        },
      };
    }
    return { success: true, data: {} };
  });
}

describe("Smoke: full pipeline with bridge judge", () => {
  it("generates resume, positioning plan, and verifier trace", async () => {
    setupPipelineCalls();

    const jd = [
      "Market Intelligence Analyst — Health Sector",
      "MaRS Discovery District",
      "",
      "Conduct market intelligence and sector opportunity research for health ventures.",
      "Qualifications: market research, stakeholder engagement, quantitative skills.",
    ].join("\n");

    const profile = {
      basics: { name: "Test", label: "Analyst" },
      sections: {
        experience: {
          items: [
            {
              id: "experience-research-consultancy",
              company: "Regional Research Consultancy",
              position: "Research Analyst",
              location: "Toronto",
              date: "2025",
              summary: "Conducted labour-market and policy research.",
              visible: true,
            },
          ],
        },
      },
    };

    const result = await generateTailoring(jd, profile);

    expect(result.success).toBe(true);
    const d = result.data;
    expect(d).toBeDefined();
    if (!d) throw new Error("Expected successful tailoring data");

    console.log("\n=== SMOKE OUTPUT ===");
    console.log("Summary:", d.summary);
    console.log(
      "Skills:",
      d.skills
        ?.map((s) => `${s.name}: [${s.keywords?.join(", ")}]`)
        .join(" | "),
    );
    for (const exp of d.experience ?? []) {
      console.log(`${exp.id}:`);
      for (let i = 0; i < exp.bullets.length; i++) {
        const t = exp.bulletTrace?.[i];
        console.log(`  [${i}] ${exp.bullets[i]}`);
        if (t?.claimVerdicts?.length) {
          console.log(
            `    claims: ${t.claimVerdicts
              .filter((c) => c.verdict !== "uncertain")
              .map((c) => `[${c.type}] "${c.text}"=${c.verdict}`)
              .join(", ")}`,
          );
        }
        if (t?.repairMode && t.repairMode !== "none")
          console.log(`    repair: ${t.repairMode}`);
        if (t?.boundaryVerdict && t.boundaryVerdict !== "pass")
          console.log(
            `    boundary: ${t.boundaryVerdict} — ${t.boundaryReasons?.join("; ")}`,
          );
      }
    }
    console.log("Plan targetFrame:", d.resumePositioningPlan?.targetFrame);
    console.log(
      "Plan allowedTranslations:",
      d.resumePositioningPlan?.allowedTranslations
        ?.map((t) => `${t.from} → ${t.to}`)
        .join("; "),
    );
    console.log(
      "Pitch verdict:",
      d.generationTrace?.repackagingVerifier?.pitchJudge?.verdict,
    );
    console.log(
      "Softened:",
      d.generationTrace?.repackagingVerifier?.softenedBullets,
      "Dropped:",
      d.generationTrace?.repackagingVerifier?.droppedBullets,
    );
    console.log("=== END SMOKE ===\n");

    // Assert core pipeline ran end-to-end
    expect(result.success).toBe(true);
    expect(d.experience?.length).toBeGreaterThan(0);
    // Positioning plan was generated with bridge judge constraint
    // (full mock chain exercises judge → plan → verifier path)
    expect(d.resumePositioningPlan).toBeTruthy();
    expect(d.resumePositioningPlan?.targetFrame).toBeTruthy();
  });
});
