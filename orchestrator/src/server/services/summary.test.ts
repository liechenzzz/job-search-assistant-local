import type {
  ResumeGenerationReferenceSummary,
  ResumeProfile,
} from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeReferenceKnowledgeHit } from "./resume-references";

const {
  callJsonMock,
  getProviderMock,
  getBaseUrlMock,
  buildResumeReferenceInstructionsMock,
  buildSelectedResumeEvidenceMock,
  findReferenceChunksForQualificationsMock,
  findResumeReferenceEvidenceForQualificationsMock,
  getExperienceAnchorSummariesMock,
  selectFormatReferenceSummariesMock,
  summarizeEvidenceReferenceHitsMock,
  rerankSelectedResumeEvidenceMock,
  getSettingMock,
} = vi.hoisted(() => ({
  callJsonMock: vi.fn(),
  getProviderMock: vi.fn(),
  getBaseUrlMock: vi.fn(),
  buildResumeReferenceInstructionsMock: vi.fn(),
  buildSelectedResumeEvidenceMock: vi.fn(
    ({
      qualificationProfile,
      knowledgeHits,
    }: {
      qualificationProfile: { required: string[] };
      knowledgeHits: ResumeReferenceKnowledgeHit[];
    }) =>
      qualificationProfile.required.slice(0, 8).map((requirement) => {
        const normalizedRequirement = requirement.toLowerCase();
        const hit = knowledgeHits.find((item) => {
          const normalizedHit = item.qualification.toLowerCase();
          return (
            normalizedHit === normalizedRequirement ||
            normalizedRequirement.includes(normalizedHit) ||
            normalizedHit.includes(normalizedRequirement)
          );
        });
        return hit?.chunks.length
          ? {
              requirement,
              status: "selected",
              chunks: hit.chunks.map((chunk) => ({
                chunkId: chunk.id,
                clusterId: chunk.clusterId,
                evidenceGroupId: chunk.evidenceGroupId,
                evidenceGroupLabel: chunk.evidenceGroupLabel,
                sourceFile: chunk.fileName,
                relativePath: chunk.relativePath,
                section: chunk.section,
                roleFamily: chunk.roleFamily,
                rawText: chunk.rawText ?? chunk.text,
                keywords: chunk.keywords,
                qualitySignals: chunk.qualitySignals,
              })),
            }
          : {
              requirement,
              status: "no_evidence",
              chunks: [],
              missingReason:
                "No matching resume evidence chunk found in the evidence bank.",
            };
      }),
  ),
  findReferenceChunksForQualificationsMock: vi.fn(),
  findResumeReferenceEvidenceForQualificationsMock: vi.fn(),
  getExperienceAnchorSummariesMock: vi.fn(),
  selectFormatReferenceSummariesMock: vi.fn(),
  summarizeEvidenceReferenceHitsMock: vi.fn(
    (hits: ResumeReferenceKnowledgeHit[]): ResumeGenerationReferenceSummary[] =>
      hits.flatMap((hit) =>
        hit.chunks.map((chunk) => ({
          purpose: "evidence",
          fileName: chunk.fileName,
          relativePath: chunk.relativePath,
          roleFamily: chunk.roleFamily,
          section: chunk.section,
        })),
      ),
  ),
  rerankSelectedResumeEvidenceMock: vi.fn(
    async ({
      fallbackSelectedEvidence,
    }: {
      fallbackSelectedEvidence: unknown;
    }) => fallbackSelectedEvidence,
  ),
  getSettingMock: vi.fn(),
}));

vi.mock("../repositories/settings", () => ({
  getSetting: getSettingMock,
  getAllSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("@server/repositories/settings", () => ({
  getSetting: getSettingMock,
  getAllSettings: vi.fn().mockResolvedValue({}),
}));

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
  resolveLlmModel: vi.fn(async () => "test-tailoring-model"),
}));

vi.mock("./application-writing", () => ({
  buildApplicationWritingInstructionsForJob: vi.fn(async () =>
    [
      "Role framing: Public sector / policy / economic development (auto).",
      "Impact and quantification rules:",
      "Humanizer revision rules:",
    ].join("\n"),
  ),
}));

vi.mock("./writing-style", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./writing-style")>();

  return {
    ...actual,
    getWritingStyle: vi.fn(),
  };
});

vi.mock("./resume-references", () => ({
  buildResumeReferenceInstructions: buildResumeReferenceInstructionsMock,
  buildSelectedResumeEvidence: buildSelectedResumeEvidenceMock,
  findReferenceChunksForQualifications:
    findReferenceChunksForQualificationsMock,
  findResumeReferenceEvidenceForQualifications:
    findResumeReferenceEvidenceForQualificationsMock,
  getExperienceAnchorSummaries: getExperienceAnchorSummariesMock,
  selectFormatReferenceSummaries: selectFormatReferenceSummariesMock,
  summarizeEvidenceReferenceHits: summarizeEvidenceReferenceHitsMock,
}));

vi.mock("./resume-evidence-rerank", () => ({
  rerankSelectedResumeEvidence: rerankSelectedResumeEvidenceMock,
}));

import { getSetting } from "../repositories/settings";
import { resolveLlmModel } from "./modelSelection";
// @ts-expect-error Vitest must resolve the TS source instead of the stale sidecar summary.js.
import { generateTailoring } from "./summary.ts";
import { getWritingStyle } from "./writing-style";

const POSITIONING_PLAN = {
  candidateThesis:
    "Market intelligence analyst translating research into venture-support recommendations.",
  targetPitch:
    "Market intelligence analyst supporting venture decisions through research, data analysis, and client-ready recommendations.",
  sourcePitch:
    "Public-sector workforce development and labour-market research analyst.",
  pitchDelta:
    "Translate sector and workforce research evidence into market intelligence and venture-support language without claiming direct health venture ownership.",
  allowedTranslations: [
    {
      from: "sector research and stakeholder-ready recommendations",
      to: "market intelligence and client deliverables",
      claimType: "transferable",
      limit: "Do not claim direct health venture advising.",
    },
  ],
  overclaimRisks: [
    "Do not claim direct health sector experience.",
    "Do not claim venture investment due diligence.",
  ],
  experienceUse: [
    {
      id: "exp-1",
      use: "primary",
      reason:
        "Best evidence for research, analysis, and client-ready recommendations.",
      rewriteGoal:
        "market and sector intelligence for client-ready recommendations",
    },
  ],
  targetFrame: "Market intelligence analyst for venture-support decisions.",
  avoidFrame: [
    "public-sector policy-only analyst",
    "labour-market-only analyst",
  ],
  primaryEvidenceRoles: ["exp-1"],
  supportingEvidenceRoles: [],
  downplayedRoles: [],
  translationMap: [
    {
      sourceEvidence: "sector research and stakeholder-ready recommendations",
      jdFrame: "market intelligence and client deliverables",
      claimType: "transferable",
      limitations: "Do not claim direct health venture advising.",
    },
  ],
  mustAppearConcepts: ["market intelligence"],
  mustAvoidConcepts: ["labour-market-only"],
  readerExpectations: [
    "market research",
    "client-ready recommendations",
    "data-backed deliverables",
  ],
  summaryStrategy: [
    "Lead with market intelligence positioning",
    "Connect research, analytics, and client-ready outputs",
  ],
  experienceStrategies: [
    {
      experienceId: "exp-1",
      currentRisk: "Could read as generic policy research.",
      desiredFrame: "Client-facing market and sector intelligence work.",
      emphasize: ["market research", "stakeholder-ready recommendations"],
      deEmphasize: ["administrative process details"],
      allowedTransferableClaims: ["research framework development"],
      forbiddenClaims: ["Do not claim direct budget ownership."],
    },
  ],
  skillsStrategy: {
    groups: [
      {
        name: "Market Intelligence & Research",
        keywords: ["Market Research", "Sector Analysis"],
        rationale: "Matches JD market intelligence language.",
      },
      {
        name: "Data Analysis & Modelling",
        keywords: ["Excel", "Data Cleaning"],
        rationale: "Keeps analytical tools visible.",
      },
      {
        name: "Client Deliverables",
        keywords: ["PowerPoint", "Executive Reports"],
        rationale: "Highlights client-ready outputs.",
      },
    ],
  },
  gapStrategy: [
    {
      jdNeed: "Health sector knowledge",
      evidenceStatus: "weak",
      wordingPolicy:
        "Use health innovation interest or transferable research methods; do not claim deep health sector experience.",
    },
  ],
  polishChecks: ["Avoid unsupported direct claims."],
};

const DEFAULT_TAILORING_RESPONSE = {
  success: true,
  data: {
    summary: "Tailored summary",
    headline: "Senior Engineer",
    skills: [],
    experience: [],
  },
};

