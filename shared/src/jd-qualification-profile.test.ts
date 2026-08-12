import { describe, expect, it } from "vitest";
import { buildJdQualificationProfile } from "./jd-qualification-profile";

describe("buildJdQualificationProfile", () => {
  it("extracts short required and preferred qualifications from the qualifications section", () => {
    const profile = buildJdQualificationProfile({
      title: "Associate, Policy and Stakeholder Engagement",
      jobDescription: [
        "About the role",
        "Some introduction.",
        "Qualifications",
        "- Experience with stakeholder engagement and policy research.",
        "- Strong writing and briefing note skills.",
        "- French is considered an asset.",
        "Responsibilities",
        "- This should not be treated as a qualification.",
      ].join("\n"),
    });

    expect(profile.confidence).toBe("medium");
    expect(profile.required).toHaveLength(2);
    expect(profile.preferred).toEqual(["French is considered an asset."]);
    expect(profile.keywords).toContain("Stakeholder Engagement");
    expect(profile.required.join(" ")).not.toContain("Responsibilities");
  });

  it("falls back with low confidence when no qualification section exists", () => {
    const profile = buildJdQualificationProfile({
      title: "Senior Analyst",
      jobDescription:
        "The candidate must have Excel and reporting experience. The team builds enterprise strategy.",
    });

    expect(profile.confidence).toBe("low");
    expect(profile.required[0]).toContain("must have Excel");
    expect(profile.keywords).toContain("Excel");
  });

  it("does not treat mixed description and requirements headings as the qualification section", () => {
    const profile = buildJdQualificationProfile({
      title: "Senior Analyst, Enterprise Strategy & Planning",
      jobDescription: [
        "Description & Requirements",
        "lululemon is an innovative performance apparel company with stores and communities.",
        "The team supports enterprise strategy and planning.",
        "Who you are",
        "- 3+ years of enterprise strategy, business planning, or consulting experience.",
        "- Strong executive communication and cross-functional stakeholder skills.",
        "Responsibilities",
        "- This should stop the qualification extraction.",
      ].join("\n"),
    });

    expect(profile.confidence).toBe("medium");
    expect(profile.required.join(" ")).toContain("enterprise strategy");
    expect(profile.required.join(" ")).not.toContain("innovative performance apparel");
  });

  it("excludes hours, wage, and bargaining-unit terms from required qualifications", () => {
    const profile = buildJdQualificationProfile({
      title: "Policy Analyst",
      jobDescription: [
        "Qualifications",
        "- Degree in public policy, planning, economics, or a related field.",
        "- Experience preparing research, reports, and stakeholder materials.",
        "Hours: The normal hours of work are 35 hours per week in accordance with the Collective Agreement.",
        "Wage: This position is within the CUPE Local 2380 Bargaining Unit with the following pay level and 2026 pay range.",
        "Responsibilities",
        "- Support policy research and public engagement.",
      ].join("\n"),
    });

    const requiredText = profile.required.join(" ");
    const keywordText = profile.keywords.join(" ");
    expect(requiredText).toContain("Degree in public policy");
    expect(requiredText).toContain("Experience preparing research");
    expect(requiredText).not.toMatch(/\b(?:Hours|Wage|CUPE|Collective Agreement|pay range|Bargaining Unit)\b/i);
    expect(keywordText).not.toMatch(/\b(?:CUPE|Collective Agreement|pay range|Bargaining Unit)\b/i);
    expect(profile.ignoredAdminLines).toEqual(["Hours", "Wage"]);
  });

  it("skips administrative terms during low-confidence fallback extraction", () => {
    const profile = buildJdQualificationProfile({
      title: "Data Analyst",
      jobDescription: [
        "The candidate must have Excel and reporting experience.",
        "Hours: The normal hours of work are 35 hours per week.",
        "Wage: This position is within the CUPE Local 2380 Bargaining Unit.",
      ].join("\n"),
    });

    expect(profile.confidence).toBe("low");
    expect(profile.required).toEqual([
      "The candidate must have Excel and reporting experience.",
    ]);
    expect(profile.required.join(" ")).not.toMatch(/\b(?:Hours|Wage|CUPE)\b/i);
    expect(profile.ignoredAdminLines).toEqual(["Hours", "Wage"]);
  });

  it("extracts City of Barrie style qualification sections without subheading or admin noise", () => {
    const profile = buildJdQualificationProfile({
      title: "Business Development Analyst",
      employer: "City of Barrie",
      jobDescription: [
        "Our Culture and Qualifications of the Job",
        "Corporate Culture: Your workplace values align with our corporate values.",
        "Education (degree/diploma/certifications)",
        "Four (4) year University Degree in market research, statistics, business, economics, communications, social sciences, or equivalent.",
        "Experience",
        "Three (3) years of experience performing duties related to the major responsibilities of the position",
        "Knowledge/Skill/Ability",
        "Working knowledge of primary, secondary, and tertiary research practices, processes, and principles, the North American Industry Classification System (NAICS) and its associated codes.",
        "Demonstrated Ability to:",
        "Conduct research for problem solving and to develop solutions by analyzing facts, generating comparisons and drawing conclusions from available information.",
        "Equally important to what we do is how we do it.",
        "Don’t meet the education credentials as outlined above but have years of directly related experience? Please see the City’s Education Equivalency Policy to determine if you may qualify for equivalency.",
        "Position Equivalency Code: F",
        "Further information is available at www.barrie.ca/JobOpps .",
        "Conditions of Employment",
        "Satisfactory Criminal Record Check",
        "Hours: The normal hours of work are 35 hours per week in accordance with the Collective Agreement",
        "Wage: This position is within the CUPE Local 2380 Bargaining Unit with the following pay level and 2026 pay range:",
        "Pay Level: Level 7",
      ].join("\n"),
    });

    const requiredText = profile.required.join(" ");
    expect(profile.confidence).toBe("high");
    expect(profile.required).toEqual([
      "Four (4) year University Degree in market research, statistics, business, economics, communications, social sciences, or equivalent.",
      "Three (3) years of experience performing duties related to the major responsibilities of the position",
      "Working knowledge of primary, secondary, and tertiary research practices, processes, and principles, the North American Industry Classification System (NAICS) and its associated codes.",
      "Conduct research for problem solving and to develop solutions by analyzing facts, generating comparisons and drawing conclusions from available information.",
    ]);
    expect(requiredText).not.toMatch(/\b(?:Hours|Wage|CUPE|Pay Level|Education|Knowledge\/Skill\/Ability|Demonstrated Ability|Corporate Culture)\b/i);
    expect(requiredText).not.toMatch(/\b(?:Equally important|Further information|Education Equivalency|Position Equivalency Code|JobOpps)\b/i);
    expect(profile.ignoredAdminLines).toEqual([
      "Values Statement",
      "Education Equivalency Note",
      "Education Equivalency Code",
      "JobOpps Link",
    ]);
  });

  it("excludes Ipsos-style compensation and company description text from required qualifications", () => {
    const profile = buildJdQualificationProfile({
      title: "Research Analyst",
      employer: "Ipsos Canada",
      jobDescription: [
        "Who you are",
        "Bachelor's degree in market research, social sciences, business, or a related field.",
        "Experience supporting survey research, questionnaire design, analysis, and reporting.",
        "Strong Excel and written communication skills.",
        "Your final base salary will be determined based on several non-discriminatory factors which may include but are not limited to location, work experience, skills, knowledge, education and/or certifications.",
        "Our approach is deeply human-centric, and our global network of expert teams have a rigorous understanding of CX and EX that’s backed by decades of cultural knowledge and industry experience.",
      ].join("\n"),
    });

    const requiredText = profile.required.join(" ");
    expect(profile.required).toEqual([
      "Bachelor's degree in market research, social sciences, business, or a related field.",
      "Experience supporting survey research, questionnaire design, analysis, and reporting.",
      "Strong Excel and written communication skills.",
    ]);
    expect(requiredText).not.toMatch(/\b(?:final base salary|non-discriminatory|human-centric|global network|cultural knowledge|industry experience)\b/i);
    expect(profile.ignoredAdminLines).toEqual([
      "Compensation",
      "Company Description",
    ]);
  });
});
