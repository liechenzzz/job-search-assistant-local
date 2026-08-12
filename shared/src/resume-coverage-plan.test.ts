import { describe, expect, it } from "vitest";
import { buildResumeCoveragePlan } from "./resume-coverage-plan";

describe("buildResumeCoveragePlan", () => {
  it("maps required qualifications to resume sections and reference evidence", () => {
    const plan = buildResumeCoveragePlan({
      qualificationProfile: {
        required: [
          "Experience with stakeholder engagement and policy research.",
          "Strong Power BI dashboard reporting skills.",
          "French bilingual ability.",
        ],
        preferred: [],
        keywords: ["Stakeholder Engagement", "Power BI", "French"],
        confidence: "high",
      },
      resumeSections: {
        summary: "Policy researcher with stakeholder engagement experience.",
        experience: "Prepared policy research and stakeholder summaries.",
        skills: "Excel, reporting",
      },
      referenceItems: [
        {
          fileName: "Data Analyst Resume.docx",
          relativePath: "refs/Data Analyst Resume.docx",
          inferredRole: "data_analytics_operations",
          kind: "resume",
          sections: ["Skills", "Experience"],
          hasSkills: true,
          pageCount: 1,
          keywords: ["Power BI", "Dashboard", "Reporting"],
          snippets: {
            experience: "Built Power BI dashboard reporting for operations.",
          },
        },
      ],
    });

    expect(plan.items[0].status).toBe("covered");
    expect(plan.items[1].status).toBe("partial");
    expect(plan.items[1].evidenceStatus).toBe("direct");
    expect(plan.items[1].sourceType).toBe("reference");
    expect(plan.referenceUsed).toEqual(["refs/Data Analyst Resume.docx"]);
    expect(plan.missingRequired).toEqual(["French bilingual ability."]);
  });

  it("captures transferable strategy evidence and allowed wording hints", () => {
    const plan = buildResumeCoveragePlan({
      qualificationProfile: {
        required: [
          "Experience supporting enterprise strategy and business planning.",
        ],
        preferred: [],
        keywords: ["Enterprise Strategy", "Business Planning"],
        confidence: "high",
      },
      resumeSections: {
        summary: "",
        experience:
          "Developed prioritization recommendations and decision-ready planning materials for leadership.",
      },
    });

    expect(plan.items[0].status).toBe("partial");
    expect(plan.items[0].evidenceStatus).toBe("transferable");
    expect(plan.items[0].sourceType).toBe("master");
    expect(plan.items[0].allowedWordingHints).toContain("strategic planning");
    expect(plan.items[0].targetSections).toContain("experience");
  });

  it("requires education evidence for education qualifications", () => {
    const requirement =
      "Four (4) year University Degree in market research, statistics, business, economics, communications, social sciences, or equivalent.";
    const plan = buildResumeCoveragePlan({
      qualificationProfile: {
        required: [requirement],
        preferred: [],
        keywords: ["Market Research", "Social Sciences"],
        confidence: "high",
      },
      resumeSections: {
        education:
          "Example University Bachelor of Arts, Social Science. Master of Public Policy.",
        experience:
          "Conducted market research, statistics analysis, business analysis, and economic research for municipal projects.",
      },
    });

    expect(plan.items[0].semanticType).toBe("education");
    expect(plan.items[0].allowedEvidenceSections).toEqual(["education"]);
    expect(plan.items[0].status).toBe("covered");
    expect(plan.items[0].sections).toEqual(["education"]);
    expect(plan.items[0].evidenceSources).toEqual(["resume:education"]);
  });

  it("does not let experience fully cover a strict education field requirement", () => {
    const requirement = "Degree in statistics or economics required.";
    const plan = buildResumeCoveragePlan({
      qualificationProfile: {
        required: [requirement],
        preferred: [],
        keywords: ["Statistics", "Economics"],
        confidence: "high",
      },
      resumeSections: {
        education:
          "Example University Bachelor of Arts, Social Science. Master of Public Policy.",
        experience:
          "Conducted statistics analysis and economics research for business planning projects.",
      },
    });

    expect(plan.items[0].semanticType).toBe("education");
    expect(plan.items[0].status).toBe("partial");
    expect(plan.items[0].sections).toEqual(["education"]);
    expect(plan.items[0].evidenceSources).toEqual(["resume:education"]);
  });
});