const DEFAULT_SERVICE_VALUE_BRIEF = {
  buyerNeed:
    "Market intelligence that helps high-growth health and technology ventures make growth decisions.",
  targetStakeholders: ["venture clients", "market intelligence team"],
  businessDecisionsSupported: [
    "market opportunity assessment",
    "partnership and growth prioritization",
  ],
  expectedDeliverables: [
    "client-ready recommendations",
    "market research briefs",
  ],
  mustSignalConcepts: [
    "market intelligence",
    "venture clients",
    "market opportunity",
  ],
  avoidDominantFrames: ["generic workforce analytics", "public-sector policy"],
  candidateValueProposition:
    "Translate research and analytical evidence into client-ready market intelligence recommendations.",
  evidenceTranslationTargets: [
    {
      jdNeed: "market intelligence for ventures",
      resumeProofTheme: "sector research and client-ready recommendations",
      acceptableWording:
        "market intelligence and recommendations for growth-oriented decisions",
      overclaimRisk: "Do not claim direct venture portfolio ownership.",
    },
  ],
};

const DEFAULT_SERVICE_FIT_REPORT = {
  status: "pass",
  score: 90,
  targetBuyerNeed: DEFAULT_SERVICE_VALUE_BRIEF.buyerNeed,
  resumeCurrentlySignals: [
    "market intelligence",
    "client-ready recommendations",
  ],
  matchedServiceValues: ["market opportunity analysis"],
  missingOrWeakServiceValues: [],
  oldFrameRisks: [],
  unsupportedOrNeedsConfirmation: [],
  manualFixSuggestions: [],
};

function mockCallJsonSequenceWithPlan(
  positioningPlan: typeof POSITIONING_PLAN,
  ...responses: unknown[]
) {
  const queue = [...responses];
  callJsonMock.mockImplementation(async (request) => {
    const schemaName = request?.jsonSchema?.name;
    if (schemaName === "jd_service_value_brief") {
      return {
        success: true,
        data: DEFAULT_SERVICE_VALUE_BRIEF,
      };
    }
    if (schemaName === "resume_positioning_plan") {
      return {
        success: true,
        data: positioningPlan,
      };
    }
    if (schemaName === "resume_tailoring_strategy") {
      return {
        success: true,
        data: {
          jdServiceValueBrief: DEFAULT_SERVICE_VALUE_BRIEF,
          resumePositioningPlan: positioningPlan,
        },
      };
    }
    if (schemaName === "resume_tailoring_compact_judge") {
      const next = queue[0] as
        | { data?: { verdict?: string; serviceFitReport?: unknown } }
        | undefined;
      if (
        next?.data?.verdict === "pass" ||
        next?.data?.verdict === "needs_patch"
      ) {
        return queue.shift();
      }
      return {
        success: true,
        data: {
          verdict: "pass",
          failedSections: [],
          failedExperienceIds: [],
          reason: "ok",
          serviceFitReport: DEFAULT_SERVICE_FIT_REPORT,
        },
      };
    }
    if (schemaName === "resume_tailoring_patch") {
      const next = queue[0] as
        | {
            data?: {
              summarySkillsPatch?: unknown;
              experiencePatches?: unknown;
            };
          }
        | undefined;
      if (next?.data?.summarySkillsPatch || next?.data?.experiencePatches) {
        return queue.shift();
      }
      return {
        success: true,
        data: {
          summarySkillsPatch: {},
          experiencePatches: [],
          reason: "no patch",
        },
      };
    }
    if (schemaName === "experience_capability_digest") {
      return {
        success: true,
        data: { items: [] },
      };
    }
    if (schemaName === "resume_alignment_coverage_judge") {
      const next = queue[0] as { data?: { items?: unknown[] } } | undefined;
      if (Array.isArray(next?.data?.items)) {
        return queue.shift();
      }
      return {
        success: true,
        data: { items: [] },
      };
    }
    if (schemaName === "resume_pitch_judge") {
      const next = queue[0] as { data?: { verdict?: string } } | undefined;
      if (next?.data?.verdict === "pass" || next?.data?.verdict === "fail") {
        return queue.shift();
      }
      return {
        success: true,
        data: {
          verdict: "pass",
          dominantPitchDetected:
            positioningPlan.targetPitch ?? positioningPlan.targetFrame,
          targetPitchMatched: true,
          sourcePitchDominating: false,
          failedSections: [],
          failedExperienceIds: [],
          reasons: [],
        },
      };
    }
    if (schemaName === "resume_service_fit_verifier") {
      const next = queue[0] as
        | { data?: { targetBuyerNeed?: string; status?: string } }
        | undefined;
      if (
        next?.data?.targetBuyerNeed ||
        next?.data?.status === "needs_review" ||
        next?.data?.status === "weak_fit"
      ) {
        return queue.shift();
      }
      return {
        success: true,
        data: DEFAULT_SERVICE_FIT_REPORT,
      };
    }
    return queue.shift() ?? DEFAULT_TAILORING_RESPONSE;
  });
}

function mockCallJsonSequence(...responses: unknown[]) {
  mockCallJsonSequenceWithPlan(POSITIONING_PLAN, ...responses);
}

function promptContaining(marker: string): string {
  return String(
    callJsonMock.mock.calls
      .map((call) => call[0]?.messages?.[0]?.content)
      .reverse()
      .find((content) => String(content ?? "").includes(marker)) ?? "",
  );
}

