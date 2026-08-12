import type { DesignResumeJson } from "@shared/types";
import { describe, expect, it } from "vitest";
import { compactDesignResumeJson } from "./compact";

function makeResume(): DesignResumeJson {
  const description =
    "<ul><li>Conducted labour market research across multiple regions with data cleaning, stakeholder synthesis, and policy memo production.</li><li>Built Excel and Python analysis tools for sector prioritization and scenario comparison.</li><li>Prepared dashboard-ready findings for municipal and public sector audiences.</li><li>Supported client presentations with concise strategic recommendations.</li><li>Maintained source notes and assumptions for repeatable analysis.</li></ul>";

  return {
    picture: { hidden: true, url: "" },
    basics: {
      name: "Test Candidate",
      headline: "Policy Data Consultant",
      email: "test@example.com",
      phone: "",
      location: "Toronto, ON",
      website: { url: "", label: "" },
      customFields: [],
    },
    summary: {
      title: "Summary",
      columns: 1,
      hidden: false,
      content:
        "<p>Policy and data consultant with experience in labour market analysis, regional strategy, public sector research, and client-facing storytelling across municipal and provincial contexts.</p>",
    },
    sections: {
      profiles: { title: "Profiles", columns: 1, hidden: true, items: [] },
      experience: {
        title: "Experience",
        columns: 1,
        hidden: false,
        items: Array.from({ length: 5 }, (_, index) => ({
          id: `exp-${index}`,
          hidden: false,
          company: `Employer ${index}`,
          position: "Consultant",
          location: "Ontario",
          period: "2024 - 2026",
          website: { url: "", label: "" },
          description,
          roles: [],
        })),
      },
      education: {
        title: "Education",
        columns: 1,
        hidden: false,
        items: [
          {
            id: "edu-1",
            hidden: false,
            school: "School",
            degree: "Master",
            area: "Policy",
            grade: "",
            location: "Toronto",
            period: "2023",
            website: { url: "", label: "" },
            description: "<ul><li>Relevant coursework and research.</li></ul>",
          },
        ],
      },
      projects: {
        title: "Projects",
        columns: 1,
        hidden: false,
        items: [
          {
            id: "project-1",
            hidden: false,
            name: "Dashboard",
            period: "2025",
            website: { url: "", label: "" },
            description: description,
          },
        ],
      },
      skills: {
        title: "Skills",
        columns: 1,
        hidden: false,
        items: [
          {
            id: "skill-1",
            hidden: false,
            icon: "",
            name: "Analysis",
            proficiency: "",
            level: 5,
            keywords: [
              "Policy research",
              "Labour market analysis",
              "Python data cleaning",
              "Excel dashboards",
              "Stakeholder engagement",
              "Strategic storytelling",
              "Public sector memos",
              "Scenario modelling",
            ],
          },
        ],
      },
      languages: { title: "Languages", columns: 1, hidden: false, items: [] },
      interests: { title: "Interests", columns: 1, hidden: false, items: [] },
      awards: { title: "Awards", columns: 1, hidden: false, items: [] },
      certifications: {
        title: "Certifications",
        columns: 1,
        hidden: false,
        items: [],
      },
      publications: {
        title: "Publications",
        columns: 1,
        hidden: false,
        items: [],
      },
      volunteer: { title: "Volunteer", columns: 1, hidden: false, items: [] },
      references: {
        title: "References",
        columns: 1,
        hidden: false,
        items: [],
      },
    },
    customSections: [],
    metadata: {
      template: "jake",
      layout: { sidebarWidth: 30, pages: [] },
      css: { enabled: false, value: "" },
      page: {
        gapX: 8,
        gapY: 8,
        marginX: 16,
        marginY: 16,
        format: "letter",
        locale: "en-CA",
        hideIcons: false,
      },
      design: {
        level: { icon: "", type: "hidden" },
        colors: { primary: "#111111", text: "#111111", background: "#ffffff" },
      },
      typography: {
        body: {
          fontFamily: "Arial",
          fontWeights: [],
          fontSize: 11,
          lineHeight: 1.4,
        },
        heading: {
          fontFamily: "Arial",
          fontWeights: [],
          fontSize: 14,
          lineHeight: 1.4,
        },
      },
      notes: "",
    },
  } as unknown as DesignResumeJson;
}

describe("compactDesignResumeJson", () => {
  it("creates a layout-only one-page clone without mutating or shortening content", () => {
    const source = makeResume();
    const originalSections = structuredClone(source.sections);
    const originalSummary = structuredClone(source.summary);
    const compacted = compactDesignResumeJson(source, 1);

    expect(compacted).not.toBe(source);
    expect(source.sections).toEqual(originalSections);
    expect(compacted.sections).toEqual(originalSections);
    expect(compacted.summary).toEqual(originalSummary);
    expect(compacted.metadata.page.marginX).toBeLessThan(
      source.metadata.page.marginX,
    );
    expect(compacted.metadata.typography.body.fontSize).toBeLessThan(
      source.metadata.typography.body.fontSize,
    );
  });

  it("applies two-page layout density without hiding sections or limiting bullets", () => {
    const source = makeResume();
    const originalSections = structuredClone(source.sections);
    const compacted = compactDesignResumeJson(source, 2);

    expect(compacted.sections).toEqual(originalSections);
    expect(compacted.metadata.page.marginX).toBeLessThan(
      source.metadata.page.marginX,
    );
    expect(compacted.metadata.typography.body.lineHeight).toBeLessThan(
      source.metadata.typography.body.lineHeight,
    );
  });
});
