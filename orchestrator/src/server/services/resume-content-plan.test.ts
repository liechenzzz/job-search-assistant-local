import type { ResumeGenerationDecision } from "@shared/resume-generation-decision.js";
import type {
  ExperienceCapabilityDigest,
  JdKeywordProfile,
  JdQualificationProfile,
  ResumeProfile,
  SelectedResumeEvidence,
} from "@shared/types";
import { describe, expect, it } from "vitest";
import { buildResumeContentPlan } from "./resume-content-plan";

const keywordProfile: JdKeywordProfile = {
  roleFamily: "data_analytics_operations",
  requiredKeywords: ["dashboard", "stakeholder", "program evaluation"],
  domainKeywordsPresent: ["public policy"],
  blockedUnlessPresent: [],
  experienceFocus: ["dashboard", "analysis", "stakeholder"],
};

function decision(targetPages: 1 | 2): ResumeGenerationDecision {
  return {
    roleFamily: "data_analytics_operations",
    documentPolicyReason: "manual",
    targetPages,
    masterVariant: targetPages === 1 ? "one_page" : "two_page",
    layoutMode: targetPages === 1 ? "reference_1_page" : "reference_2_page",
    referenceRoleFamilies: ["data_analytics_operations"],
    blockedDomainTerms: [],
    policyLabel: "Manual",
    policyReason: "Manual test policy",
    allowsManualResumeTargetPages: true,
    formatReferences: [],
    evidenceReferences: [],
  };
}

const qualificationProfile: JdQualificationProfile = {
  required: ["Build dashboard reporting for program evaluation"],
  preferred: ["Public policy research"],
  keywords: ["dashboard", "dashboard", "stakeholder", "program evaluation"],
  confidence: "high",
  requirements: [
    {
      id: "req-dashboard",
      text: "Build dashboard reporting for program evaluation",
      category: "responsibility",
      priority: 3,
      targetSections: ["summary", "experience", "skills"],
      mustHave: true,
      evidenceNeeded: "direct",
    },
    {
      id: "req-policy",
      text: "Public policy research",
      category: "domain",
      priority: 2,
      targetSections: ["experience", "skills"],
      mustHave: false,
      evidenceNeeded: "transferable",
    },
    {
      id: "req-salesforce",
      text: "Salesforce administration",
      category: "tool",
      priority: 2,
      targetSections: ["skills"],
      mustHave: true,
      evidenceNeeded: "direct",
    },
  ],
};

const profile: ResumeProfile = {
  basics: { name: "Jane Candidate" },
  sections: {
    experience: {
      items: [
        {
          id: "exp-city",
          company: "Example Municipality",
          position: "Graduate Consultant",
          location: "Mississauga",
          date: "2024",
          summary:
            "Built dashboard reporting and stakeholder-ready program evaluation analysis for public-sector teams.",
          visible: true,
        },
        {
          id: "exp-content",
          company: "Design Studio",
          position: "Content Research Intern",
          location: "Chengdu",
          date: "2021",
          summary: "Prepared content research and market scan notes.",
          visible: true,
        },
      ],
    },
  },
};

const selectedEvidence: SelectedResumeEvidence[] = [
  {
    requirement: "Build dashboard reporting for program evaluation",
    requirementId: "req-dashboard",
    category: "responsibility",
    priority: 3,
    status: "selected",
    fit: "direct",
    confidence: "high",
    allowedClaims: ["dashboard reporting", "program evaluation analysis"],
    blockedClaims: [],
    chunks: [
      {
        chunkId: "chunk-dashboard",
        sourceFile: "Data Resume.docx",
        relativePath: "Data Resume.docx",
        section: "experience",
        roleFamily: "data_analytics_operations",
        rawText:
          "Example Municipality: Built dashboard reporting and program evaluation analysis.",
        keywords: ["dashboard", "program evaluation"],
      },
    ],
  },
  {
    requirement: "Public policy research",
    requirementId: "req-policy",
    category: "domain",
    priority: 2,
    status: "transferable_only",
    fit: "transferable",
    confidence: "medium",
    allowedClaims: ["policy-adjacent research"],
    blockedClaims: ["owned public policy design"],
    chunks: [
      {
        chunkId: "chunk-policy",
        sourceFile: "Policy Resume.docx",
        relativePath: "Policy Resume.docx",
        section: "experience",
        roleFamily: "market_insights_research",
        rawText: "Prepared policy-adjacent research scans for municipal teams.",
        keywords: ["policy", "research"],
      },
    ],
  },
  {
    requirement: "Salesforce administration",
    requirementId: "req-salesforce",
    category: "tool",
    priority: 2,
    status: "no_evidence",
    fit: "unsupported",
    confidence: "low",
    allowedClaims: [],
    blockedClaims: ["Salesforce administration"],
    chunks: [],
  },
];

