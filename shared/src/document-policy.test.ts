import { describe, expect, it } from "vitest";
import {
  buildCoverLetterHeader,
  buildCoverLetterPolicyInstructions,
  buildResumePolicyInstructions,
  countVisibleWords,
  resolveDocumentPolicy,
  validateCoverLetterWordLimit,
} from "./document-policy";

describe("document policy", () => {
  it("uses a one-page resume target for consulting strategy roles", () => {
    const policy = resolveDocumentPolicy({
      title: "Associate Consultant, Strategy & Technology",
      employer: "Konrad",
      jobDescription:
        "Client workshops, strategy recommendations, business case analysis, and executive-ready decks.",
    });

    expect(policy.roleFamily).toBe("consulting_strategy");
    expect(policy.resumeTargetPages).toBe(1);
    expect(policy.resumePagePolicyMode).toBe("locked");
    expect(policy.resumePagePolicyReason).toBe("consulting");
    expect(buildResumePolicyInstructions(policy)).toContain(
      "one-page consulting resumes",
    );
  });

  it("uses a two-page resume target for OPS roles", () => {
    const policy = resolveDocumentPolicy({
      title: "Junior Policy Advisor",
      employer: "Ontario Public Service",
      jobDescription:
        "Policy research, briefing materials, stakeholder analysis, implementation advice, and jurisdictional scans.",
    });

    expect(policy.roleFamily).toBe("public_sector_policy_economic_development");
    expect(policy.resumeTargetPages).toBe(2);
    expect(policy.resumePagePolicyMode).toBe("locked");
    expect(policy.resumePagePolicyReason).toBe("ontario_provincial");
  });

  it("locks city and municipal jobs to two pages", () => {
    const policy = resolveDocumentPolicy({
      title: "Data Analyst",
      employer: "City of Hamilton",
      jobDescription: "Analyze service data and prepare dashboards.",
    });

    expect(policy.resumeTargetPages).toBe(2);
    expect(policy.resumePagePolicyMode).toBe("locked");
    expect(policy.resumePagePolicyReason).toBe("city_public_sector");
  });

  it("locks City of Barrie jobs to the two-page city public-sector policy", () => {
    const policy = resolveDocumentPolicy({
      source: "ontario-public-sector",
      title: "Business Development Analyst",
      employer: "City of Barrie",
      location: "City Hall, 70 Collier Street, Barrie, Ontario",
      jobUrl:
        "https://careers.barrie.ca/business-development-analyst-CA-238837-en",
      applicationLink:
        "https://barrie.hiringplatform.ca/238837-business-development-analyst/1081837/en",
      jobDescription:
        "Conduct business development research, prepare reports, and support municipal economic initiatives.",
      resumeTargetPagesOverride: 1,
    });

    expect(policy.resumeTargetPages).toBe(2);
    expect(policy.resumePagePolicyMode).toBe("locked");
    expect(policy.resumePagePolicyReason).toBe("city_public_sector");
    expect(policy.allowsManualResumeTargetPages).toBe(false);
  });

  it.each([
    {
      title: "Planning and Policy Analyst",
      employer: "National Research Council Canada",
      jobDescription:
        "Prepare executive analysis, support Treasury Board documents, and liaise with Government of Canada stakeholders.",
    },
    {
      title: "Policy and Partnerships Intern",
      employer: "Building Ontario Fund",
      jobDescription:
        "Support policy, partnerships, stakeholder requests, and public-sector investment planning.",
    },
    {
      title: "Program Analyst, Policy & Regulatory Compliance",
      employer: "Greater Toronto Airports Authority",
      jobDescription:
        "Support policy management, regulatory compliance reporting, and enterprise public agency programs.",
    },
    {
      source: "public agency careers",
      title: "Regulatory Policy Analyst",
      employer: "Regional Transit Authority",
      jobDescription:
        "Draft briefing notes and regulatory policy advice for a public agency.",
    },
  ])("locks broad public-sector jobs to two pages: $employer", (input) => {
    const policy = resolveDocumentPolicy({
      ...input,
      resumeTargetPagesOverride: 1,
    });

    expect(policy.resumeTargetPages).toBe(2);
    expect(policy.resumePagePolicyMode).toBe("locked");
    expect(policy.resumePagePolicyReason).toBe("public_sector_government");
    expect(policy.allowsManualResumeTargetPages).toBe(false);
  });

  it.each([
    {
      title: "AI + Data Transformation Consultant",
      employer: "Deloitte",
    },
    {
      title: "Enterprise Strategy Consultant Associate",
      employer: "IBM",
      jobDescription:
        "Research client organizations, analyze value chains, and prepare consulting recommendations.",
    },
  ])("locks consulting jobs to one page: $employer", (input) => {
    const policy = resolveDocumentPolicy({
      ...input,
      resumeTargetPagesOverride: 2,
    });

    expect(policy.resumeTargetPages).toBe(1);
    expect(policy.resumePagePolicyMode).toBe("locked");
    expect(policy.resumePagePolicyReason).toBe("consulting");
    expect(policy.allowsManualResumeTargetPages).toBe(false);
  });

  it("keeps non-consulting strategy analyst roles manual", () => {
    const policy = resolveDocumentPolicy({
      title: "Senior Analyst, Enterprise Strategy & Planning",
      employer: "lululemon",
      jobDescription:
        "Support enterprise planning, strategic analysis, executive reporting, and business recommendations.",
      resumeTargetPagesOverride: 1,
    });

    expect(policy.resumeTargetPages).toBe(1);
    expect(policy.resumePagePolicyMode).toBe("manual");
    expect(policy.resumePagePolicyReason).toBe("manual");
  });

  it("lets locked public-sector policy override consulting-like titles", () => {
    const policy = resolveDocumentPolicy({
      title: "Municipal Strategy Consultant",
      employer: "City of Toronto",
      jobDescription: "Consult on city service strategy and public engagement.",
    });

    expect(policy.resumeTargetPages).toBe(2);
    expect(policy.resumePagePolicyReason).toBe("city_public_sector");
  });

  it("lets broad public-sector policy override consulting-like titles", () => {
    const policy = resolveDocumentPolicy({
      title: "Government Relations Consultant",
      employer: "Public Infrastructure Agency",
      jobDescription:
        "Consult on government stakeholder engagement, briefing notes, and public-sector policy partnerships.",
    });

    expect(policy.resumeTargetPages).toBe(2);
    expect(policy.resumePagePolicyReason).toBe("public_sector_government");
  });

  it("standardizes cover letters under the user's fixed format and word limit", () => {
    const policy = resolveDocumentPolicy({
      title: "Research Analyst",
      employer: "City of Toronto",
    });
    const profile = {
      basics: {
        name: "Jane Candidate",
        email: "jane@example.com",
        phone: "416 000 0000",
        location: { city: "Toronto", region: "ON" },
        profiles: [
          {
            network: "LinkedIn",
            url: "https://www.linkedin.com/in/jane-candidate",
          },
        ],
      },
    };
    const instructions = buildCoverLetterPolicyInstructions(policy, profile);

    expect(policy.coverLetter.maxWords).toBe(400);
    expect(policy.coverLetter.targetBodyWords).toBe(330);
    expect(instructions).toContain("To Whom It May Concern:");
    expect(instructions).toContain("Re: [Job Title], [Employer]");
    for (const headerLine of buildCoverLetterHeader(profile)) {
      expect(instructions).toContain(headerLine);
    }
  });

  it("counts visible words and validates the cover-letter limit", () => {
    const policy = resolveDocumentPolicy({ title: "Research Analyst" });
    const text = "Jane Doe\nRe: Research Analyst, City\nSincerely,\nJane Doe";

    expect(countVisibleWords(text)).toBe(9);
    expect(validateCoverLetterWordLimit(text, policy.coverLetter)).toEqual({
      ok: true,
      wordCount: 9,
      maxWords: 400,
    });

    const longText = Array.from({ length: 401 }, () => "word").join(" ");
    expect(validateCoverLetterWordLimit(longText, policy.coverLetter)).toEqual({
      ok: false,
      wordCount: 401,
      maxWords: 400,
    });
  });
});
