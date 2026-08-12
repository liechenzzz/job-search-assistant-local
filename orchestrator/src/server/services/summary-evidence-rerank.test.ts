import type { JdQualificationProfile, ResumeReferenceChunk } from "@shared/types";
import { describe, expect, it, vi } from "vitest";
import { rerankSelectedResumeEvidence } from "./resume-evidence-rerank";

function chunk(overrides: Partial<ResumeReferenceChunk>): ResumeReferenceChunk {
  return {
    id: "chunk-1",
    relativePath: "resume.docx",
    fileName: "resume.docx",
    kind: "resume",
    roleFamily: "data_analytics_operations",
    section: "Experience",
    text: "Built Power BI dashboards and SQL reporting workflows for stakeholder decisions.",
    rawText:
      "Built Power BI dashboards and SQL reporting workflows for stakeholder decisions.",
    normalizedText:
      "built power bi dashboards and sql reporting workflows for stakeholder decisions",
    keywords: ["Power BI", "SQL", "Dashboard"],
    clusterId: "cluster-1",
    qualitySignals: {
      textLength: 80,
      keywordCount: 3,
      hasMetrics: false,
      sectionScore: 8,
      sourceKindScore: 8,
      recencyScore: 5,
      confidence: "high",
    },
    lastModified: 1,
    size: 100,
    ...overrides,
  };
}

function profile(): JdQualificationProfile {
  return {
    required: [
      "Build Power BI dashboards",
      "Grant writing experience",
      "Stakeholder communication",
    ],
    preferred: [],
    keywords: ["Power BI", "stakeholder"],
    confidence: "high",
    requirements: [
      {
        id: "req-1",
        text: "Build Power BI dashboards",
        category: "tool",
        priority: 100,
        targetSections: ["skills", "experience"],
        mustHave: true,
        evidenceNeeded: "direct",
      },
      {
        id: "req-2",
        text: "Grant writing experience",
        category: "experience",
        priority: 99,
        targetSections: ["experience"],
        mustHave: true,
        evidenceNeeded: "direct",
      },
      {
        id: "req-3",
        text: "Stakeholder communication",
        category: "soft_skill",
        priority: 98,
        targetSections: ["summary", "experience"],
        mustHave: true,
        evidenceNeeded: "direct",
      },
    ],
  };
}

describe("rerankSelectedResumeEvidence", () => {
  it("allows direct evidence and blocks weak unsupported claims", async () => {
    const llm = {
      callJson: vi.fn().mockResolvedValue({
        success: true,
        data: {
          items: [
            {
              requirementId: "req-1",
              requirement: "Build Power BI dashboards",
              fit: "direct",
              confidence: "high",
              selectedChunkIds: ["chunk-1"],
              reason: "The chunk explicitly mentions Power BI dashboards.",
              allowedClaims: ["Power BI dashboards", "SQL reporting"],
              blockedClaims: ["Do not claim grant writing."],
            },
            {
              requirementId: "req-2",
              requirement: "Grant writing experience",
              fit: "weak",
              confidence: "low",
              selectedChunkIds: ["chunk-2"],
              reason: "Only generic writing is present.",
              allowedClaims: [],
              blockedClaims: ["Do not claim grant writing."],
            },
          ],
        },
      }),
    };

    const selected = await rerankSelectedResumeEvidence({
      llm: llm as never,
      model: "test-model",
      qualificationProfile: profile(),
      knowledgeHits: [
        {
          qualification: "Build Power BI dashboards",
          requirementId: "req-1",
          chunks: [chunk({ id: "chunk-1" })],
        },
        {
          qualification: "Grant writing experience",
          requirementId: "req-2",
          chunks: [
            chunk({
              id: "chunk-2",
              text: "Prepared research summaries and briefing materials.",
              rawText: "Prepared research summaries and briefing materials.",
              keywords: ["Research"],
              clusterId: "cluster-2",
            }),
          ],
        },
      ],
      fallbackSelectedEvidence: [],
    });

    expect(selected[0]).toMatchObject({
      requirement: "Build Power BI dashboards",
      status: "selected",
      fit: "direct",
      confidence: "high",
      allowedClaims: ["Power BI dashboards", "SQL reporting"],
    });
    expect(selected[0].chunks).toHaveLength(1);
    expect(selected[1]).toMatchObject({
      requirement: "Grant writing experience",
      status: "weak_evidence",
      fit: "weak",
      chunks: [],
      blockedClaims: ["Do not claim grant writing."],
    });
  });

  it("keeps transferable evidence separate from direct evidence", async () => {
    const llm = {
      callJson: vi.fn().mockResolvedValue({
        success: true,
        data: {
          items: [
            {
              requirementId: "req-3",
              requirement: "Stakeholder communication",
              fit: "transferable",
              confidence: "medium",
              selectedChunkIds: ["chunk-3"],
              reason: "The chunk supports adjacent stakeholder reporting.",
              allowedClaims: ["stakeholder reporting"],
              blockedClaims: ["Do not claim formal communications ownership."],
            },
          ],
        },
      }),
    };

    const selected = await rerankSelectedResumeEvidence({
      llm: llm as never,
      model: "test-model",
      qualificationProfile: profile(),
      knowledgeHits: [
        {
          qualification: "Stakeholder communication",
          requirementId: "req-3",
          chunks: [
            chunk({
              id: "chunk-3",
              text: "Built recurring stakeholder reporting packs.",
              rawText: "Built recurring stakeholder reporting packs.",
              keywords: ["stakeholder", "reporting"],
              clusterId: "cluster-3",
              evidenceGroupId: "exp_anchor:anchor-stakeholder",
              evidenceGroupLabel:
                "Stakeholder Resume.docx > data_analytics_operations > Experience",
            }),
          ],
        },
      ],
      fallbackSelectedEvidence: [],
    });

    expect(selected.find((item) => item.requirementId === "req-3")).toMatchObject({
      status: "transferable_only",
      fit: "transferable",
      allowedClaims: ["stakeholder reporting"],
    });
    expect(selected.find((item) => item.requirementId === "req-3")?.chunks[0]).toMatchObject({
      evidenceGroupId: "exp_anchor:anchor-stakeholder",
      evidenceGroupLabel:
        "Stakeholder Resume.docx > data_analytics_operations > Experience",
    });
  });

  it("falls back with low confidence when LLM rerank fails", async () => {
    const llm = {
      callJson: vi.fn().mockResolvedValue({
        success: false,
        error: "model unavailable",
      }),
    };
    const fallback = [
      {
        requirement: "Build Power BI dashboards",
        requirementId: "req-1",
        status: "transferable_only" as const,
        fit: "transferable" as const,
        confidence: "low" as const,
        chunks: [],
        reason: "fallback",
      },
    ];

    const selected = await rerankSelectedResumeEvidence({
      llm: llm as never,
      model: "test-model",
      qualificationProfile: profile(),
      knowledgeHits: [
        {
          qualification: "Build Power BI dashboards",
          requirementId: "req-1",
          chunks: [chunk({ id: "chunk-1" })],
        },
      ],
      fallbackSelectedEvidence: fallback,
    });

    expect(selected[0]).toMatchObject({
      status: "transferable_only",
      confidence: "low",
    });
    expect(selected[0].reason).toContain("LLM evidence rerank unavailable");
  });
});
