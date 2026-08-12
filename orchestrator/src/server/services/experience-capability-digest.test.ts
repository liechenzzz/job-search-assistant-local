import { describe, expect, it, vi } from "vitest";
import type {
  JdQualificationProfile,
  ResumeProfile,
  SelectedResumeEvidence,
} from "@shared/types";
import { buildExperienceCapabilityDigests } from "./experience-capability-digest";

const qualificationProfile: JdQualificationProfile = {
  required: ["Build Power BI dashboards for operations reporting"],
  preferred: ["Stakeholder-ready analysis"],
  keywords: ["Power BI", "dashboards", "stakeholder"],
  confidence: "high",
  requirements: [
    {
      id: "req-dashboard",
      text: "Build Power BI dashboards for operations reporting",
      category: "responsibility",
      priority: 3,
      targetSections: ["experience"],
      mustHave: true,
      evidenceNeeded: "direct",
    },
    {
      id: "req-stakeholder",
      text: "Stakeholder-ready analysis",
      category: "responsibility",
      priority: 2,
      targetSections: ["experience"],
      mustHave: false,
      evidenceNeeded: "transferable",
    },
  ],
};

const profile: ResumeProfile = {
  basics: { name: "Test User" },
  sections: {
    experience: {
      items: [
        {
          id: "exp-analytics",
          company: "Analytics Team",
          position: "Analyst",
          location: "Toronto",
          date: "2024",
          summary: "Built Power BI dashboards and weekly reporting packs.",
          visible: true,
        },
      ],
    },
  },
};

const selectedEvidence: SelectedResumeEvidence[] = [
  {
    requirement: "Build Power BI dashboards for operations reporting",
    requirementId: "req-dashboard",
    status: "selected",
    fit: "direct",
    confidence: "high",
    chunks: [
      {
        chunkId: "chunk-dashboard",
        sourceFile: "Analytics Resume.docx",
        relativePath: "Analytics Resume.docx",
        section: "experience",
        roleFamily: "data_analytics_operations",
        rawText:
          "Analytics Team Analyst built Power BI dashboards, weekly reporting packs, QA checks, and stakeholder-ready insights.",
        keywords: ["Power BI", "dashboards", "reporting", "stakeholder"],
      },
    ],
    allowedClaims: ["Power BI dashboards", "weekly operations reporting"],
    blockedClaims: [],
  },
];

describe("experience capability digest", () => {
  it("maps selected evidence chunks back to the matching experience", async () => {
    const digests = await buildExperienceCapabilityDigests({
      profile,
      sourceExperiences: [
        {
          id: "exp-analytics",
          sourceText:
            "Built Power BI dashboards. Prepared weekly reporting packs. Ran QA checks. Delivered stakeholder-ready insights.",
        },
      ],
      qualificationProfile,
      selectedEvidence,
    });

    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      experienceId: "exp-analytics",
      fitLevel: "relevant",
    });
    expect(digests[0].matchedRequirementIds).toContain("req-dashboard");
    expect(digests[0].sourceChunkIds).toContain("chunk-dashboard");
    expect(digests[0].recommendedBulletThemes.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back deterministically when the LLM digest call fails", async () => {
    const llm = {
      callJson: vi.fn(async () => ({
        success: false as const,
        error: "model unavailable",
      })),
    };

    const digests = await buildExperienceCapabilityDigests({
      profile,
      sourceExperiences: [
        {
          id: "exp-analytics",
          sourceText:
            "Built Power BI dashboards. Prepared weekly reporting packs. Ran QA checks. Delivered stakeholder-ready insights.",
        },
      ],
      qualificationProfile,
      selectedEvidence,
      llm,
      model: "test-model",
    });

    expect(llm.callJson).toHaveBeenCalledTimes(1);
    expect(digests[0].experienceId).toBe("exp-analytics");
    expect(digests[0].sourceChunkIds).toContain("chunk-dashboard");
    expect(digests[0].coreClaims.length).toBeGreaterThan(0);
  });

  it("derives digests from persisted experience anchors without calling the LLM", async () => {
    const llm = {
      callJson: vi.fn(async () => ({
        success: false as const,
        error: "should not be called",
      })),
    };

    const digests = await buildExperienceCapabilityDigests({
      profile,
      sourceExperiences: [
        {
          id: "exp-analytics",
          sourceText:
            "Built Power BI dashboards. Prepared weekly reporting packs. Ran QA checks.",
        },
      ],
      qualificationProfile,
      selectedEvidence: [
        {
          ...selectedEvidence[0],
          chunks: [
            {
              ...selectedEvidence[0].chunks[0],
              experienceAnchorId: "anchor:analytics",
            },
          ],
        },
      ],
      experienceAnchors: [
        {
          experienceAnchorId: "anchor:analytics",
          identity: {
            company: "Analytics Team",
            title: "Analyst",
            roleAliases: ["Data Analytics Operations"],
          },
          roleOverview: {
            text: "Built Power BI dashboards and reporting packs for operations.",
            sourceChunkIds: ["chunk-dashboard"],
          },
          responsibilityAreas: [
            {
              text: "Prepared weekly reporting packs and QA checks.",
              sourceChunkIds: ["chunk-dashboard"],
            },
          ],
          majorProjects: [],
          toolsAndMethods: [
            {
              text: "Used Power BI for dashboard reporting.",
              sourceChunkIds: ["chunk-dashboard"],
            },
          ],
          domains: [],
          stakeholders: [],
          measurableOutcomes: [],
          transferableStrengths: [],
          limitationsOrUnverifiedClaims: [],
          sourceChunkIds: ["chunk-dashboard"],
          sourceFiles: ["Analytics Resume.docx"],
          sourceDigestHash: "hash",
          confidence: "high",
          diagnostics: {
            buildMethod: "deterministic",
            sourceChunkCount: 1,
            lowQualitySourceChunkIds: [],
            orphanChunkIds: [],
            warnings: [],
          },
          lastBuiltAt: "2026-06-07T00:00:00.000Z",
          version: 1,
        },
      ],
      llm,
      model: "test-model",
    });

    expect(llm.callJson).not.toHaveBeenCalled();
    expect(digests[0].capabilitySummary).toContain("Power BI dashboards");
    expect(digests[0].sourceChunkIds).toContain("chunk-dashboard");
    expect(digests[0].confidence).toBe("high");
  });
});
