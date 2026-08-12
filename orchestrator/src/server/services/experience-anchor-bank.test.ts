import { describe, expect, it } from "vitest";
import type { ResumeReferenceChunk, ResumeReferenceScanItem } from "@shared/types";
import { buildExperienceAnchorBank } from "./experience-anchor-bank";

const item = (suffix: string): ResumeReferenceScanItem => ({
  fileName: `Analytics ${suffix} Resume.docx`,
  relativePath: `refs/Analytics ${suffix} Resume.docx`,
  inferredRole: "data_analytics_operations",
  kind: "resume",
  sections: ["Experience", "Skills"],
  hasSkills: true,
  pageCount: 1,
  lastModified: 10,
  size: 100,
});

const chunk = (
  suffix: string,
  text: string,
  id = `refs/Analytics ${suffix} Resume.docx#experience-0`,
): ResumeReferenceChunk => ({
  id,
  relativePath: `refs/Analytics ${suffix} Resume.docx`,
  fileName: `Analytics ${suffix} Resume.docx`,
  kind: "resume",
  roleFamily: "data_analytics_operations",
  section: "Experience",
  text,
  rawText: text,
  normalizedText: text.toLowerCase(),
  keywords: ["Power BI", "Dashboard", "Stakeholder"],
  clusterId: `cluster-${suffix}`,
  qualitySignals: {
    textLength: text.length,
    keywordCount: 3,
    hasMetrics: /\d/.test(text),
    sectionScore: 3,
    sourceKindScore: 2,
    recencyScore: 1,
    confidence: "high",
  },
});

describe("experience anchor bank", () => {
  it("builds a stable anchor summary from multiple source variants", () => {
    const result = buildExperienceAnchorBank({
      items: [item("A"), item("B")],
      chunks: [
        chunk(
          "A",
          "Analyst at Analytics Team built Power BI dashboards, reporting packs, and QA checks for stakeholder decision support.",
        ),
        chunk(
          "B",
          "Analyst at Analytics Team delivered stakeholder-ready dashboard reporting and improved weekly operations visibility by 25%.",
        ),
      ],
      builtAt: "2026-06-07T00:00:00.000Z",
    });

    expect(result.anchors).toHaveLength(1);
    expect(result.anchors[0].identity.company).toContain("Analytics Team");
    expect(result.anchors[0].sourceChunkIds).toHaveLength(2);
    expect(result.anchors[0].toolsAndMethods.some((fact) => /Power BI/i.test(fact.text))).toBe(true);
    expect(result.anchors[0].measurableOutcomes.length).toBeGreaterThan(0);
    expect(result.chunks.every((entry) => entry.experienceAnchorId)).toBe(true);
  });

  it("records orphan chunks instead of forcing unsupported evidence into an anchor", () => {
    const result = buildExperienceAnchorBank({
      items: [],
      chunks: [
        {
          ...chunk("A", "short", "orphan"),
          kind: "unknown",
          text: "short",
          rawText: "short",
        },
      ],
    });

    expect(result.anchors).toHaveLength(0);
    expect(result.diagnostics.orphanEvidenceChunks).toEqual([
      expect.objectContaining({ chunkId: "orphan" }),
    ]);
  });
});
