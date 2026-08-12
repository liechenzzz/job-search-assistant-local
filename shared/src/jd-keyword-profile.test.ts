import { describe, expect, it } from "vitest";
import {
  applyDomainGateToText,
  scanDomainGateResidualFields,
} from "./jd-domain-gate";
import { buildJdKeywordProfile } from "./jd-keyword-profile";

describe("buildJdKeywordProfile", () => {
  it("blocks public-sector domain terms for pure data analyst JDs", () => {
    const profile = buildJdKeywordProfile({
      title: "Data Analyst",
      employer: "RetailCo",
      jobDescription:
        "Build SQL reports, Power BI dashboards, data quality checks, and recurring KPI reporting for operations teams.",
    });

    expect(profile.roleFamily).toBe("data_analytics_operations");
    expect(profile.requiredKeywords).toEqual(
      expect.arrayContaining(["SQL", "Power BI", "dashboard", "data quality"]),
    );
    expect(profile.domainKeywordsPresent).toHaveLength(0);
    expect(profile.blockedUnlessPresent).toEqual(
      expect.arrayContaining(["NOC", "NAICS", "municipal stakeholder"]),
    );
  });

  it("allows public-sector domain terms when the JD includes them", () => {
    const profile = buildJdKeywordProfile({
      title: "Policy Analyst",
      employer: "City of Toronto",
      jobDescription:
        "Prepare municipal policy analysis, economic development briefings, and labour market research using NOC and NAICS evidence.",
    });

    expect(profile.roleFamily).toBe("public_sector_policy_economic_development");
    expect(profile.domainKeywordsPresent).toEqual(
      expect.arrayContaining(["municipal", "economic development", "NOC", "NAICS"]),
    );
    expect(profile.blockedUnlessPresent).not.toContain("NOC");
    expect(profile.blockedUnlessPresent).not.toContain("NAICS");
  });

  it("maps consulting JDs to consulting strategy", () => {
    const profile = buildJdKeywordProfile({
      title: "Strategy Consultant",
      employer: "Advisory Firm",
      jobDescription:
        "Support client strategy engagements, market analysis, stakeholder interviews, and implementation roadmap development.",
    });

    expect(profile.roleFamily).toBe("consulting_strategy");
    expect(profile.experienceFocus).toEqual(expect.arrayContaining(["strategy work"]));
  });

  it("blocks public-sector domain terms for lululemon enterprise strategy JDs", () => {
    const profile = buildJdKeywordProfile({
      title: "Senior Analyst, Enterprise Strategy & Planning",
      employer: "lululemon",
      jobDescription:
        "Lead enterprise strategy, annual planning, executive presentations, KPI reporting, and cross-functional business analysis.",
    });

    expect(profile.domainKeywordsPresent).toHaveLength(0);
    expect(profile.blockedUnlessPresent).toEqual(
      expect.arrayContaining(["NOC", "NAICS", "RTRA", "public sector"]),
    );
    expect(profile.requiredKeywords).toEqual(
      expect.arrayContaining(["strategy", "KPI"]),
    );
  });

  it("returns structured residuals with severity and field paths", () => {
    const profile = buildJdKeywordProfile({
      title: "Senior Analyst, Enterprise Strategy & Planning",
      employer: "lululemon",
      jobDescription:
        "Lead enterprise strategy, annual planning, KPI reporting, and cross-functional analysis.",
    });

    const residuals = scanDomainGateResidualFields(
      [
        {
          section: "Experience",
          path: "Experience > Regional Research Consultancy > bullet 2",
          text: "Built economic development analysis using NAICS evidence.",
        },
      ],
      profile,
    );

    expect(residuals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          term: "economic development",
          severity: "repairable",
          path: "Experience > Regional Research Consultancy > bullet 2",
        }),
        expect.objectContaining({
          term: "NAICS",
          severity: "strict",
        }),
      ]),
    );
  });
});

describe("applyDomainGateToText", () => {
  it("generalizes blocked domain terms for pure analyst JDs", () => {
    const profile = buildJdKeywordProfile({
      title: "Data Analyst",
      employer: "RetailCo",
      jobDescription:
        "Build SQL reports, Power BI dashboards, data quality checks, and recurring KPI reporting for operations teams.",
    });

    const result = applyDomainGateToText(
      "Analyzed NOC and NAICS data from RTRA for municipal stakeholders through an economic development jurisdictional scan.",
      profile,
    );

    expect(result.changed).toBe(true);
    expect(result.text).toContain("occupational classification");
    expect(result.text).toContain("industry classification");
    expect(result.text).toContain("large-scale source data");
    expect(result.text).toContain("stakeholders");
    expect(result.text).toContain("regional strategy");
    expect(result.text).toContain("comparative review");
    expect(result.text).not.toMatch(/\b(?:NOC|NAICS|RTRA|municipal)\b/i);
  });

  it("keeps domain terms when the JD explicitly asks for them", () => {
    const profile = buildJdKeywordProfile({
      title: "Policy Analyst",
      employer: "City of Toronto",
      jobDescription:
        "Prepare municipal policy analysis and economic development briefings using NOC and NAICS evidence.",
    });

    const result = applyDomainGateToText(
      "Analyzed NOC and NAICS evidence for municipal stakeholders.",
      profile,
    );

    expect(result.changed).toBe(false);
    expect(result.text).toContain("NOC");
    expect(result.text).toContain("NAICS");
    expect(result.text).toContain("municipal");
  });
});