const cityDigest: ExperienceCapabilityDigest = {
  experienceId: "exp-city",
  label: "Graduate Consultant at Example Municipality",
  fitLevel: "primary",
  capabilitySummary:
    "Built dashboard reporting, program evaluation analysis, and stakeholder-ready public-sector deliverables.",
  coreClaims: [
    "Built dashboard reporting",
    "Prepared program evaluation analysis",
    "Delivered stakeholder-ready public-sector analysis",
    "Synthesized findings for team decisions",
  ],
  transferableClaims: ["policy-adjacent research"],
  matchedRequirementIds: ["req-dashboard", "req-policy"],
  recommendedBulletThemes: [
    "dashboard reporting",
    "program evaluation analysis",
    "stakeholder-ready analysis",
    "public-sector research",
    "quality checks",
    "decision support",
  ],
  sourceChunkIds: ["chunk-dashboard", "chunk-policy"],
  blockedClaims: [],
  confidence: "high",
};

describe("resume content plan", () => {
  it("gives emphasized direct evidence a core tier and primary experience budget", () => {
    const plan = buildResumeContentPlan({
      profile,
      qualificationProfile,
      keywordProfile,
      selectedEvidence,
      experienceDigests: [cityDigest],
      sourceExperiences: [
        {
          id: "exp-city",
          sourceText:
            "Built dashboard reporting and stakeholder-ready program evaluation analysis.",
        },
      ],
      generationDecision: decision(1),
    });

    expect(
      plan.requirementTiers.find(
        (item) => item.requirementId === "req-dashboard",
      )?.tier,
    ).toBe("core");
    expect(
      plan.experienceAllocations.find(
        (item) => item.experienceId === "exp-city",
      )?.kind,
    ).toBe("primary");
    expect(plan.bulletBudgets["exp-city"]).toBeGreaterThanOrEqual(6);
    expect(
      plan.experienceAllocations[0].requiredBulletThemes?.length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("limits transferable evidence and blocks unsupported claims", () => {
    const plan = buildResumeContentPlan({
      profile,
      qualificationProfile,
      keywordProfile,
      selectedEvidence,
      experienceDigests: [cityDigest],
      sourceExperiences: [],
      generationDecision: decision(1),
    });

    expect(plan.softenedRequirements).toContain("Public policy research");
    expect(
      plan.requirementTiers.find((item) => item.requirementId === "req-policy")
        ?.bulletBudget,
    ).toBe(1);
    expect(
      plan.requirementTiers.find(
        (item) => item.requirementId === "req-salesforce",
      )?.tier,
    ).toBe("blocked");
    expect(plan.blockedClaims).toContain("Salesforce administration");
  });

  it("uses larger section budgets for two-page resumes", () => {
    const onePage = buildResumeContentPlan({
      profile,
      qualificationProfile,
      keywordProfile,
      selectedEvidence,
      experienceDigests: [cityDigest],
      sourceExperiences: [],
      generationDecision: decision(1),
    });
    const twoPage = buildResumeContentPlan({
      profile,
      qualificationProfile,
      keywordProfile,
      selectedEvidence,
      experienceDigests: [cityDigest],
      sourceExperiences: [],
      generationDecision: decision(2),
    });

    expect(twoPage.sectionBudgets.experienceBullets.max).toBe(
      twoPage.experienceAllocations.reduce(
        (sum, item) => sum + item.bulletBudget,
        0,
      ),
    );
    expect(onePage.sectionBudgets.experienceBullets.max).toBe(
      onePage.experienceAllocations.reduce(
        (sum, item) => sum + item.bulletBudget,
        0,
      ),
    );
    expect(twoPage.sectionBudgets.skillGroups.max).toBeGreaterThan(0);
    expect(twoPage.sectionBudgets.skillGroups.max).toBe(3);
    expect(twoPage.pageFillTarget?.mode).toBe("full_two_page");
    expect(twoPage.densityTargets?.minRelevantBundleCandidates).toBe(15);
    expect(twoPage.pageFillTarget?.bulletWordTarget.min).toBeGreaterThan(
      onePage.pageFillTarget?.bulletWordTarget.min ?? 0,
    );
  });

  it("does not collapse recent experiences to one bullet when exact JD matching is uncertain", () => {
    const multiExperienceProfile: ResumeProfile = {
      basics: { name: "Jane Candidate" },
      sections: {
        experience: {
          items: [
            {
              id: "exp-1",
              company: "Recent Organization",
              position: "Strategy Analyst",
              location: "Toronto",
              date: "2025",
              summary:
                "Owned mixed research, reporting, and stakeholder deliverables.",
              visible: true,
            },
            {
              id: "exp-2",
              company: "Prior Organization",
              position: "Operations Analyst",
              location: "Toronto",
              date: "2024",
              summary:
                "Managed operational analysis and internal process documentation.",
              visible: true,
            },
            {
              id: "exp-3",
              company: "Earlier Organization",
              position: "Research Assistant",
              location: "Toronto",
              date: "2023",
              summary: "Prepared research notes and analytical briefs.",
              visible: true,
            },
            {
              id: "exp-4",
              company: "Background Organization",
              position: "Coordinator",
              location: "Toronto",
              date: "2022",
              summary: "Coordinated administrative workflows.",
              visible: true,
            },
            {
              id: "exp-5",
              company: "Older Organization",
              position: "Assistant",
              location: "Toronto",
              date: "2021",
              summary: "Supported general office tasks.",
              visible: true,
            },
          ],
        },
      },
    };

    const plan = buildResumeContentPlan({
      profile: multiExperienceProfile,
      qualificationProfile,
      keywordProfile,
      selectedEvidence: [],
      experienceDigests: [],
      sourceExperiences: [],
      generationDecision: decision(2),
    });

    const firstThree = plan.experienceAllocations.slice(0, 3);
    expect(firstThree.map((item) => item.kind)).toEqual([
      "supporting",
      "supporting",
      "supporting",
    ]);
    for (const allocation of firstThree) {
      expect(allocation.bulletBudget).toBeGreaterThanOrEqual(4);
    }
    expect(plan.experienceAllocations[3]?.kind).toBe("background");
    expect(plan.experienceAllocations[3]?.bulletBudget).toBeGreaterThanOrEqual(
      5,
    );
    expect(plan.pageFillTarget?.mode).toBe("full_two_page");
    expect(plan.densityTargets?.minRelevantBundleCandidates).toBe(15);
  });

  it("uses digest fit level to allocate five or more bullets to relevant experiences", () => {
    const plan = buildResumeContentPlan({
      profile,
      qualificationProfile,
      keywordProfile,
      selectedEvidence,
      sourceExperiences: [],
      experienceDigests: [
        {
          ...cityDigest,
          fitLevel: "relevant",
          matchedRequirementIds: ["req-dashboard"],
          sourceChunkIds: ["chunk-dashboard"],
        },
      ],
      generationDecision: decision(1),
    });

    const allocation = plan.experienceAllocations.find(
      (item) => item.experienceId === "exp-city",
    );
    expect(allocation?.kind).toBe("supporting");
    expect(allocation?.fitLevel).toBe("relevant");
    expect(allocation?.bulletBudget).toBe(5);
    expect(plan.sectionBudgets.experienceBullets.min).toBe(
      plan.experienceAllocations.reduce(
        (sum, item) => sum + item.bulletBudget,
        0,
      ),
    );
  });

  it("uses bundle and density diagnostics instead of fixed two-page bullet floors", () => {
    const threeExperienceProfile: ResumeProfile = {
      basics: { name: "Jane Candidate" },
      sections: {
        experience: {
          items: [
            {
              id: "exp-a",
              company: "A",
              position: "Analyst",
              location: "Toronto",
              date: "2026",
              summary: "Research and reporting work.",
              visible: true,
            },
            {
              id: "exp-b",
              company: "B",
              position: "Consultant",
              location: "Toronto",
              date: "2025",
              summary: "Stakeholder analysis and data work.",
              visible: true,
            },
            {
              id: "exp-c",
              company: "C",
              position: "Research Consultant",
              location: "Toronto",
              date: "2024",
              summary: "Market research and briefing work.",
              visible: true,
            },
          ],
        },
      },
    };

    const plan = buildResumeContentPlan({
      profile: threeExperienceProfile,
      qualificationProfile,
      keywordProfile,
      selectedEvidence,
      experienceDigests: [],
      sourceExperiences: [],
      generationDecision: decision(2),
    });

    expect(plan.pageFillTarget?.mode).toBe("full_two_page");
    expect(plan.densityTargets?.minExperienceWords).toBeGreaterThanOrEqual(620);
    expect(plan.densityTargets?.minAverageBulletWords).toBeGreaterThanOrEqual(
      26,
    );
    expect(plan.densityTargets?.minRelevantBundleCandidates).toBe(15);
    expect(plan.bulletBundleCandidates?.length ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("derives 15+ MaRS-like bullet bundle opportunities from rich per-experience evidence", () => {
    const richRequirements: JdQualificationProfile = {
      required: [
        "Conduct market intelligence research",
        "Analyze startup and innovation ecosystem data",
        "Prepare stakeholder-ready reports and presentations",
        "Synthesize industry trends for strategic decisions",
        "Support program evaluation and performance tracking",
        "Use Excel, SQL, and dashboard tools for analysis",
      ],
      preferred: ["Translate research into recommendations"],
      keywords: [
        "market intelligence",
        "ecosystem",
        "reports",
        "trend",
        "dashboard",
      ],
      confidence: "high",
      requirements: [
        "Conduct market intelligence research",
        "Analyze startup and innovation ecosystem data",
        "Prepare stakeholder-ready reports and presentations",
        "Synthesize industry trends for strategic decisions",
        "Support program evaluation and performance tracking",
        "Use Excel, SQL, and dashboard tools for analysis",
      ].map((text, index) => ({
        id: `mars-req-${index + 1}`,
        text,
        category: index === 5 ? "tool" : "responsibility",
        priority: 3,
        targetSections: ["summary", "experience", "skills"],
        mustHave: true,
        evidenceNeeded: "direct",
      })),
    };
    const richProfile: ResumeProfile = {
      basics: { name: "Jane Candidate" },
      sections: {
        experience: {
          items: [
            {
              id: "exp-research",
              company: "Regional Research Consultancy",
              position: "Consultant",
              location: "Toronto",
              date: "2025",
              summary:
                "Market intelligence, stakeholder reporting, trend analysis, and recommendations.",
              visible: true,
            },
            {
              id: "exp-program",
              company: "Municipal Innovation Hub",
              position: "Research Analyst",
              location: "Mississauga",
              date: "2024",
              summary:
                "Startup ecosystem data, program evaluation, dashboards, and stakeholder briefs.",
              visible: true,
            },
            {
              id: "exp-analytics",
              company: "Mobility Analytics Program",
              position: "Data Analyst",
              location: "Toronto",
              date: "2023",
              summary:
                "Excel, SQL, dashboard tools, performance tracking, and decision support.",
              visible: true,
            },
          ],
        },
      },
    };
    const richEvidence: SelectedResumeEvidence[] =
      richRequirements.requirements!.map((requirement, index) => ({
        requirement: requirement.text,
        requirementId: requirement.id,
        category: requirement.category,
        priority: requirement.priority,
        status: "selected",
        fit: "direct",
        confidence: index < 4 ? "high" : "medium",
        allowedClaims: [
          requirement.text,
          `${requirement.text} for stakeholder decisions`,
        ],
        blockedClaims: [],
        chunks: ["exp-research", "exp-program", "exp-analytics"].map(
          (experienceId, chunkIndex) => ({
            chunkId: `${requirement.id}-chunk-${chunkIndex + 1}`,
            sourceFile: "Master Resume.docx",
            relativePath: "Master Resume.docx",
            section: "experience",
            roleFamily: "market_insights_research",
            rawText: `${experienceId} evidence: ${requirement.text} with source-backed methods and outputs.`,
            keywords: requirement.text.toLowerCase().split(/\s+/).slice(0, 5),
          }),
        ),
      }));
    const richDigests: ExperienceCapabilityDigest[] = [
      "exp-research",
      "exp-program",
      "exp-analytics",
    ].map((experienceId, index) => ({
      experienceId,
      label: `${experienceId} role`,
      fitLevel: index === 0 ? "primary" : "relevant",
      capabilitySummary: "Rich market intelligence and analysis experience.",
      coreClaims: richRequirements.requirements!.map(
        (requirement) => `${requirement.text} in ${experienceId}`,
      ),
      transferableClaims: [],
      matchedRequirementIds: richRequirements.requirements!.map(
        (requirement) => requirement.id,
      ),
      recommendedBulletThemes: richRequirements.requirements!.map(
        (requirement) => requirement.text,
      ),
      sourceChunkIds: richRequirements.requirements!.map(
        (requirement) => `${requirement.id}-chunk-${index + 1}`,
      ),
      blockedClaims: [],
      confidence: "high",
    }));

    const plan = buildResumeContentPlan({
      profile: richProfile,
      qualificationProfile: richRequirements,
      keywordProfile: {
        ...keywordProfile,
        roleFamily: "market_insights_research",
        requiredKeywords: ["market intelligence", "ecosystem", "dashboard"],
        experienceFocus: [
          "market intelligence",
          "trend analysis",
          "stakeholder reports",
        ],
      },
      selectedEvidence: richEvidence,
      experienceDigests: richDigests,
      sourceExperiences: [],
      generationDecision: decision(2),
    });

    expect(plan.bulletBundleCandidates?.length ?? 0).toBeGreaterThanOrEqual(15);
    expect(
      plan.bulletBundleCandidates?.every(
        (bundle) => bundle.sourceChunkIds.length > 0,
      ),
    ).toBe(true);
    expect(
      plan.bulletBundleCandidates?.some(
        (bundle) =>
          bundle.fit === "direct" && bundle.recommendedDepth === "deep",
      ),
    ).toBe(true);
  });
});
