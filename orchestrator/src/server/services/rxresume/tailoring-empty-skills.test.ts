import { describe, expect, it } from "vitest";
import {
  applyDomainGateToResumeData,
  applyTailoredExperience,
  applyTailoredSkills,
} from "./tailoring";

describe("applyTailoredSkills", () => {
  it("creates a visible skills section when the resume template has hidden empty skills", () => {
    const resumeData: Record<string, any> = {
      sections: {
        skills: {
          title: "Skills",
          hidden: true,
          items: [],
        },
      },
    };

    applyTailoredSkills(resumeData, [
      { name: "Policy Data", keywords: ["SQL", "dashboarding"] },
      { name: "Public Sector Research", keywords: ["stakeholders"] },
    ]);

    const skills = resumeData.sections.skills;
    expect(skills.hidden).toBe(false);
    expect(skills.items).toHaveLength(2);
    const items = skills.items as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(skills.items[0]).toMatchObject({
      hidden: false,
      name: "Policy Data",
      keywords: ["SQL", "dashboarding"],
    });
    expect(skills.items[1]).toMatchObject({
      hidden: false,
      name: "Public Sector Research",
      keywords: ["stakeholders"],
    });
  });
});

describe("applyDomainGateToResumeData", () => {
  it("cleans stale master experience text without changing employer fields", () => {
    const resumeData: Record<string, any> = {
      summary: {
        content: "Analyst with NOC and NAICS reporting experience.",
      },
      sections: {
        skills: {
          items: [
            {
              id: "skill-1",
              name: "Analytics",
              keywords: ["SQL", "NOC", "NAICS"],
            },
          ],
        },
        experience: {
          items: [
            {
              id: "exp-1",
              company: "Example Municipality",
              position: "Analyst",
              location: "Mississauga",
              description:
                "<ul><li>Analyzed NOC and NAICS data for municipal stakeholders.</li></ul>",
              roles: [
                {
                  id: "role-1",
                  description: "Prepared RTRA jurisdictional scan evidence.",
                },
              ],
            },
          ],
        },
      },
    };

    applyDomainGateToResumeData(resumeData, {
      roleFamily: "data_analytics_operations",
      requiredKeywords: ["SQL"],
      domainKeywordsPresent: [],
      blockedUnlessPresent: [
        "NOC",
        "NAICS",
        "RTRA",
        "municipal stakeholder",
        "jurisdictional scan",
      ],
      experienceFocus: ["reporting"],
    });

    expect(resumeData.sections.experience.items[0].company).toBe(
      "Example Municipality",
    );
    const serialized = JSON.stringify(resumeData);
    expect(serialized).toContain("occupational classification");
    expect(serialized).toContain("industry classification");
    expect(serialized).toContain("large-scale source data");
    expect(serialized).not.toMatch(/\b(?:NOC|NAICS|RTRA|municipal)\b/i);
  });

  it("cleans rendered project and skill content for non-government strategy roles", () => {
    const resumeData: Record<string, any> = {
      basics: {
        headline: "NOC strategy analyst",
        name: "Jane Candidate",
      },
      summary: {
        content: "Enterprise strategy analyst with NAICS reporting.",
      },
      sections: {
        skills: {
          items: [
            {
              id: "skill-1",
              name: "NOC Analysis",
              proficiency: "NAICS segmentation",
              keywords: ["RTRA", "municipal stakeholder reporting"],
            },
          ],
        },
        projects: {
          items: [
            {
              id: "project-1",
              name: "NOC and NAICS Strategy Dashboard",
              keywords: ["NOC", "NAICS"],
              description:
                "<ul><li>Built RTRA dashboard for municipal stakeholders.</li></ul>",
            },
          ],
        },
        experience: {
          items: [
            {
              id: "exp-1",
              company: "Example Municipality",
              position: "Graduate Consultant",
              location: "Mississauga",
              period: "2024 - 2025",
              description: "<ul><li>Produced NOC analysis.</li></ul>",
            },
          ],
        },
      },
    };

    applyDomainGateToResumeData(resumeData, {
      roleFamily: "consulting_strategy",
      requiredKeywords: ["strategy"],
      domainKeywordsPresent: [],
      blockedUnlessPresent: ["NOC", "NAICS", "RTRA", "municipal stakeholder"],
      experienceFocus: ["strategy work"],
    });

    expect(resumeData.sections.experience.items[0]).toMatchObject({
      company: "Example Municipality",
      position: "Graduate Consultant",
      location: "Mississauga",
      period: "2024 - 2025",
    });
    const serialized = JSON.stringify(resumeData);
    expect(serialized).toContain("occupational classification");
    expect(serialized).toContain("industry classification");
    expect(serialized).toContain("large-scale source data");
    expect(serialized).not.toMatch(/\b(?:NOC|NAICS|RTRA|municipal)\b/i);
  });
});

describe("applyTailoredExperience", () => {
  it("rewrites experience bullets by id and ignores missing ids", () => {
    const resumeData: Record<string, any> = {
      sections: {
        experience: {
          hidden: false,
          items: [
            {
              id: "exp-1",
              company: "City Team",
              position: "Analyst",
              description: "<ul><li>Old policy bullet</li></ul>",
            },
            {
              id: "exp-2",
              company: "Research Team",
              position: "Researcher",
              description: "<ul><li>Keep this bullet</li></ul>",
            },
          ],
        },
      },
    };

    applyTailoredExperience(resumeData, [
      {
        id: "exp-1",
        bullets: ["Built SQL dashboards from verified operational datasets."],
      },
      {
        id: "missing",
        bullets: ["This should not appear."],
      },
    ]);

    expect(resumeData.sections.experience.items[0].description).toContain(
      "Built SQL dashboards",
    );
    expect(resumeData.sections.experience.items[0].company).toBe("City Team");
    expect(resumeData.sections.experience.items[1].description).toContain(
      "Keep this bullet",
    );
    expect(JSON.stringify(resumeData)).not.toContain("This should not appear");
  });
});
