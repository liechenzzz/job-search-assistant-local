import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  buildDocxDocumentXml,
  buildDocxPackageBuffer,
  buildResumeHtml,
} from "./pdf";

vi.mock("@server/repositories/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("./design-resume", () => ({
  getCurrentDesignResume: vi.fn().mockResolvedValue(null),
  getDesignResumeForTargetPages: vi.fn().mockResolvedValue(null),
}));

vi.mock("./tracer-links", () => ({
  resolveTracerPublicBaseUrl: vi.fn().mockReturnValue("https://jobops.example"),
  rewriteResumeLinksWithTracer: vi
    .fn()
    .mockResolvedValue({ rewrittenLinks: 0 }),
}));

vi.mock("./rxresume/baseResumeId", () => ({
  getConfiguredRxResumeBaseResumeId: vi.fn().mockResolvedValue(null),
}));

vi.mock("./rxresume", () => ({
  importResume: vi.fn(),
  exportResumePdf: vi.fn(),
  deleteResume: vi.fn(),
  getResume: vi.fn(),
  prepareTailoredResumeForPdf: vi.fn(),
}));

function makeResume(overrides: Record<string, unknown> = {}) {
  return {
    basics: {
      name: "Jane Candidate",
      email: "jane@example.com",
      phone: "416 000 0000",
    },
    summary: {
      content:
        "Strategy analyst with experience in research and executive reporting. Skilled in dashboarding and stakeholder synthesis. Comfortable translating analysis into recommendations.",
    },
    sections: {
      experience: {
        items: [
          {
            id: "exp-opus",
            company: "Regional Research Consultancy",
            position: "Associate Consultant",
            period: "2026",
            location: "Toronto",
            description:
              "<ul><li>Built executive reporting materials from verified research evidence.</li><li>Prepared dashboards and recommendations for decision makers.</li></ul>",
          },
          {
            id: "exp-archived",
            company: "Archived Example Studio",
            position: "Research Assistant",
            hidden: true,
            description:
              "<ul><li>Supported archived example content research.</li></ul>",
          },
        ],
      },
      education: {
        items: [
          {
            school: "University of Toronto",
            degree: "Master of Urban Innovation",
            period: "Class of 2025",
          },
        ],
      },
      skills: {
        items: [
          {
            name: "Research Methods",
            keywords: ["Dashboarding", "Stakeholder synthesis"],
          },
          {
            school: "University of Toronto",
            degree: "Bachelor of Arts (BA), City Studies and Media Studies / 3.61/4.00",
            period: "Class of 2023",
            description:
              "<ul><li>Undergraduate training in urban studies, planning, housing, communication, and research methods.</li></ul>",
          },
        ],
      },
    },
    ...overrides,
  };
}

function makeEducationBulletResume() {
  const base = makeResume();
  return {
    ...base,
    sections: {
      ...base.sections,
      education: {
        items: [
          {
            school: "University of Toronto",
            degree: "Master of Urban Innovation, GPA: 3.65/4.00 (High Distinction)",
            period: "Class of 2025",
            description:
              "<ul><li>Graduate training in applied research and policy analysis.</li><li>Graduated with a Cumulative GPA of 3.65/4.00 (High Distinction).</li><li>GPA: 3.65/4.00</li></ul>",
          },
        ],
      },
    },
  };
}