describe("generateTailoring", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getProviderMock.mockReturnValue("openrouter");
    getBaseUrlMock.mockReturnValue("https://openrouter.ai");
    mockCallJsonSequence();
    buildResumeReferenceInstructionsMock.mockResolvedValue("");
    findReferenceChunksForQualificationsMock.mockResolvedValue([]);
    findResumeReferenceEvidenceForQualificationsMock.mockResolvedValue([]);
    getExperienceAnchorSummariesMock.mockResolvedValue([]);
    selectFormatReferenceSummariesMock.mockResolvedValue([]);
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "Keep it under 90 words",
      doNotUse: "synergy",
      languageMode: "manual",
      manualLanguage: "german",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    });
  });

  it("routes DeepSeek tailoring stages across pro and flash models", async () => {
    vi.mocked(resolveLlmModel).mockResolvedValueOnce("deepseek-v4-pro");

    await generateTailoring("Build APIs", {
      basics: {
        name: "Test User",
        label: "Engineer",
        summary: "Existing summary",
      },
    });

    const models = callJsonMock.mock.calls.map((call) => call[0]?.model);
    expect(models).toContain("deepseek-v4-pro");
    expect(models).toContain("deepseek-v4-flash");
  });

  it("passes shared writing-style and language instructions into tailoring prompts", async () => {
    const profile: ResumeProfile = {
      basics: {
        name: "Test User",
        label: "Engineer",
        summary: "Existing summary",
      },
    };

    await generateTailoring("Build APIs", profile);

    expect(callJsonMock.mock.calls.length).toBeGreaterThanOrEqual(1);

    const prompt = promptContaining("WRITING STYLE:");
    expect(prompt).toContain("WRITING STYLE:");
    expect(prompt).toContain("Tone: friendly");
    expect(prompt).toContain("Formality: low");
    expect(prompt).toContain("Additional constraints: Keep it under 90 words");
    expect(prompt).toContain("Avoid these words or phrases: synergy");
    expect(prompt).toContain("Output language for summary and skills: German");
    expect(prompt).toContain(
      "CRITICAL: Match the Job Title from the JD exactly.",
    );
    expect(prompt).toContain("Do NOT translate or paraphrase.");
  });

  it("adds application writing strategy instructions to tailoring prompts", async () => {
    const profile: ResumeProfile = {
      basics: {
        name: "Test User",
        label: "Policy Analyst",
        summary: "Existing summary",
      },
    };

    await generateTailoring(
      "Prepare municipal policy briefings, workforce KPIs, stakeholder evidence packs, and regional labour market analysis.",
      profile,
      {
        jobTitle: "Economic Development Policy Analyst",
        employer: "City of Toronto",
      },
    );

    const prompt = promptContaining("EXPERIENCE BULLET BUNDLE CANDIDATES");
    expect(prompt).toContain("APPLICATION WRITING STRATEGY:");
    expect(prompt).toContain(
      "Role framing: Public sector / policy / economic development (auto).",
    );
    expect(prompt).toContain("Impact and quantification rules:");
    expect(prompt).toContain("Humanizer revision rules:");
  });

  it("builds and injects a positioning plan for market intelligence health roles", async () => {
    const marsPlan = {
      ...POSITIONING_PLAN,
      targetFrame:
        "Health innovation market intelligence analyst supporting venture growth and client-ready decisions.",
      avoidFrame: [
        "public-sector policy-only analyst",
        "labour-market-only analyst",
      ],
      experienceStrategies: [
        {
          experienceId: "research",
          currentRisk: "May read as labour-market research only.",
          desiredFrame:
            "Sector intelligence and market opportunity research for client-ready recommendations.",
          emphasize: [
            "sector intelligence",
            "market opportunity",
            "client-ready recommendations",
          ],
          deEmphasize: ["narrow labour-market terminology"],
          allowedTransferableClaims: ["analytical frameworks"],
          forbiddenClaims: [
            "Do not claim direct health venture portfolio ownership.",
          ],
        },
        {
          experienceId: "idea",
          currentRisk: "Could be understated as regional economic development.",
          desiredFrame:
            "Startup ecosystem, business needs, partnership, and venture-support research.",
          emphasize: [
            "startup ecosystem",
            "business needs",
            "partnership opportunities",
          ],
          deEmphasize: ["generic municipal context"],
          allowedTransferableClaims: ["venture-support priorities"],
          forbiddenClaims: ["Do not claim VC investment decision ownership."],
        },
      ],
      gapStrategy: [
        {
          jdNeed: "Strong knowledge and interest in the Health sector.",
          evidenceStatus: "weak",
          wordingPolicy:
            "Position as health innovation interest plus transferable market research methods; do not claim deep health sector experience.",
        },
      ],
    };
    mockCallJsonSequenceWithPlan(marsPlan, {
      success: true,
      data: {
        summary:
          "Market intelligence analyst supporting venture growth through sector research, data analysis, and client-ready recommendations, with a strong interest in health innovation.",
        headline: "Analyst, Market Intelligence - Health",
        skills: [
          {
            name: "Market Intelligence & Research",
            keywords: ["Market Research", "Market Opportunity Assessment"],
          },
          {
            name: "Data Analysis & Modelling",
            keywords: ["Excel", "Data Cleaning"],
          },
          {
            name: "Client Deliverables",
            keywords: ["PowerPoint", "Executive Reports"],
          },
        ],
        experience: [
          {
            id: "research",
            bullets: [
              "Translated sector trends and regional strategy evidence into client-ready recommendations for workforce and economic development clients.",
            ],
          },
          {
            id: "idea",
            bullets: [
              "Conducted startup ecosystem research to assess business needs, service gaps, partnership opportunities, and venture-support priorities.",
            ],
          },
        ],
      },
    });

    const result = await generateTailoring(
      [
        "Analyst, Market Intelligence - Health",
        "Lead market research projects for high-growth ventures.",
        "Qualifications include health sector interest, market opportunity assessment, competitive intelligence, partnership identification, Excel, and PowerPoint.",
      ].join("\n"),
      {
        basics: { name: "Test User", summary: "Research analyst" },
        sections: {
          experience: {
            items: [
              {
                id: "research",
                company: "Regional Research Consultancy",
                position: "Associate Consultant",
                date: "2026",
                summary:
                  "Led regional workforce and sector research with evidence packs and recommendations.",
                visible: true,
              },
              {
                id: "idea",
                company: "Municipal Innovation Hub",
                position: "Research Analyst",
                date: "2025",
                summary:
                  "Analyzed entrepreneurship ecosystem data, stakeholder interviews, and business support gaps.",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
      {
        jobTitle: "Analyst, Market Intelligence - Health",
        employer: "MaRS Discovery District",
      },
    );

    expect(result.data?.resumePositioningPlan?.targetFrame).toContain(
      "Health innovation market intelligence",
    );
    expect(result.data?.resumePositioningPlan?.avoidFrame).toEqual(
      expect.arrayContaining([
        "public-sector policy-only analyst",
        "labour-market-only analyst",
      ]),
    );
    expect(
      result.data?.resumePositioningPlan?.experienceStrategies
        .map((item) => item.desiredFrame)
        .join(" "),
    ).toMatch(/sector intelligence|startup ecosystem/i);
    expect(result.data?.resumePositioningPlan?.gapStrategy[0]).toMatchObject({
      evidenceStatus: "weak",
    });
    expect(result.data?.jdServiceValueBrief?.buyerNeed).toContain(
      "Market intelligence",
    );
    expect(result.data?.resumeServiceFitReport?.status).toBe("pass");
    expect(promptContaining("JD SERVICE VALUE BRIEF")).toContain(
      "venture clients",
    );
    expect(promptContaining("RESUME POSITIONING PLAN")).toContain(
      "Target frame: Health innovation market intelligence analyst",
    );
    expect(promptContaining("RESUME POSITIONING PLAN")).toContain(
      "do not claim deep health sector experience",
    );
    expect(result.data?.summary).toContain("health innovation");
  });

  it("sanitizes partial combined service-value briefs before prompt formatting", async () => {
    const queue = [
      {
        success: true,
        data: {
          summary: "Market research analyst with sector analysis experience.",
          headline: "Market Research Analyst",
          skills: [
            { name: "Market Research", keywords: ["Sector Analysis", "Excel"] },
          ],
        },
      },
      {
        success: true,
        data: {
          id: "research",
          bullets: [
            "Translated sector research into market research recommendations for stakeholders.",
          ],
        },
      },
      {
        success: true,
        data: {
          verdict: "pass",
          failedSections: [],
          failedExperienceIds: [],
          reason: "ok",
          serviceFitReport: DEFAULT_SERVICE_FIT_REPORT,
        },
      },
    ];
    callJsonMock.mockImplementation(async (request) => {
      const schemaName = request?.jsonSchema?.name;
      if (schemaName === "resume_tailoring_strategy") {
        return {
          success: true,
          data: {
            jdServiceValueBrief: {
              buyerNeed: "Market research for growth decisions.",
              candidateValueProposition:
                "Translate sector research into market research recommendations.",
            },
            resumePositioningPlan: POSITIONING_PLAN,
          },
        };
      }
      if (schemaName === "experience_capability_digest") {
        return { success: true, data: { items: [] } };
      }
      return queue.shift() ?? DEFAULT_TAILORING_RESPONSE;
    });

    const result = await generateTailoring(
      "Conduct market research and prepare client-ready recommendations.",
      {
        basics: { name: "Test User", summary: "Research analyst" },
        sections: {
          experience: {
            items: [
              {
                id: "research",
                company: "Regional Research Consultancy",
                position: "Associate Consultant",
                date: "2026",
                summary:
                  "Prepared sector research and evidence packs for stakeholders.",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
    );

    expect(result.success).toBe(true);
    expect(result.data?.jdServiceValueBrief?.targetStakeholders).toEqual([]);
    expect(promptContaining("JD SERVICE VALUE BRIEF")).toContain(
      "Target stakeholders: None listed.",
    );
  });

  it("forces a patch when a MaRS-style JD lacks visible market intelligence framing", async () => {
    mockCallJsonSequenceWithPlan(
      POSITIONING_PLAN,
      {
        success: true,
        data: {
          summary:
            "Research analyst experienced in workforce development evidence packs and regional policy reports.",
          headline: "Research Analyst",
          skills: [
            {
              name: "Research & Reporting",
              keywords: ["Evidence Packs", "PowerPoint"],
            },
          ],
        },
      },
      {
        success: true,
        data: {
          id: "research",
          bullets: [
            {
              text: "Conducted labour-market and workforce development research for regional policy projects.",
              claimType: "transferable",
              supportIds: [],
              positioningIntent: "Source-domain summary.",
              riskFlags: [],
            },
          ],
        },
      },
      {
        success: true,
        data: {
          verdict: "pass",
          failedSections: [],
          failedExperienceIds: [],
          reason: "Model pass before local service-value gate.",
          serviceFitReport: DEFAULT_SERVICE_FIT_REPORT,
        },
      },
      {
        success: true,
        data: {
          summarySkillsPatch: {
            summary:
              "Market intelligence analyst translating sector research, data analysis, and stakeholder-ready evidence into client-ready recommendations.",
            headline: "Associate Consultant",
            skills: [
              {
                name: "Market Intelligence & Research",
                keywords: ["Market Research", "Business Analytics"],
              },
            ],
          },
          experiencePatches: [
            {
              id: "research",
              bullets: [
                "Translated labour-market, sector, and regional strategy evidence into market intelligence and business analytics recommendations for client-facing decisions.",
              ],
            },
          ],
          reason: "Patch old-domain wording into JD buyer language.",
        },
      },
      {
        success: true,
        data: {
          verdict: "pass",
          failedSections: [],
          failedExperienceIds: [],
          reason: "Patch now includes market intelligence framing.",
          serviceFitReport: DEFAULT_SERVICE_FIT_REPORT,
        },
      },
    );

    const result = await generateTailoring(
      [
        "Associate Consultant, Market Intelligence",
        "Conduct market intelligence and market research for growth decisions.",
        "Prepare client-ready recommendations using Excel, PowerPoint, and business/data analytics.",
      ].join("\n"),
      {
        basics: { name: "Test User", summary: "Research analyst" },
        sections: {
          experience: {
            items: [
              {
                id: "research",
                company: "Regional Research Consultancy",
                position: "Associate Consultant",
                date: "2026",
                summary:
                  "Conducted labour-market and workforce development research for regional policy projects.",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
      {
        jobTitle: "Associate Consultant, Market Intelligence",
        employer: "MaRS Discovery District",
      },
    );

    expect(result.llmTrace?.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining(["compact_judge", "repair_patch"]),
    );
    expect(result.data?.summary).toMatch(/Market intelligence/i);
    expect(result.data?.experience[0]?.bullets.join(" ")).toMatch(
      /market intelligence|business analytics/i,
    );
    expect(result.data?.experience[0]?.bullets.join(" ")).not.toMatch(
      /direct health sector expertise|consumer insights|CPG category strategy/i,
    );
  });

  it("uses pitch judge targeted rewrite when MaRS summary stays in workforce framing", async () => {
    const marsPlan = {
      ...POSITIONING_PLAN,
      targetPitch:
        "Market intelligence analyst supporting health innovation ventures through research, data analysis, and client-ready recommendations.",
      sourcePitch: "Workforce development and labour-market research analyst.",
      pitchDelta:
        "Translate workforce and sector research into market intelligence, market opportunity, and venture-support language.",
      targetFrame:
        "Health innovation market intelligence analyst supporting venture growth and client-ready decisions.",
      avoidFrame: ["workforce development analyst", "labour-market analyst"],
      mustAppearConcepts: ["market intelligence", "venture support"],
      mustAvoidConcepts: ["workforce development"],
      experienceUse: [
        {
          id: "research",
          use: "primary",
          reason:
            "Sector research and evidence-pack work support market intelligence framing.",
          rewriteGoal:
            "sector intelligence, market opportunity, and client-ready recommendations",
        },
      ],
    };
    mockCallJsonSequenceWithPlan(
      marsPlan,
      {
        success: true,
        data: {
          summary:
            "Workforce development analyst with experience preparing labour-market evidence packs and stakeholder reports.",
          headline: "Analyst, Market Intelligence - Health",
          skills: [
            {
              name: "Market Intelligence & Research",
              keywords: ["Market Research", "Sector Analysis"],
            },
            {
              name: "Data Analysis & Modelling",
              keywords: ["Excel", "Data Cleaning"],
            },
            {
              name: "Client Deliverables",
              keywords: ["PowerPoint", "Executive Reports"],
            },
          ],
        },
      },
      {
        success: true,
        data: {
          id: "research",
          bullets: [
            {
              text: "Translated sector trends and workforce evidence into client-ready recommendations for regional strategy clients.",
              claimType: "transferable",
              supportIds: [],
              positioningIntent:
                "Use workforce research as transferable market intelligence evidence.",
              riskFlags: [],
            },
          ],
        },
      },
      {
        success: true,
        data: {
          verdict: "needs_patch",
          failedSections: ["summary"],
          failedExperienceIds: [],
          reason: "Summary lead still presents sourcePitch.",
          serviceFitReport: {
            ...DEFAULT_SERVICE_FIT_REPORT,
            status: "needs_review",
            score: 78,
          },
        },
      },
      {
        success: true,
        data: {
          summarySkillsPatch: {
            summary:
              "Market intelligence analyst supporting health innovation ventures through sector research, data analysis, and client-ready recommendations; applies transferable workforce and market evidence methods without claiming direct health sector experience.",
            headline: "Analyst, Market Intelligence - Health",
            skills: [
              {
                name: "Market Intelligence & Research",
                keywords: ["Market Research", "Market Opportunity Assessment"],
              },
              {
                name: "Data Analysis & Modelling",
                keywords: ["Excel", "Data Cleaning"],
              },
              {
                name: "Client Deliverables",
                keywords: ["PowerPoint", "Executive Reports"],
              },
            ],
          },
          experiencePatches: [],
          reason: "Refocus summary lead.",
        },
      },
      {
        success: true,
        data: {
          verdict: "pass",
          failedSections: [],
          failedExperienceIds: [],
          reason: "Summary now matches target pitch.",
          serviceFitReport: DEFAULT_SERVICE_FIT_REPORT,
        },
      },
    );

    const result = await generateTailoring(
      [
        "Analyst, Market Intelligence - Health",
        "Lead market research projects for high-growth ventures.",
        "Qualifications include health sector interest, market opportunity assessment, competitive intelligence, partnership identification, Excel, and PowerPoint.",
      ].join("\n"),
      {
        basics: { name: "Test User", summary: "Research analyst" },
        sections: {
          experience: {
            items: [
              {
                id: "research",
                company: "Regional Research Consultancy",
                position: "Associate Consultant",
                date: "2026",
                summary:
                  "Led regional workforce and sector research with evidence packs and recommendations.",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
      {
        jobTitle: "Analyst, Market Intelligence - Health",
        employer: "MaRS Discovery District",
      },
    );

    expect(result.success).toBe(true);
    expect(result.data?.summary).toMatch(/Market intelligence/i);
    expect(result.data?.summary).not.toMatch(/^Workforce development analyst/i);
    expect(result.llmTrace?.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining(["compact_judge", "repair_patch"]),
    );
  });

  it("keeps skills compact and normalizes broad groups to master-style categories", async () => {
    mockCallJsonSequence({
      success: true,
      data: {
        summary:
          "Research analyst with market research and reporting experience.",
        headline: "Research Associate",
        skills: [
          {
            name: "Strategy & Analysis",
            keywords: ["Market Research", "Target Audience Analysis"],
          },
          {
            name: "Analytics",
            keywords: ["Excel", "Data Cleaning", "Dashboard Development"],
          },
          {
            name: "Communication",
            keywords: ["PowerPoint", "Research Reports"],
          },
          {
            name: "Tools",
            keywords: ["Stakeholder Interviews"],
          },
        ],
        experience: [],
      },
    });
    const profile: ResumeProfile = {
      basics: { name: "Test User", label: "Research Analyst" },
      sections: {
        skills: {
          items: [
            {
              id: "skill-research",
              name: "Market & Audience Research",
              description: "",
              level: 5,
              keywords: ["Market Research", "Target Audience Analysis"],
              visible: true,
            },
            {
              id: "skill-data",
              name: "Data Analysis & Quality Control",
              description: "",
              level: 5,
              keywords: ["Excel", "Data Cleaning"],
              visible: true,
            },
            {
              id: "skill-reporting",
              name: "Reporting & Analytics Tools",
              description: "",
              level: 5,
              keywords: ["PowerPoint", "Research Reports"],
              visible: true,
            },
          ],
        },
      },
    };

    const result = await generateTailoring(
      "Research Associate role requiring market research, target audience analysis, stakeholder interviews, Excel data cleaning, dashboard development, PowerPoint, and research reports.",
      profile,
      { resumeTargetPagesOverride: 2 },
    );

    expect(result.success).toBe(true);
    expect(result.data?.skills.map((group) => group.name)).toEqual([
      "Market & Audience Research",
      "Data Analysis & Quality Control",
      "Reporting & Analytics Tools",
    ]);
    expect(result.data?.skills).toHaveLength(3);
    expect(result.data?.skills.map((group) => group.name)).not.toEqual(
      expect.arrayContaining(["Strategy & Analysis", "Tools", "Communication"]),
    );
    const prompt = promptContaining(
      "Skills are compact, not a page-filling section",
    );
    expect(prompt).toContain("Skills are compact, not a page-filling section");
  });

  it("adds evidence-backed adjacent data skills only to the skills prompt", async () => {
    rerankSelectedResumeEvidenceMock.mockResolvedValueOnce([
      {
        requirement: "Data processing experience",
        requirementId: "req-data-processing",
        status: "selected",
        fit: "direct",
        confidence: "high",
        chunks: [
          {
            chunkId: "chunk-data-processing",
            sourceFile: "Data Analyst Resume.docx",
            relativePath: "refs/Data Analyst Resume.docx",
            section: "Experience",
            roleFamily: "data_analytics_operations",
            rawText:
              "Used Excel for quality assurance checks and dashboard reporting workflows.",
            keywords: ["Excel", "QA checks", "dashboard reporting"],
          },
        ],
      },
    ]);
    const profile: ResumeProfile = {
      basics: { name: "Test User", label: "Analyst" },
      sections: {
        skills: {
          items: [
            {
              id: "skill-data",
              name: "Data Analysis & Quality Control",
              description: "",
              level: 5,
              keywords: ["Excel"],
              visible: true,
            },
          ],
        },
      },
    };

    await generateTailoring(
      "Required: data processing experience for reporting workflows.",
      profile,
    );

    const prompt = promptContaining(
      "Evidence-backed adjacent skill candidates for Skills section only:",
    );
    const adjacentLine =
      prompt
        .split("\n")
        .find((line) =>
          line.startsWith(
            "Evidence-backed adjacent skill candidates for Skills section only:",
          ),
        ) ?? "";
    expect(adjacentLine).toContain("Excel");
    expect(adjacentLine).toContain("quality assurance");
    expect(adjacentLine).toContain("QA checks");
    expect(adjacentLine).toContain("dashboard reporting");
    expect(adjacentLine).not.toContain("Python");
    expect(prompt).toContain(
      "Do not use these as experience claims unless selected evidence directly supports the claim.",
    );
    expect(prompt).toContain("JD qualifications targeting skills section:");
    expect(prompt).toContain("Data processing experience");
    expect(prompt).not.toContain("- [direct] QA checks");
  });

  it("keeps summary and skills evidence scoped away from education chunks", async () => {
    rerankSelectedResumeEvidenceMock.mockResolvedValueOnce([
      {
        requirement: "Data processing experience",
        requirementId: "req-data-processing",
        status: "selected",
        fit: "direct",
        confidence: "high",
        chunks: [
          {
            chunkId: "chunk-skills-data",
            sourceFile: "Master Resume.docx",
            relativePath: "refs/Master Resume.docx",
            section: "Skills",
            roleFamily: "data_analytics_operations",
            rawText:
              "Skills include Excel dashboards, data cleaning, and reporting workflows.",
            keywords: ["Excel", "dashboards", "data cleaning"],
          },
          {
            chunkId: "chunk-education-data",
            sourceFile: "Master Resume.docx",
            relativePath: "refs/Master Resume.docx",
            section: "Education",
            roleFamily: "data_analytics_operations",
            rawText:
              "University coursework in econometrics and academic research methods.",
            keywords: ["coursework", "econometrics"],
          },
        ],
      },
    ]);

    await generateTailoring(
      "Required: data processing experience for dashboard reporting workflows.",
      {
        basics: { name: "Test User", label: "Analyst" },
        sections: {
          skills: {
            items: [
              {
                id: "skill-data",
                name: "Data Analysis",
                description: "",
                level: 5,
                keywords: ["Excel", "dashboards"],
                visible: true,
              },
            ],
          },
          experience: { items: [] },
        },
      } as unknown as ResumeProfile,
    );

    const prompt = promptContaining(
      "SECTIONED GENERATION PASS: SUMMARY AND SKILLS ONLY.",
    );
    expect(prompt).toContain("SECTION EVIDENCE POLICY:");
    expect(prompt).toContain("chunk-skills-data");
    expect(prompt).toContain("Master Resume.docx > Skills");
    expect(prompt).not.toContain("chunk-education-data");
    expect(prompt).not.toContain("University coursework in econometrics");
  });

  it("injects only selected evidence into the tailoring prompt", async () => {
    findReferenceChunksForQualificationsMock.mockResolvedValue([
      {
        qualification:
          "Experience with dashboard reporting and quality assurance.",
        chunks: [
          {
            id: "refs/Data Analyst Resume.docx#experience-0",
            relativePath: "refs/Data Analyst Resume.docx",
            fileName: "Data Analyst Resume.docx",
            kind: "resume",
            roleFamily: "data_analytics_operations",
            section: "Experience",
            text: "Built recurring dashboard reporting and quality assurance checks for operations leaders.",
            keywords: ["Dashboard", "Reporting", "Quality assurance"],
            lastModified: 10,
            size: 100,
          },
        ],
      },
    ]);
    const profile: ResumeProfile = {
      basics: { name: "Test User", summary: "Analyst" },
      sections: { experience: { items: [] } },
    };

    await generateTailoring(
      "Required: Experience with dashboard reporting and quality assurance.",
      profile,
    );

    const prompt = promptContaining("SYSTEM SELECTED EVIDENCE BANK");
    expect(prompt).toContain("SYSTEM SELECTED EVIDENCE BANK");
    expect(prompt).not.toContain("REFERENCE KNOWLEDGE HITS:");
    expect(prompt).toContain("refs/Data Analyst Resume.docx#experience-0");
    expect(prompt).toContain("Data Analyst Resume.docx > Experience");
    expect(prompt).toContain("dashboard reporting and quality assurance");
    expect(prompt).toContain("Status: selected");
    expect(prompt).toContain("Fit: direct");
  });

  it("adds source-backed bullet bundle candidates to the tailoring prompt and trace", async () => {
    findReferenceChunksForQualificationsMock.mockResolvedValue([
      {
        qualification:
          "Experience with dashboard reporting and quality assurance.",
        chunks: [
          {
            id: "refs/Data Analyst Resume.docx#experience-0",
            relativePath: "refs/Data Analyst Resume.docx",
            fileName: "Data Analyst Resume.docx",
            kind: "resume",
            roleFamily: "data_analytics_operations",
            section: "Experience",
            text: "Analytics Team: Built recurring dashboard reporting and quality assurance checks for operations leaders.",
            rawText:
              "Analytics Team: Built recurring dashboard reporting and quality assurance checks for operations leaders.",
            keywords: ["dashboard", "reporting", "quality assurance"],
            lastModified: 10,
            size: 100,
          },
        ],
      },
    ]);

    const result = await generateTailoring(
      "Required: Experience with dashboard reporting and quality assurance.",
      {
        basics: { name: "Test User", summary: "Analyst" },
        sections: {
          experience: {
            id: "experience",
            name: "Experience",
            items: [
              {
                id: "exp-analytics",
                company: "Analytics Team",
                position: "Data Analyst",
                date: "2024",
                location: "Toronto",
                summary:
                  "Built recurring dashboard reporting and quality assurance checks for operations leaders.",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
    );

    const prompt = promptContaining("EXPERIENCE BULLET BUNDLE CANDIDATES");
    expect(prompt).toContain("EXPERIENCE BULLET BUNDLE CANDIDATES");
    expect(prompt).toContain("exp-analytics:bundle:");
    expect(prompt).toContain(
      "sourceChunkIds: refs/Data Analyst Resume.docx#experience-0",
    );
    expect(prompt).toContain("Treat bulletBudget as a density hint only");
    expect(prompt).not.toContain(
      "Generate exactly each experience bulletBudget",
    );
    expect(
      result.data?.generationTrace.bulletBundleCandidates?.length ?? 0,
    ).toBeGreaterThan(0);
  });

  it("groups selected evidence by source group in the tailoring prompt", async () => {
    rerankSelectedResumeEvidenceMock.mockResolvedValueOnce([
      {
        requirement: "Dashboard reporting",
        requirementId: "req-dashboard",
        status: "selected",
        fit: "direct",
        confidence: "high",
        chunks: [
          {
            chunkId: "chunk-dashboard",
            clusterId: "cluster-dashboard",
            evidenceGroupId: "exp_anchor:anchor-dashboard",
            evidenceGroupLabel:
              "Dashboard Resume.docx > data_analytics_operations > Experience",
            sourceFile: "Dashboard Resume.docx",
            relativePath: "refs/Dashboard Resume.docx",
            section: "Experience",
            roleFamily: "data_analytics_operations",
            rawText:
              "Built recurring dashboard reporting for operations leaders.",
            keywords: ["dashboard", "reporting"],
          },
        ],
        allowedClaims: ["dashboard reporting"],
      },
      {
        requirement: "Stakeholder synthesis",
        requirementId: "req-stakeholder",
        status: "selected",
        fit: "direct",
        confidence: "high",
        chunks: [
          {
            chunkId: "chunk-stakeholder",
            clusterId: "cluster-stakeholder",
            evidenceGroupId: "exp_anchor:anchor-stakeholder",
            evidenceGroupLabel:
              "Stakeholder Resume.docx > public_policy_research > Experience",
            sourceFile: "Stakeholder Resume.docx",
            relativePath: "refs/Stakeholder Resume.docx",
            section: "Experience",
            roleFamily: "public_policy_research",
            rawText:
              "Synthesized stakeholder consultation findings into briefing materials.",
            keywords: ["stakeholder", "briefing"],
          },
        ],
        allowedClaims: ["stakeholder synthesis"],
      },
      {
        requirement: "Budget ownership",
        requirementId: "req-budget",
        status: "no_evidence",
        fit: "unsupported",
        confidence: "low",
        chunks: [],
        blockedClaims: ["Do not claim budget ownership."],
      },
    ]);
    const profile: ResumeProfile = {
      basics: { name: "Test User", summary: "Analyst" },
      sections: { experience: { items: [] } },
    };

    await generateTailoring(
      "Required: dashboard reporting, stakeholder synthesis, and budget ownership.",
      profile,
    );

    const prompt = promptContaining("Evidence grouping rule");
    const dashboardIndex = prompt.indexOf(
      "Evidence group: exp_anchor:anchor-dashboard",
    );
    const stakeholderIndex = prompt.indexOf(
      "Evidence group: exp_anchor:anchor-stakeholder",
    );
    expect(prompt).toContain("Evidence grouping rule");
    expect(dashboardIndex).toBeGreaterThanOrEqual(0);
    expect(stakeholderIndex).toBeGreaterThan(dashboardIndex);
    expect(prompt).toContain(
      "Requirement: req-dashboard | Dashboard reporting",
    );
    expect(prompt).toContain(
      "Requirement: req-stakeholder | Stakeholder synthesis",
    );
    expect(prompt).toContain("chunkId=chunk-dashboard");
    expect(prompt).toContain("chunkId=chunk-stakeholder");
    expect(prompt).toContain("Status: no_evidence");
    expect(prompt).toContain("Blocked claims: Do not claim budget ownership.");
  });

  it("adds a JD qualification profile to prompts", async () => {
    const profile: ResumeProfile = {
      basics: { name: "Test User", label: "Policy Analyst" },
      sections: {
        experience: {
          items: [
            {
              id: "exp-1",
              company: "Regional Research Consultancy",
              position: "Associate Consultant",
              location: "Toronto",
              date: "2026",
              summary: "Prepared stakeholder research and briefing materials.",
              visible: true,
            },
          ],
        },
      },
    };

    await generateTailoring(
      [
        "Associate, Policy and Stakeholder Engagement",
        "Qualifications",
        "- Experience with stakeholder engagement and policy research.",
        "- Strong writing and briefing note skills.",
      ].join("\n"),
      profile,
    );

    const prompt = promptContaining("JD REQUIREMENTS:");
    expect(prompt).toContain("JD REQUIREMENTS:");
    expect(prompt).toContain("Required qualifications:");
    expect(prompt).toContain("stakeholder engagement");
  });

  it("filters unrelated skill piles and returns a short failed alignment report", async () => {
    mockCallJsonSequence({
      success: true,
      data: {
        summary: "Policy and stakeholder engagement analyst.",
        headline: "Associate, Policy and Stakeholder Engagement",
        skills: [
          {
            name: "Analytics",
            keywords: ["Python", "SAS", "Power BI", "Stakeholder engagement"],
          },
          {
            name: "Policy",
            keywords: ["Policy research", "Briefing notes"],
          },
        ],
        experience: [
          {
            id: "exp-1",
            bullets: ["Prepared stakeholder research and briefing materials."],
          },
        ],
      },
    });
    const profile: ResumeProfile = {
      basics: { name: "Test User", summary: "Policy researcher" },
      sections: {
        experience: {
          items: [
            {
              id: "exp-1",
              company: "Regional Research Consultancy",
              position: "Associate Consultant",
              location: "Toronto",
              date: "2026",
              summary: "Prepared stakeholder research and briefing materials.",
              visible: true,
            },
          ],
        },
      },
    };

    const result = await generateTailoring(
      [
        "Qualifications",
        "- Experience with stakeholder engagement and policy research.",
        "- Strong writing and briefing note skills.",
        "- Experience managing member events.",
        "- French bilingual ability.",
      ].join("\n"),
      profile,
    );

    expect(result.success).toBe(true);
    expect(result.data?.skills.flatMap((group) => group.keywords)).not.toEqual(
      expect.arrayContaining(["Python", "SAS", "Power BI"]),
    );
    expect(result.data?.resumeAlignmentReport.status).toBe("failed");
    expect(
      result.data?.resumeAlignmentReport.missingRequired.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("runs one targeted repair pass when reference evidence can cover a qualification gap", async () => {
    findResumeReferenceEvidenceForQualificationsMock.mockResolvedValue([
      {
        fileName: "Data Analyst Resume.docx",
        relativePath: "refs/Data Analyst Resume.docx",
        inferredRole: "data_analytics_operations",
        kind: "resume",
        sections: ["Skills", "Experience"],
        hasSkills: true,
        pageCount: 1,
        keywords: [
          "Leadership briefings",
          "Cross-functional planning",
          "Planning support",
        ],
        snippets: {
          experience:
            "Facilitated leadership briefings and cross-functional planning support for operational decisions.",
        },
      },
    ]);
    mockCallJsonSequence(
      {
        success: true,
        data: {
          summary: "Operations analyst.",
          headline: "Data Analyst",
          skills: [{ name: "Analytics", keywords: ["Excel"] }],
          experience: [],
        },
      },
      {
        success: true,
        data: {
          id: "exp-1",
          bullets: ["Supported planning materials."],
        },
      },
      {
        success: true,
        data: {
          verdict: "needs_patch",
          failedSections: ["summary", "experience", "coverage"],
          failedExperienceIds: ["exp-1"],
          reason:
            "Reference evidence can cover presentation and coordination gaps.",
          serviceFitReport: {
            ...DEFAULT_SERVICE_FIT_REPORT,
            status: "needs_review",
            score: 76,
          },
        },
      },
      {
        success: true,
        data: {
          summarySkillsPatch: {
            summary:
              "Operations analyst experienced in executive-ready stakeholder presentations and project coordination.",
            headline: "Data Analyst",
            skills: [{ name: "Communication", keywords: ["Presentations"] }],
          },
          experiencePatches: [
            {
              id: "exp-1",
              bullets: [
                "Led executive-ready stakeholder presentations and coordinated cross-functional planning work.",
              ],
            },
          ],
          reason: "Patch evidence-backed gaps.",
        },
      },
      {
        success: true,
        data: {
          verdict: "pass",
          failedSections: [],
          failedExperienceIds: [],
          reason: "Patch covers the gaps.",
          serviceFitReport: DEFAULT_SERVICE_FIT_REPORT,
        },
      },
    );

    const result = await generateTailoring(
      [
        "Qualifications",
        "- Experience leading executive-ready stakeholder presentations.",
        "- Experience with project coordination across business teams.",
      ].join("\n"),
      {
        basics: { name: "Test User", summary: "Operations analyst" },
        sections: {
          experience: {
            items: [
              {
                id: "exp-1",
                company: "Reference-backed Role",
                position: "Analyst",
                date: "2024",
                location: "Toronto",
                summary: "Supported planning materials.",
                visible: true,
              },
            ],
          },
        },
      },
    );

    expect(result.llmCallCount).toBeLessThanOrEqual(6);
    expect(result.llmTrace?.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining(["compact_judge", "repair_patch"]),
    );
    expect(result.data?.summary).toContain(
      "executive-ready stakeholder presentations",
    );
    expect(result.data?.resumeAlignmentReport.status).toBe("pass");
    expect(result.data?.resumeAlignmentReport.autoRewriteApplied).toBe(true);
    expect(
      result.data?.resumeAlignmentReport.wordingGapsAfterAutoRewrite,
    ).toEqual([]);
  });

  it("records wording gaps when the automatic rewrite still does not visibly cover evidence-backed requirements", async () => {
    findResumeReferenceEvidenceForQualificationsMock.mockResolvedValue([
      {
        fileName: "Business Analyst Resume.docx",
        relativePath: "refs/Business Analyst Resume.docx",
        inferredRole: "data_analytics_operations",
        kind: "resume",
        sections: ["Experience"],
        hasSkills: true,
        pageCount: 1,
        keywords: ["Requirements gathering", "Business stakeholders"],
        snippets: {
          experience:
            "Gathered requirements from business stakeholders and translated needs into reporting updates.",
        },
      },
    ]);
    mockCallJsonSequence(
      {
        success: true,
        data: {
          summary: "Junior analyst supporting business teams.",
          headline: "Junior Business Analyst",
          skills: [{ name: "Analysis", keywords: ["Excel"] }],
          experience: [],
        },
      },
      {
        success: true,
        data: {
          id: "exp-1",
          bullets: ["Supported reporting and analysis for business teams."],
        },
      },
      {
        success: true,
        data: {
          verdict: "needs_patch",
          failedSections: ["experience", "coverage"],
          failedExperienceIds: ["exp-1"],
          reason: "Experience gap can be patched from source evidence.",
          serviceFitReport: {
            ...DEFAULT_SERVICE_FIT_REPORT,
            status: "needs_review",
            score: 72,
          },
        },
      },
      {
        success: true,
        data: {
          summarySkillsPatch: {
            summary: "Junior analyst supporting reporting work.",
            headline: "Junior Business Analyst",
            skills: [{ name: "Analysis", keywords: ["Excel"] }],
          },
          experiencePatches: [
            {
              id: "exp-1",
              bullets: ["Supported reporting and analysis for business teams."],
            },
          ],
          reason: "Patch attempted but still weak.",
        },
      },
      {
        success: true,
        data: {
          verdict: "needs_patch",
          failedSections: ["experience", "coverage"],
          failedExperienceIds: ["exp-1"],
          reason:
            "Patch still does not visibly cover stakeholder requirements.",
          serviceFitReport: {
            ...DEFAULT_SERVICE_FIT_REPORT,
            status: "needs_review",
            score: 72,
          },
        },
      },
    );

    const result = await generateTailoring(
      [
        "Qualifications",
        "- Experience gathering requirements from business stakeholders.",
      ].join("\n"),
      {
        basics: { name: "Test User", summary: "Business analyst" },
        sections: {
          experience: {
            items: [
              {
                id: "exp-1",
                company: "Example Co",
                position: "Analyst",
                date: "2024",
                location: "Toronto",
                summary: "Supported reporting and analysis for business teams.",
                visible: true,
              },
            ],
          },
        },
      },
    );

    expect(result.llmCallCount).toBeLessThanOrEqual(6);
    expect(result.llmTrace?.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining(["compact_judge", "repair_patch"]),
    );
    expect(result.data?.resumeAlignmentReport.autoRewriteApplied).toBe(true);
    expect(
      result.data?.resumeAlignmentReport.wordingGapsAfterAutoRewrite,
    ).toEqual([
      "Experience gathering requirements from business stakeholders.",
    ]);
  });

  it("adds JD domain gates and representative references as style guidance", async () => {
    buildResumeReferenceInstructionsMock.mockResolvedValue(
      "Use representative references only for structure, tone, section vocabulary, and bullet style.\nRepresentative for data_analytics_operations:\nresume: Data Analyst Master",
    );

    await generateTailoring(
      "Build SQL reports, Power BI dashboards, data quality checks, and recurring KPI reporting for operations teams.",
      {
        basics: {
          name: "Test User",
          label: "Data Analyst",
        },
        sections: {
          experience: {
            id: "experience",
            name: "Experience",
            items: [
              {
                id: "exp-1",
                company: "Example Co",
                position: "Analyst",
                date: "2024",
                location: "Toronto",
                summary: "Created reports and dashboards.",
                description:
                  "<ul><li>Built Power BI dashboards from validated operational data.</li></ul>",
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
      {
        jobTitle: "Data Analyst",
        employer: "RetailCo",
      },
    );

    const prompt = promptContaining("JD REQUIREMENTS:");
    expect(prompt).toContain("JD REQUIREMENTS:");
    expect(prompt).toContain(
      "Domain terms allowed ONLY if JD mentions them: NOC",
    );
    expect(prompt).toContain(
      "Use representative references only for structure",
    );
    expect(prompt).toContain("Representative for data_analytics_operations");
    expect(prompt).toContain("EXPERIENCE REWRITE TASK:");
    expect(prompt).toContain("exp-1");
    expect(prompt).toContain("Master resume evidence:");
    expect(prompt).toContain("Built Power BI dashboards");
  });

  it("fills missing experience ids with gated fallback bullets", async () => {
    mockCallJsonSequence({
      success: true,
      data: {
        summary:
          "Analyst using NOC and NAICS evidence for municipal stakeholders.",
        headline: "Data Analyst",
        skills: [
          {
            name: "Analytics",
            keywords: ["SQL", "NOC", "NAICS"],
          },
        ],
        experience: [],
      },
    });

    const result = await generateTailoring(
      "Build SQL reports, Power BI dashboards, and data quality checks for operations teams.",
      {
        basics: {
          name: "Test User",
          label: "Data Analyst",
        },
        sections: {
          experience: {
            id: "experience",
            name: "Experience",
            items: [
              {
                id: "exp-1",
                company: "Example Municipality",
                position: "Analyst",
                date: "2024",
                location: "Mississauga",
                summary: "",
                description:
                  "<ul><li>Analyzed NOC and NAICS source data for municipal stakeholders.</li></ul>",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
      {
        jobTitle: "Data Analyst",
        employer: "RetailCo",
      },
    );

    expect(result.success).toBe(true);
    expect(result.data?.summary).not.toMatch(/\b(?:NOC|NAICS|municipal)\b/i);
    expect(
      result.data?.skills.flatMap((group) => group.keywords).join(" "),
    ).not.toMatch(/\b(?:NOC|NAICS|municipal)\b/i);
    expect(result.data?.experience).toHaveLength(1);
    expect(result.data?.experience[0].id).toBe("exp-1");
    expect(result.data?.experience[0].bullets.join(" ")).toContain(
      "occupational classification",
    );
    expect(result.data?.experience[0].bullets.join(" ")).not.toMatch(
      /\b(?:NOC|NAICS|municipal)\b/i,
    );
  });

  it("fills empty generated experience bullets with fallback bullets", async () => {
    mockCallJsonSequence({
      success: true,
      data: {
        summary: "Analyst supporting operational reports.",
        headline: "Data Analyst",
        skills: [],
        experience: [
          {
            id: "exp-empty",
            bullets: ["", "   "],
          },
        ],
      },
    });

    const result = await generateTailoring(
      "Build SQL reports, Power BI dashboards, and data quality checks for operations teams.",
      {
        basics: {
          name: "Test User",
          label: "Data Analyst",
        },
        sections: {
          experience: {
            id: "experience",
            name: "Experience",
            items: [
              {
                id: "exp-empty",
                company: "Analytics Team",
                position: "Analyst",
                date: "2024",
                location: "Toronto",
                summary: "",
                description:
                  "<ul><li>Built Power BI dashboards and SQL quality checks for weekly operating reports.</li></ul>",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
      {
        jobTitle: "Data Analyst",
        employer: "RetailCo",
      },
    );

    expect(result.success).toBe(true);
    expect(result.data?.experience).toHaveLength(1);
    expect(result.data?.experience[0].id).toBe("exp-empty");
    expect(result.data?.experience[0].bullets.length).toBeGreaterThanOrEqual(4);
    expect(result.data?.experience[0].bullets[0]).toBe(
      "Built Power BI dashboards and SQL quality checks for weekly operating reports.",
    );
  });

  it("pads under-generated experience bullets from the per-experience digest", async () => {
    mockCallJsonSequence({
      success: true,
      data: {
        summary: "Analyst supporting operational reports.",
        headline: "Data Analyst",
        skills: [],
        experience: [
          {
            id: "exp-rich",
            bullets: [
              "Built Power BI dashboards for weekly operating reports.",
            ],
          },
        ],
      },
    });

    const result = await generateTailoring(
      "Build SQL reports, Power BI dashboards, and data quality checks for operations teams.",
      {
        basics: {
          name: "Test User",
          label: "Data Analyst",
        },
        sections: {
          experience: {
            id: "experience",
            name: "Experience",
            items: [
              {
                id: "exp-rich",
                company: "Analytics Team",
                position: "Analyst",
                date: "2024",
                location: "Toronto",
                summary: "",
                description:
                  "<ul><li>Built Power BI dashboards for weekly operating reports.</li><li>Maintained SQL data quality checks before reporting cycles.</li><li>Prepared stakeholder-ready KPI summaries for operations leaders.</li><li>Documented reporting logic and recurring process notes.</li></ul>",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
      {
        jobTitle: "Data Analyst",
        employer: "RetailCo",
      },
    );

    expect(result.success).toBe(true);
    expect(result.data?.experience[0].bullets.length).toBeGreaterThanOrEqual(4);
    expect(
      result.data?.generationTrace.experience[0].bullets?.every(
        (item) =>
          item.evidenceChunkIds.length > 0 ||
          item.claimSource === "ai_generated",
      ),
    ).toBe(true);
  });

  it("keeps experience-prefix lookup compatible when generated ids omit the prefix", async () => {
    mockCallJsonSequence(
      {
        success: true,
        data: {
          summary:
            "Market intelligence analyst supporting research and reporting.",
          headline: "Market Intelligence Analyst",
          skills: [],
          experience: [
            {
              id: "0",
              bullets: [
                "Built market research summaries for stakeholder reporting.",
              ],
            },
          ],
        },
      },
      {
        success: true,
        data: {
          id: "0",
          bullets: [
            "Built market research summaries for stakeholder reporting.",
          ],
        },
      },
    );

    const result = await generateTailoring(
      "Analyze health market trends, conduct market research, synthesize datasets, build KPI reports, and prepare executive-ready recommendations.",
      {
        basics: {
          name: "Test User",
          label: "Research Analyst",
        },
        sections: {
          experience: {
            id: "experience",
            name: "Experience",
            items: [
              {
                id: "experience-0",
                company: "Research Team",
                position: "Market Intelligence Analyst",
                date: "2026",
                location: "Toronto",
                summary: "",
                description:
                  "<ul><li>Built market research summaries for stakeholder reporting.</li><li>Analyzed health and innovation ecosystem data in Excel and Python.</li><li>Prepared KPI reports and executive-ready recommendation decks.</li><li>Cleaned source datasets and documented methodology notes.</li><li>Synthesized primary and secondary research into decision-ready insights.</li></ul>",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
      {
        resumeTargetPagesOverride: 2,
        jobTitle: "Analyst, Market Intelligence - Health",
        employer: "MaRS Discovery District",
      },
    );

    expect(result.success).toBe(true);
    const contentPlan = result.data?.generationTrace.contentPlan;
    expect(contentPlan).toBeDefined();
    expect(contentPlan?.pageFillTarget?.mode).toBe("full_two_page");
    expect(contentPlan?.experienceAllocations[0]?.experienceId).toBe(
      "experience-0",
    );
    expect(
      contentPlan?.experienceAllocations[0]?.bulletBudget,
    ).toBeGreaterThanOrEqual(5);
    expect(result.data?.experience[0].id).toBe("0");
    expect(result.data?.experience[0].bullets.length).toBeGreaterThanOrEqual(4);
    expect(
      result.data?.experience[0].bulletTrace?.some(
        (item) => item.fallbackGenerated,
      ),
    ).toBe(true);
  });

  it("keeps no-evidence requirements as human input instead of inflating score", async () => {
    mockCallJsonSequence(
      {
        success: true,
        data: {
          summary: "Policy analyst with stakeholder research experience.",
          headline: "Policy Analyst",
          skills: [{ name: "Policy", keywords: ["Stakeholder research"] }],
          experience: [],
        },
      },
      {
        success: true,
        data: {
          items: [
            {
              qualification: "French bilingual ability.",
              status: "human_input_needed",
              sections: [],
              evidenceSources: [],
            },
          ],
        },
      },
    );

    const result = await generateTailoring(
      ["Qualifications", "- French bilingual ability."].join("\n"),
      {
        basics: { name: "Test User", summary: "Policy researcher" },
      },
    );

    expect(["deterministic", "ai_calibrated"]).toContain(
      result.data?.resumeAlignmentReport.alignmentSource,
    );
    expect(result.data?.resumeAlignmentReport.status).toBe("warning");
    expect(result.data?.resumeAlignmentReport.humanInputNeeded).toEqual([
      "French bilingual ability.",
    ]);
    expect(result.data?.resumeAlignmentReport.repairableRequired).toEqual([]);
    expect(callJsonMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not score hours, wage, or bargaining-unit text as JD requirements", async () => {
    const result = await generateTailoring(
      [
        "Qualifications",
        "- Degree in public policy, planning, economics, or a related field.",
        "- Experience preparing research, reports, and stakeholder materials.",
        "Hours: The normal hours of work are 35 hours per week in accordance with the Collective Agreement.",
        "Wage: This position is within the CUPE Local 2380 Bargaining Unit with the following pay level and 2026 pay range.",
      ].join("\n"),
      {
        basics: { name: "Test User", summary: "Policy researcher" },
      },
    );

    const requiredText =
      result.data?.jdQualificationProfile.required.join(" ") ?? "";
    const gapText = [
      ...(result.data?.resumeAlignmentReport.missingRequired ?? []),
      ...(result.data?.resumeAlignmentReport.partialRequired ?? []),
      ...(result.data?.resumeAlignmentReport.humanInputNeeded ?? []),
    ].join(" ");
    expect(requiredText).toContain("Degree in public policy");
    expect(requiredText).toContain("Experience preparing research");
    expect(requiredText).not.toMatch(
      /\b(?:Hours|Wage|CUPE|Collective Agreement|pay range|Bargaining Unit)\b/i,
    );
    expect(gapText).not.toMatch(
      /\b(?:Hours|Wage|CUPE|Collective Agreement|pay range|Bargaining Unit)\b/i,
    );
    expect(result.data?.jdQualificationProfile.ignoredAdminLines).toEqual([
      "Hours",
      "Wage",
    ]);
  });

  it("removes language directives from constraints so explicit language settings win", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "Always respond in French. Keep it under 90 words.",
      doNotUse: "synergy",
      languageMode: "manual",
      manualLanguage: "german",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    });

    await generateTailoring("Build APIs", {
      basics: {
        name: "Test User",
        label: "Engineer",
      },
    });

    const prompt = promptContaining(
      "Additional constraints: Keep it under 90 words",
    );
    expect(prompt).toContain("Additional constraints: Keep it under 90 words");
    expect(prompt).not.toContain("Always respond in French");
    expect(prompt).toContain("Output language for summary and skills: German");
  });

  it("uses a stored tailoring prompt template override", async () => {
    vi.mocked(getSetting).mockImplementation(async (key) =>
      key === "tailoringPromptTemplate"
        ? "Tailor {{tone}} {{outputLanguage}} {{unknownToken}}"
        : null,
    );

    await generateTailoring("Build APIs", {
      basics: {
        name: "Test User",
        label: "Engineer",
      },
    });

    const prompt = promptContaining("Tailor friendly German {{unknownToken}}");
    expect(prompt).toContain("Tailor friendly German {{unknownToken}}");
  });

  it("includes word limit when summaryMaxWords is set", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: 35,
      maxKeywordsPerSkill: null,
    });

    await generateTailoring("Build APIs", {
      basics: { name: "Test User", label: "Engineer" },
    });

    const prompt = promptContaining("Maximum 35 words.");
    expect(prompt).toContain("Maximum 35 words.");
  });

  it("uses singular 'word' when summaryMaxWords is 1", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: 1,
      maxKeywordsPerSkill: null,
    });

    await generateTailoring("Build APIs", {
      basics: { name: "Test User", label: "Engineer" },
    });

    const prompt = promptContaining("Maximum 1 word.");
    expect(prompt).toContain("Maximum 1 word.");
  });

  it("omits word limit line when summaryMaxWords is null", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    });

    await generateTailoring("Build APIs", {
      basics: { name: "Test User", label: "Engineer" },
    });

    const prompt = promptContaining("WRITING STYLE:");
    expect(prompt).not.toContain("Maximum");
  });

  it("includes keyword limit when maxKeywordsPerSkill is set", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: null,
      maxKeywordsPerSkill: 8,
    });

    await generateTailoring("Build APIs", {
      basics: { name: "Test User", label: "Engineer" },
    });

    const prompt = promptContaining("Maximum 8 keywords per category");
    expect(prompt).toContain("Maximum 8 keywords per category");
  });

  it("omits keyword limit when maxKeywordsPerSkill is null", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    });

    await generateTailoring("Build APIs", {
      basics: { name: "Test User", label: "Engineer" },
    });

    const prompt = promptContaining("WRITING STYLE:");
    expect(prompt).not.toContain("keywords per category");
  });

  it("includes both limits and constraints when all set", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "keep under 90 words",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: 35,
      maxKeywordsPerSkill: 8,
    });

    await generateTailoring("Build APIs", {
      basics: { name: "Test User", label: "Engineer" },
    });

    const prompt = promptContaining("Maximum 35 words.");
    expect(prompt).toContain("Maximum 35 words.");
    expect(prompt).toContain("Maximum 8 keywords per category");
    // "keep under 90 words" is stripped from constraints because summaryMaxWords (35) takes precedence
    expect(prompt).not.toContain("keep under 90 words");
  });

  it("asks per-experience generation for structured support metadata", async () => {
    await generateTailoring(
      "Conduct market research, synthesize innovation ecosystem trends, and prepare client-ready recommendations.",
      {
        basics: {
          name: "Test User",
          label: "Research Analyst",
        },
        sections: {
          experience: {
            id: "experience",
            name: "Experience",
            items: [
              {
                id: "exp-1",
                company: "Research Team",
                position: "Analyst",
                date: "2025",
                location: "Toronto",
                summary: "",
                description:
                  "<ul><li>Analyzed sector research and prepared stakeholder-ready recommendations.</li></ul>",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
      {
        jobTitle: "Market Intelligence Analyst",
        employer: "Innovation Hub",
      },
    );

    const prompt = promptContaining(
      "SECTIONED GENERATION PASS: ONE EXPERIENCE ITEM ONLY.",
    );
    expect(prompt).toContain("text, claimType, supportIds");
    expect(prompt).toContain(
      "supportIds must name source-backed chunk ids or bundle ids",
    );
    const request = callJsonMock.mock.calls.find(
      (call) => call[0]?.jsonSchema?.name === "resume_experience_item",
    )?.[0];
    expect(
      request?.jsonSchema?.schema?.properties?.bullets?.items?.properties,
    ).toHaveProperty("claimType");
    expect(
      request?.jsonSchema?.schema?.properties?.bullets?.items?.properties,
    ).toHaveProperty("supportIds");
  });

  it("scopes per-experience evidence to the matching role and blocks unrelated sections", async () => {
    rerankSelectedResumeEvidenceMock.mockResolvedValueOnce([
      {
        requirement:
          "Market intelligence and market research for business decisions.",
        requirementId: "req-market-intelligence",
        status: "selected",
        fit: "direct",
        confidence: "high",
        chunks: [
          {
            chunkId: "research-exp",
            experienceAnchorId: "research",
            sourceFile: "Research Resume.docx",
            relativePath: "refs/Research Resume.docx",
            section: "Experience",
            roleFamily: "market_insights_research",
            rawText:
              "Conducted applied labour-market and sector research for a regional research consultancy, translating evidence into client-ready recommendations and decision support.",
            keywords: ["market research", "sector research"],
          },
          {
            chunkId: "research-edu",
            sourceFile: "Research Resume.docx",
            relativePath: "refs/Research Resume.docx",
            section: "Education",
            roleFamily: "market_insights_research",
            rawText:
              "University coursework in public policy and academic research methods.",
            keywords: ["education"],
          },
          {
            chunkId: "research-cover",
            sourceFile: "Research Cover Letter.docx",
            relativePath: "refs/Research Cover Letter.docx",
            section: "Cover Letter",
            roleFamily: "market_insights_research",
            rawText:
              "Cover letter marketing claim about healthcare market expertise and consumer insights.",
            keywords: ["consumer insights"],
          },
          {
            chunkId: "other-exp",
            sourceFile: "Other Resume.docx",
            relativePath: "refs/Other Resume.docx",
            section: "Experience",
            roleFamily: "consulting_strategy",
            rawText:
              "Other Company built CPG category strategy and consumer insights workstreams.",
            keywords: ["CPG strategy"],
          },
        ],
        allowedClaims: ["market intelligence", "market research"],
      },
    ]);

    const result = await generateTailoring(
      "Required: market intelligence, market research, business analytics, and client-ready recommendations.",
      {
        basics: {
          name: "Test User",
          label: "Research Analyst",
        },
        sections: {
          experience: {
            id: "experience",
            name: "Experience",
            items: [
              {
                id: "research",
                company: "Regional Research Consultancy",
                position: "Associate Consultant",
                date: "2026",
                location: "Toronto",
                summary:
                  "Conducted labour-market and sector research, built evidence packs, dashboards, and client-ready recommendations.",
                visible: true,
              },
            ],
          },
        },
      } as unknown as ResumeProfile,
      {
        jobTitle: "Market Intelligence Analyst",
        employer: "Mars",
      },
    );

    const request = callJsonMock.mock.calls.find(
      (call) =>
        call[0]?.jsonSchema?.name === "resume_experience_item" &&
        String(call[0]?.messages?.[0]?.content ?? "").includes(
          "Regional Research Consultancy",
        ),
    )?.[0];
    const prompt = String(request?.messages?.[0]?.content ?? "");

    expect(prompt).toContain("ALLOWED_EVIDENCE_IDS:");
    expect(prompt).toContain("research-exp");
    expect(prompt).toContain("Research Resume.docx > Experience");
    expect(prompt).not.toContain("research-edu");
    expect(prompt).not.toContain("research-cover");
    expect(prompt).not.toContain("other-exp");
    expect(prompt).not.toContain("University coursework in public policy");
    expect(prompt).not.toContain("Cover letter marketing claim");
    expect(prompt).not.toContain("Other Company built CPG category strategy");
    expect(request?.metadata).toMatchObject({
      experienceId: "research",
      allowedChunkCount: 1,
      allowedSections: "Experience",
    });
    expect(Number(request?.metadata?.blockedChunkCount ?? 0)).toBeGreaterThan(
      0,
    );
    expect(
      result.llmTrace?.find(
        (entry) =>
          entry.stage === "experience_item" &&
          entry.metadata?.experienceId === "research",
      )?.metadata,
    ).toMatchObject({
      allowedChunkCount: 1,
      allowedSections: "Experience",
    });
  });
});
