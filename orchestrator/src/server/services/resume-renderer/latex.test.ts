import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoDomainGateResiduals,
  sanitizeLatexDocumentForDomainGate,
} from "./index";
import {
  buildLatexDocument,
  getLatexTemplatePath,
  getTectonicBinary,
  readLatexTemplate,
  renderLatexPdf,
} from "./latex";
import type { LatexResumeDocument } from "./types";

const baseDocument: LatexResumeDocument = {
  name: "Jane Doe",
  headline: "Senior Software Engineer",
  contactItems: [
    { text: "jane@example.com", url: "mailto:jane@example.com" },
    { text: "Portfolio", url: "https://jane.dev" },
  ],
  summary: "Builds resilient platform systems.",
  experience: [
    {
      title: "Acme",
      subtitle: "Platform Engineer | Remote",
      date: "2023 -- Present",
      bullets: ["Improved API reliability", "Reduced operator toil"],
      url: "https://acme.example.com",
      linkLabel: "Acme",
    },
  ],
  education: [],
  projects: [],
  skillGroups: [
    {
      name: "Backend",
      keywords: ["TypeScript", "Node.js", "PostgreSQL"],
    },
  ],
};

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "job-ops-latex-render-test-"));
}

function tectonicAvailable(): boolean {
  const binary = process.env.TECTONIC_BIN?.trim() || "tectonic";
  const result = spawnSync(binary, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

describe("latex resume renderer", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      }),
    );
  });

  it("exposes the bundled Jake template", async () => {
    expect(getLatexTemplatePath()).toContain("jake-resume.tex");
    const template = await readLatexTemplate();
    expect(template).toContain("Resume in Latex");
    expect(template).toContain("__BODY__");
  });

  it("uses the TECTONIC_BIN override when present", () => {
    const previous = process.env.TECTONIC_BIN;
    process.env.TECTONIC_BIN = "/tmp/custom-tectonic";
    expect(getTectonicBinary()).toBe("/tmp/custom-tectonic");
    if (previous === undefined) {
      delete process.env.TECTONIC_BIN;
    } else {
      process.env.TECTONIC_BIN = previous;
    }
  });

  it("defaults LaTeX section titles to English", () => {
    const latex = buildLatexDocument(
      {
        ...baseDocument,
        sectionTitles: undefined,
      },
      "__NAME__\n__HEADLINE_BLOCK__\n__CONTACT_BLOCK__\n__BODY__",
    );

    expect(latex).toContain("\\section{Summary}");
    expect(latex).toContain("\\section{Experience}");
    expect(latex).toContain("\\section{Technical Skills}");
  });

  it("renders localized LaTeX section titles", () => {
    const latex = buildLatexDocument(
      {
        ...baseDocument,
        education: [
          {
            title: "University",
            subtitle: "MSc",
            date: "2020",
            bullets: ["Studied distributed systems"],
          },
        ],
        projects: [
          {
            title: "Platform",
            subtitle: "TypeScript",
            date: "2024",
            bullets: ["Built deployment tooling"],
          },
        ],
        sectionTitles: {
          summary: "Resumen",
          experience: "Experiencia",
          education: "Educación",
          projects: "Proyectos",
          skills: "Habilidades técnicas",
        },
      },
      "__NAME__\n__HEADLINE_BLOCK__\n__CONTACT_BLOCK__\n__BODY__",
    );

    expect(latex).toContain("\\section{Resumen}");
    expect(latex).toContain("\\section{Experiencia}");
    expect(latex).toContain("\\section{Educación}");
    expect(latex).toContain("\\section{Proyectos}");
    expect(latex).toContain("\\section{Habilidades técnicas}");
  });

  it("can render denser layouts without changing resume text", async () => {
    const template = await readLatexTemplate();
    const latex = buildLatexDocument(baseDocument, template, {
      layout: "one-page-ultra-compact",
    });

    expect(latex).toContain("\\addtolength{\\oddsidemargin}{-0.22in}");
    expect(latex).toContain("\\linespread{0.9}");
    expect(latex).toContain("\\footnotesize");
    expect(latex).toContain("Improved API reliability");
    expect(latex).toContain("Reduced operator toil");
  });

  it("supports a two-page layout density pass", async () => {
    const template = await readLatexTemplate();
    const latex = buildLatexDocument(baseDocument, template, {
      layout: "two-page-compact",
    });

    expect(latex).toContain("\\addtolength{\\oddsidemargin}{-0.1in}");
    expect(latex).toContain("\\linespread{0.97}");
    expect(latex).toContain("Builds resilient platform systems.");
  });

  it("sanitizes blocked domain terms from the final LaTeX document model", () => {
    const profile = {
      roleFamily: "consulting_strategy" as const,
      requiredKeywords: ["strategy"],
      domainKeywordsPresent: [],
      blockedUnlessPresent: ["NOC", "NAICS", "RTRA", "municipal stakeholder"],
      experienceFocus: ["strategy work"],
    };
    const sanitized = sanitizeLatexDocumentForDomainGate(
      {
        ...baseDocument,
        headline: "NOC strategy analyst",
        summary: "Built NAICS planning reports.",
        projects: [
          {
            title: "NOC and NAICS dashboard",
            subtitle: "RTRA",
            bullets: ["Briefed municipal stakeholders."],
          },
        ],
        skillGroups: [
          {
            name: "NOC Analysis",
            keywords: ["NAICS", "RTRA"],
          },
        ],
      },
      profile,
    );

    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toMatch(/\b(?:NOC|NAICS|RTRA|municipal)\b/i);
    expect(serialized).toContain("occupational classification");
    expect(serialized).toContain("industry classification");
    expect(() => assertNoDomainGateResiduals(sanitized, profile)).not.toThrow();
  });

  it("does not fail on blocked terms in preserved factual experience fields", () => {
    const profile = {
      roleFamily: "consulting_strategy" as const,
      requiredKeywords: ["strategy"],
      domainKeywordsPresent: [],
      blockedUnlessPresent: ["economic development"],
      experienceFocus: ["strategy work"],
    };
    const sanitized = sanitizeLatexDocumentForDomainGate(
      {
        ...baseDocument,
        experience: [
          {
            title: "Example Municipality",
            subtitle: "Economic Development Analyst | Mississauga",
            date: "2024",
            bullets: ["Prepared executive-ready planning analysis."],
          },
        ],
        projects: [
          {
            title: "Economic development dashboard",
            subtitle: "Economic development analysis",
            bullets: ["Built economic development reporting outputs."],
          },
        ],
      },
      profile,
    );

    expect(sanitized.experience[0].subtitle).toContain("Economic Development");
    expect(sanitized.projects[0].title).toContain("regional strategy");
    expect(JSON.stringify(sanitized.projects)).not.toMatch(
      /\beconomic development\b/i,
    );
    expect(() => assertNoDomainGateResiduals(sanitized, profile)).not.toThrow();
  });

  it("fails with a helpful error when tectonic is unavailable", async () => {
    const previous = process.env.TECTONIC_BIN;
    process.env.TECTONIC_BIN = "/definitely/missing/tectonic";
    const tempDir = await createTempDir();
    tempDirs.push(tempDir);
    const outputPath = join(tempDir, "resume.pdf");

    await expect(
      renderLatexPdf({
        document: baseDocument,
        outputPath,
        jobId: "job-missing-tectonic",
      }),
    ).rejects.toThrow(/Tectonic binary not found/i);

    if (previous === undefined) {
      delete process.env.TECTONIC_BIN;
    } else {
      process.env.TECTONIC_BIN = previous;
    }
  });

  it.skipIf(!tectonicAvailable())(
    "renders a PDF when tectonic is installed",
    async () => {
      const tempDir = await createTempDir();
      tempDirs.push(tempDir);
      const outputPath = join(tempDir, "resume.pdf");

      await renderLatexPdf({
        document: baseDocument,
        outputPath,
        jobId: "job-render-success",
      });

      const stats = spawnSync("sh", ["-lc", `test -s "${outputPath}"`], {
        stdio: "ignore",
      });
      expect(stats.status).toBe(0);
    },
  );
});