describe("reference-format DOCX renderer", () => {
  it("uses the reference one-page A4 geometry and SUMMARY heading", () => {
    const xml = buildDocxDocumentXml(makeResume(), { targetPages: 1 });

    expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(xml).toContain(
      '<w:pgMar w:top="461" w:right="475" w:bottom="317" w:left="475" w:header="720" w:footer="720"',
    );
    expect(xml).toContain(">SUMMARY<");
    expect(xml).not.toContain("SUMMARY OF QUALIFICATIONS");
  });

  it("uses ATS-safe contact separators without icon glyphs", () => {
    const xml = buildDocxDocumentXml(makeResume(), { targetPages: 1 });

    expect(xml).toContain("jane@example.com | 416 000 0000");
    expect(xml).not.toContain("\u2709");
    expect(xml).not.toContain("\u260E");
  });

  it("uses the reference two-page A4 geometry and qualification summary heading", () => {
    const xml = buildDocxDocumentXml(makeResume(), { targetPages: 2 });

    expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(xml).toContain(
      '<w:pgMar w:top="576" w:right="720" w:bottom="576" w:left="720"',
    );
    expect(xml).toContain("SUMMARY OF QUALIFICATIONS");
  });

  it("writes a hidden DOCX decision marker when a resume decision is provided", () => {
    const xml = buildDocxDocumentXml(makeResume(), {
      resumeDecision: {
        roleFamily: "public_sector_policy_economic_development",
        documentPolicyReason: "city_public_sector",
        targetPages: 2,
        masterVariant: "two_page",
        layoutMode: "reference_2_page",
        referenceRoleFamilies: ["public_sector_policy_economic_development"],
        blockedDomainTerms: [],
        policyLabel: "2-page locked · City / municipal",
        policyReason: "City jobs always use a two-page resume.",
        allowsManualResumeTargetPages: false,
        formatReferences: [
          {
            purpose: "format",
            fileName: "City Resume.docx",
            relativePath: "refs/City Resume.docx",
            roleFamily: "public_sector_policy_economic_development",
          },
        ],
        evidenceReferences: [],
      },
    });

    expect(xml).toContain("<w:vanish/>");
    expect(xml).toContain("policyReason=city_public_sector");
    expect(xml).toContain("masterVariant=two_page");
  });

  it("renders two-page HTML with reference resume structure and marker", () => {
    const html = buildResumeHtml(makeResume(), {
      resumeDecision: {
        roleFamily: "public_sector_policy_economic_development",
        documentPolicyReason: "city_public_sector",
        targetPages: 2,
        masterVariant: "two_page",
        layoutMode: "reference_2_page",
        referenceRoleFamilies: ["public_sector_policy_economic_development"],
        blockedDomainTerms: [],
        policyLabel: "2-page locked · City / municipal",
        policyReason: "City jobs always use a two-page resume.",
        allowsManualResumeTargetPages: false,
        formatReferences: [],
        evidenceReferences: [],
      },
    });

    expect(html).toContain("resume-generation-decision:");
    expect(html).toContain("targetPages=2");
    expect(html).toContain("SUMMARY OF QUALIFICATIONS");
    expect(html).toContain("RESEARCH &amp; TECHNICAL SKILLS");
    expect(html).toContain("@page { size: A4; margin: 0.48in 0.50in; }");
    expect(html).toContain(".target-two { font-size: 10.35pt; line-height: 1.30; }");
    expect(html).not.toContain("<h2>Summary</h2>");
    expect(html).not.toContain("<h2>Projects</h2>");
  });

  it("uses reference-style literal bullets rather than Word numbering", () => {
    const xml = buildDocxDocumentXml(makeResume(), { targetPages: 2 });

    expect(xml).toContain("\u2022  Built executive reporting materials");
    expect(xml).not.toContain("<w:numPr>");
    expect(xml).toContain('<w:ind w:left="504" w:hanging="245"/>');
    expect(xml).toContain("<w:keepLines/>");
  });

  it("renders education details as bullets and removes duplicate GPA facts", () => {
    const resume = makeEducationBulletResume();
    const xml = buildDocxDocumentXml(resume, { targetPages: 2 });
    const html = buildResumeHtml(resume, { targetPages: 2 });

    expect(xml).toContain(
      "\u2022  Graduate training in applied research and policy analysis.",
    );
    expect(xml).toContain("\u2022  Graduated with High Distinction.");
    expect(xml).not.toContain("GPA");
    expect(xml).not.toContain("3.65/4.00");
    expect(xml).not.toContain("3.61/4.00");
    expect(xml.match(/High Distinction/g)?.length ?? 0).toBe(1);
    expect(html).toContain(
      "<li>Graduate training in applied research and policy analysis.</li>",
    );
    expect(html).toContain("<li>Graduated with High Distinction.</li>");
    expect(html).not.toContain("GPA");
    expect(html).not.toContain("3.65/4.00");
    expect(html).not.toContain("3.61/4.00");
    expect(html.match(/High Distinction/g)?.length ?? 0).toBe(1);
  });

  it("renders strict ATS experience headings with right tab stops before bullets", () => {
    const xml = buildDocxDocumentXml(makeResume(), { targetPages: 2 });

    expect(xml).toContain("Built executive reporting materials");
    expect(xml).toContain("Prepared dashboards and recommendations");
    expect(xml).not.toContain("<w:tbl>");
    expect(xml).toContain("<w:tab/>");
    expect(xml).toContain('<w:tab w:val="right" w:pos="10286"/>');
    expect(xml).toContain("Regional Research Consultancy");
    expect(xml).toContain("Associate Consultant");
    expect(xml).toContain(">2026<");
    expect(xml).not.toContain(">Projects<");
  });

  it("keeps right-side experience dates and locations inset from the page edge", () => {
    const html = buildResumeHtml(makeResume(), { targetPages: 2 });

    expect(html).toContain(
      ".entry-heading { display: flex; justify-content: space-between; gap: 16px; break-after: avoid; padding-right: 0.08in; }",
    );
    expect(html).toContain(
      ".entry-meta { display: flex; justify-content: space-between; gap: 16px; font-weight: 700; margin-top: 1px; break-after: avoid; padding-right: 0.08in; }",
    );
  });

  it("can still render master visual table headings when explicitly requested", () => {
    const xml = buildDocxDocumentXml(makeResume(), {
      targetPages: 2,
      outputMode: "master_visual_table",
    });

    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("Regional Research Consultancy");
    expect(xml).toContain('<w:jc w:val="right"/>');
  });

  it("keeps hidden experience out of Word output", () => {
    const xml = buildDocxDocumentXml(makeResume(), { targetPages: 2 });

    expect(xml).not.toContain("Archived Example Studio");
  });

  it("can render an explicitly visible experience item", () => {
    const resume = makeResume({
      sections: {
        experience: {
          items: [
            {
              id: "exp-example",
              company: "Example Studio",
              position: "Research Assistant",
              hidden: false,
              description:
                "<ul><li>Supported example content research.</li></ul>",
            },
          ],
        },
      },
    });

    const xml = buildDocxDocumentXml(resume, { targetPages: 2 });

    expect(xml).toContain("Supported example content research");
  });

  it("builds DOCX from the reference template package instead of a minimal package", async () => {
    const buffer = await buildDocxPackageBuffer(makeResume(), {
      targetPages: 2,
    });
    const zip = await JSZip.loadAsync(buffer);
    const parts = Object.keys(zip.files);
    const xml = await zip.file("word/document.xml")?.async("string");

    expect(parts).toContain("word/settings.xml");
    expect(parts).toContain("word/theme/theme1.xml");
    expect(parts).toContain("word/fontTable.xml");
    expect(parts).toContain("docProps/core.xml");
    expect(xml).not.toContain("<w:tbl>");
    expect(xml).toContain("<w:tab/>");
    expect(xml).toContain("Regional Research Consultancy");
    expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"');
  });

  it("inserts a page break before an experience block that would split across pages", () => {
    const longBullet =
      "Analyzed program evidence, labour-market research, operational constraints, stakeholder findings, implementation risks, reporting requirements, and executive decision needs to prepare briefing-ready recommendations for leadership teams.";
    const resume = makeResume({
      summary: {
        content:
          "Strategy analyst with experience in research and executive reporting. Skilled in dashboarding and stakeholder synthesis. Comfortable translating analysis into recommendations.",
      },
      sections: {
        experience: {
          items: [
            {
              company: "Regional Research Consultancy",
              position: "Associate Consultant",
              period: "2026",
              location: "Toronto",
              description: `<ul>${Array.from({ length: 18 }, () => `<li>${longBullet}</li>`).join("")}</ul>`,
            },
            {
              company: "City of Mississauga",
              position: "Strategic Research Consultant",
              period: "2024 - 2025",
              location: "Mississauga",
              description: `<ul>${Array.from({ length: 8 }, () => `<li>${longBullet}</li>`).join("")}</ul>`,
            },
          ],
        },
      },
    });
    const xml = buildDocxDocumentXml(resume, { targetPages: 2 });
    const pageBreakIndex = xml.indexOf('<w:br w:type="page"/>');
    const secondExperienceIndex = xml.indexOf("City of Mississauga");

    expect(pageBreakIndex).toBeGreaterThan(-1);
    expect(pageBreakIndex).toBeLessThan(secondExperienceIndex);
  });
});
