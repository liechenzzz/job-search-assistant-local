import { describe, expect, it } from "vitest";
import {
  buildResumeAlignmentReport,
  filterSkillsForQualificationEvidence,
} from "./resume-alignment";
import { buildResumeCoveragePlan } from "./resume-coverage-plan";

describe("resume alignment", () => {
  it("fails when two or more required qualifications are missing", () => {
    const report = buildResumeAlignmentReport({
      qualificationProfile: {
        required: [
          "Experience with stakeholder engagement and policy research.",
          "Strong writing and briefing note skills.",
          "French bilingual ability.",
        ],
        preferred: [],
        keywords: ["Stakeholder Engagement", "Policy Research", "French"],
        confidence: "high",
      },
      resumeSections: {
        summary: "Policy researcher with stakeholder engagement experience.",
        experience: "Prepared stakeholder research.",
        skills: "Policy research",
      },
    });

    expect(report.status).toBe("failed");
    expect(report.missingRequired).toHaveLength(2);
    expect(report.score).toBeLessThan(70);
    expect(report.repairableRequired).toEqual([]);
    expect(report.alignmentSource).toBe("deterministic");
    expect(report.engineVersion).toBe("semantic-v4");
  });

  it("keeps only JD and evidence-backed skill keywords", () => {
    const skills = filterSkillsForQualificationEvidence(
      [
        {
          name: "Analytics",
          keywords: ["Python", "Power BI", "Stakeholder engagement"],
        },
        {
          name: "Policy",
          keywords: ["Policy research", "Briefing notes"],
        },
      ],
      {
        qualificationProfile: {
          required: [
            "Experience with stakeholder engagement and policy research.",
            "Strong writing and briefing note skills.",
          ],
          preferred: [],
          keywords: ["Stakeholder Engagement", "Policy Research", "Briefing"],
          confidence: "high",
        },
        evidenceText:
          "Prepared stakeholder engagement research and briefing notes for policy projects.",
      },
    );

    expect(skills.flatMap((group) => group.keywords)).toEqual([
      "Stakeholder engagement",
      "Policy research",
      "Briefing notes",
    ]);
  });

  it("credits JD-aligned transferable wording when the coverage brief supports it", () => {
    const qualificationProfile = {
      required: [
        "Experience supporting enterprise strategy and business planning.",
      ],
      preferred: [],
      keywords: ["Enterprise Strategy", "Business Planning"],
      confidence: "high" as const,
    };
    const resumeSections = {
      summary:
        "Strategy analyst supporting strategic planning and business planning priorities.",
      experience:
        "Developed prioritization recommendations and decision-ready planning materials for leadership.",
    };
    const coveragePlan = buildResumeCoveragePlan({
      qualificationProfile,
      resumeSections,
    });

    const report = buildResumeAlignmentReport({
      qualificationProfile,
      resumeSections,
      coveragePlan,
    });

    expect(report.status).toBe("pass");
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.humanInputNeeded).toEqual([]);
  });

  it("separates no-evidence gaps from repairable partial gaps", () => {
    const report = buildResumeAlignmentReport({
      qualificationProfile: {
        required: ["French bilingual ability."],
        preferred: [],
        keywords: ["French"],
        confidence: "high",
      },
      resumeSections: {
        summary: "Policy researcher with stakeholder engagement experience.",
      },
    });

    expect(report.status).toBe("warning");
    expect(report.missingRequired).toEqual(["French bilingual ability."]);
    expect(report.humanInputNeeded).toEqual(["French bilingual ability."]);
    expect(report.repairableRequired).toEqual([]);
    expect(report.alignmentSource).toBe("deterministic");
  });

  it("marks evidence-backed partial requirements as repairable", () => {
    const requirement = "Experience building Tableau dashboards.";
    const qualificationProfile = {
      required: [requirement],
      preferred: [],
      keywords: ["Tableau", "dashboards"],
      confidence: "high" as const,
    };
    const resumeSections = {
      summary: "Analyst supporting operations research.",
      experience: "Prepared planning notes for leadership.",
    };
    const coveragePlan = {
      items: [
        {
          qualification: requirement,
          status: "partial" as const,
          sections: [],
          evidenceSources: ["reference:Data Analyst Resume.docx"],
          evidenceStatus: "transferable" as const,
          targetSections: ["experience"],
          allowedWordingHints: ["dashboard reporting"],
          sourceType: "reference" as const,
        },
      ],
      missingRequired: [],
      partialRequired: [requirement],
      humanInputNeeded: [],
    };

    const report = buildResumeAlignmentReport({
      qualificationProfile,
      resumeSections,
      coveragePlan,
    });

    expect(report.status).toBe("warning");
    expect(report.partialRequired).toEqual([requirement]);
    expect(report.repairableRequired).toEqual([requirement]);
    expect(report.humanInputNeeded).toEqual([]);
    expect(report.evidenceFit?.score).toBeGreaterThan(report.score);
    expect(report.evidenceFit?.referenceUsed).toEqual(["Data Analyst Resume.docx"]);
  });

  it("separates RAG evidence fit from generated resume alignment", () => {
    const requirement = "Experience gathering business requirements from stakeholders.";
    const qualificationProfile = {
      required: [requirement],
      preferred: [],
      keywords: ["Business Requirements", "Stakeholders"],
      confidence: "high" as const,
    };
    const resumeSections = {
      summary: "Research analyst supporting reporting.",
      experience: "Prepared reports and analysis.",
    };
    const coveragePlan = {
      items: [
        {
          qualification: requirement,
          status: "partial" as const,
          sections: [],
          evidenceSources: ["reference:Business Analyst Resume.docx"],
          evidenceStatus: "direct" as const,
          targetSections: ["experience"],
          allowedWordingHints: ["requirements gathering", "stakeholder analysis"],
          sourceType: "reference" as const,
        },
      ],
      missingRequired: [],
      partialRequired: [requirement],
      referenceUsed: ["Business Analyst Resume.docx"],
    };

    const report = buildResumeAlignmentReport({
      qualificationProfile,
      resumeSections,
      coveragePlan,
    });

    expect(report.status).toBe("warning");
    expect(report.partialRequired).toEqual([requirement]);
    expect(report.repairableRequired).toEqual([requirement]);
    expect(report.evidenceFit?.status).toBe("pass");
    expect(report.evidenceFit?.score).toBe(100);
  });

  it("covers social-science-adjacent education requirements from education evidence", () => {
    const requirement =
      "Four (4) year University Degree in market research, statistics, business, economics, communications, social sciences, or equivalent.";
    const qualificationProfile = {
      required: [requirement],
      preferred: [],
      keywords: ["Social Sciences", "Communications"],
      confidence: "high" as const,
    };
    const resumeSections = {
      education:
        "University of Toronto Bachelor of Arts, City Studies and Media Studies. Master of Urban Innovation.",
      experience:
        "Conducted market research and business analysis for economic development projects.",
    };
    const coveragePlan = buildResumeCoveragePlan({
      qualificationProfile,
      resumeSections,
    });

    const report = buildResumeAlignmentReport({
      qualificationProfile,
      resumeSections,
      coveragePlan,
    });

    expect(report.status).toBe("pass");
    expect(report.missingRequired).toEqual([]);
    expect(report.humanInputNeeded).toEqual([]);
    expect(report.matchedSections.education).toBeGreaterThan(0);
  });

  it("covers bachelor's degree in a related field from education evidence", () => {
    const requirement =
      "Bachelor's degree in market research, social sciences, business, or a related field.";
    const qualificationProfile = {
      required: [requirement],
      preferred: [],
      keywords: ["Market Research", "Social Sciences", "Business"],
      confidence: "high" as const,
    };
    const resumeSections = {
      education:
        "University of Toronto Bachelor of Arts, City Studies and Media Studies. Master of Urban Innovation.",
      experience:
        "Supported survey research, analysis, reporting, and client-ready insight synthesis.",
    };
    const coveragePlan = buildResumeCoveragePlan({
      qualificationProfile,
      resumeSections,
    });

    const report = buildResumeAlignmentReport({
      qualificationProfile,
      resumeSections,
      coveragePlan,
    });

    expect(report.status).toBe("pass");
    expect(report.missingRequired).toEqual([]);
    expect(report.humanInputNeeded).toEqual([]);
    expect(report.matchedSections.education).toBeGreaterThan(0);
  });

  it("does not use experience as full coverage for strict education fields", () => {
    const requirement = "Degree in statistics or economics required.";
    const qualificationProfile = {
      required: [requirement],
      preferred: [],
      keywords: ["Statistics", "Economics"],
      confidence: "high" as const,
    };
    const resumeSections = {
      education:
        "University of Toronto Bachelor of Arts, City Studies and Media Studies. Master of Urban Innovation.",
      experience:
        "Conducted statistics analysis and economics research for business planning projects.",
    };
    const coveragePlan = buildResumeCoveragePlan({
      qualificationProfile,
      resumeSections,
    });

    const report = buildResumeAlignmentReport({
      qualificationProfile,
      resumeSections,
      coveragePlan,
    });

    expect(report.status).toBe("warning");
    expect(report.partialRequired).toEqual([requirement]);
    expect(report.missingRequired).toEqual([]);
    expect(report.repairableRequired).toEqual([requirement]);
  });
});
