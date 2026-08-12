import { writeFile } from "node:fs/promises";
import type { ResumeReferenceScanItem } from "@shared/types.js";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  buildReferenceChunks,
  ingestResumeReferenceFiles,
} from "./resume-reference-ingestion";

function referenceItem(
  overrides: Partial<ResumeReferenceScanItem> = {},
): ResumeReferenceScanItem {
  return {
    fileName: "reference.docx",
    relativePath: "reference.docx",
    inferredRole: "general",
    kind: "resume",
    sections: ["Summary", "Experience"],
    hasSkills: true,
    pageCount: null,
    lastModified: 1,
    size: 100,
    snippets: {},
    ...overrides,
  };
}

async function docxBase64(text: string): Promise<string> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<w:document><w:body>${text
      .split("\n")
      .map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`)
      .join("")}</w:body></w:document>`,
  );
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return buffer.toString("base64");
}

describe("buildReferenceChunks", () => {
  it("only changes sections for heading lines, not body keywords", () => {
    const chunks = buildReferenceChunks(
      referenceItem({ sections: ["Experience", "Skills", "Education"] }),
      `Professional Experience
Conducted education-focused workforce research and project analysis for regional planning teams, translating policy evidence into decision-ready recommendations.
Skills
Project management, market research, Python, SQL, Power BI, stakeholder engagement, reporting, and dashboard quality assurance.
Education
University of Waterloo, Master of Public Policy with academic research training.`,
    );

    const experienceChunk = chunks.find((chunk) =>
      chunk.text.includes("education-focused workforce research"),
    );
    const skillsChunk = chunks.find((chunk) =>
      chunk.text.includes("Project management"),
    );
    const educationChunk = chunks.find((chunk) =>
      chunk.text.includes("Master of Public Policy"),
    );

    expect(experienceChunk?.section).toBe("Experience");
    expect(skillsChunk?.section).toBe("Skills");
    expect(educationChunk?.section).toBe("Education");
  });

  it("keeps pre-heading content in General", () => {
    const chunks = buildReferenceChunks(
      referenceItem({ sections: ["Experience"] }),
      `Candidate evidence note summarizing research, analytics, and stakeholder-facing delivery across several roles.
Professional Experience
Delivered market research, reporting, and business analysis for senior stakeholders using Python and Excel.`,
    );

    expect(
      chunks.find((chunk) => chunk.text.includes("Candidate evidence note"))
        ?.section,
    ).toBe("General");
    expect(
      chunks.find((chunk) => chunk.text.includes("Delivered market research"))
        ?.section,
    ).toBe("Experience");
  });
});

describe("ingestResumeReferenceFiles", () => {
  it("builds a server-side evidence scan with chunks and diagnostics", async () => {
    const content = await docxBase64(`Summary
Data analytics professional with dashboard, SQL, Python, and reporting experience across operations teams.
Experience
Built Power BI dashboards and SQL reporting workflows that improved weekly quality assurance and stakeholder decision support.
Created Excel QA checks, cleaned operational data, and documented reporting logic for cross-functional partners.
Skills
SQL, Python, Power BI, Excel, Tableau, Quality assurance`);

    const scan = await ingestResumeReferenceFiles({
      files: [
        {
          fileName: "Data Analyst Resume.docx",
          relativePath: "Applications/Data Analyst Resume.docx",
          contentBase64: content,
          lastModified: 100,
          size: 10_000,
        },
        {
          fileName: "notes.txt",
          relativePath: "Applications/notes.txt",
          contentBase64: Buffer.from("ignore me").toString("base64"),
        },
      ],
    });

    expect(scan.activeCount).toBe(1);
    expect(scan.resumeCount).toBe(1);
    expect(scan.chunkCount).toBeGreaterThan(0);
    expect(scan.items[0].inferredRole).toBe("data_analytics_operations");
    expect(scan.chunks?.[0].clusterId).toBeTruthy();
    expect(scan.ingestionDiagnostics).toMatchObject({
      totalFiles: 2,
      parsedFiles: 1,
      parser: "server",
    });
    expect(scan.ingestionDiagnostics?.skippedFiles).toHaveLength(1);
    expect(scan.ingestionDiagnostics?.clusterCount).toBeGreaterThan(0);
  });

  it("flags PDFs with no embedded text as empty text files", async () => {
    const scan = await ingestResumeReferenceFiles({
      files: [
        {
          fileName: "Scanned Resume.pdf",
          relativePath: "Scanned Resume.pdf",
          contentBase64: Buffer.from("%PDF-1.4\n/Type /Page\nstream\nendstream").toString(
            "base64",
          ),
          lastModified: 100,
          size: 100,
        },
      ],
    });

    expect(scan.activeCount).toBe(0);
    expect(scan.chunkCount).toBe(0);
    expect(scan.ingestionDiagnostics?.emptyTextFiles[0]).toMatchObject({
      fileName: "Scanned Resume.pdf",
    });
  });

  it("uses Poppler text extraction when PDF embedded text is sufficient", async () => {
    const commands: string[] = [];
    const popplerText = `Summary
Data analytics professional with SQL, Power BI, Python, Tableau, reporting, quality assurance, and dashboard delivery experience.
Experience
Built executive Power BI dashboards and SQL reporting workflows that improved operating visibility for stakeholders.
Skills
SQL Python Power BI Tableau Excel reporting dashboard analytics`.repeat(2);

    const scan = await ingestResumeReferenceFiles(
      {
        files: [
          {
            fileName: "Analytics Resume.pdf",
            relativePath: "Analytics Resume.pdf",
            contentBase64: Buffer.from("%PDF-1.4\n/Type /Page\n").toString("base64"),
            lastModified: 100,
            size: 100,
          },
        ],
      },
      [],
      {
        runCommand: async (command) => {
          commands.push(command);
          if (command === "pdftotext") return { stdout: popplerText, stderr: "" };
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    );

    expect(scan.activeCount).toBe(1);
    expect(scan.ingestionDiagnostics?.extractorCounts).toMatchObject({
      poppler_text: 1,
    });
    expect(scan.ingestionDiagnostics?.ocrFileCount).toBe(0);
    expect(commands).toEqual(["pdftotext"]);
  });

  it("runs Tesseract OCR when Poppler text is too short", async () => {
    const commands: string[] = [];
    const ocrText = `Summary
Policy and data analyst with stakeholder engagement, research, reporting, briefing notes, and dashboard experience.
Experience
Led research synthesis, Excel quality assurance, and stakeholder reporting workflows for public sector planning decisions.
Skills
Research Excel Power BI stakeholder engagement policy analysis reporting`.repeat(2);

    const scan = await ingestResumeReferenceFiles(
      {
        files: [
          {
            fileName: "Policy Resume.pdf",
            relativePath: "Policy Resume.pdf",
            contentBase64: Buffer.from(
              "%PDF-1.4\n/Type /Page\n/Type /Page\nstream\nendstream",
            ).toString("base64"),
            lastModified: 100,
            size: 100,
          },
        ],
      },
      [],
      {
        runCommand: async (command, args) => {
          commands.push(command);
          if (command === "pdftotext") return { stdout: "short", stderr: "" };
          if (command === "pdftoppm") {
            const prefix = args[args.length - 1];
            await writeFile(`${prefix}-1.png`, "fake image");
            return { stdout: "", stderr: "" };
          }
          if (command === "tesseract") return { stdout: ocrText, stderr: "" };
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    );

    expect(scan.activeCount).toBe(1);
    expect(scan.ingestionDiagnostics?.extractorCounts).toMatchObject({
      tesseract_ocr: 1,
    });
    expect(scan.ingestionDiagnostics?.ocrFileCount).toBe(1);
    expect(scan.ingestionDiagnostics?.partialOcrFileCount).toBe(0);
    expect(commands).toEqual(["pdftotext", "pdftoppm", "tesseract"]);
  });

  it("records missing local PDF tools and falls back without crashing", async () => {
    const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const scan = await ingestResumeReferenceFiles(
      {
        files: [
          {
            fileName: "Scanned Resume.pdf",
            relativePath: "Scanned Resume.pdf",
            contentBase64: Buffer.from("%PDF-1.4\n/Type /Page\nstream\nendstream").toString(
              "base64",
            ),
            lastModified: 100,
            size: 100,
          },
        ],
      },
      [],
      {
        runCommand: async () => {
          throw missing;
        },
      },
    );

    expect(scan.activeCount).toBe(0);
    expect(scan.ingestionDiagnostics?.missingDependencies).toEqual([
      "pdftoppm",
      "pdftotext",
    ]);
    expect(scan.ingestionDiagnostics?.fileDiagnostics?.[0]).toMatchObject({
      extractor: "lightweight_pdf_fallback",
      ocrUsed: false,
      missingDependencies: ["pdftoppm", "pdftotext"],
    });
  });

  it("marks OCR as partial when the PDF exceeds the OCR page limit", async () => {
    const scan = await ingestResumeReferenceFiles(
      {
        files: [
          {
            fileName: "Long Resume.pdf",
            relativePath: "Long Resume.pdf",
            contentBase64: Buffer.from(
              "%PDF-1.4\n/Type /Page\n/Type /Page\n/Type /Page\nstream\nendstream",
            ).toString("base64"),
            lastModified: 100,
            size: 100,
          },
        ],
      },
      [],
      {
        ocrPageLimit: 2,
        runCommand: async (command, args) => {
          if (command === "pdftotext") return { stdout: "", stderr: "" };
          if (command === "pdftoppm") {
            const prefix = args[args.length - 1];
            await writeFile(`${prefix}-1.png`, "fake image");
            return { stdout: "", stderr: "" };
          }
          if (command === "tesseract") {
            return {
              stdout:
                "Created SQL dashboards, policy reports, stakeholder research, quality assurance workflows, and Power BI executive reporting. ".repeat(
                  4,
                ),
              stderr: "",
            };
          }
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    );

    expect(scan.ingestionDiagnostics?.partialOcrFileCount).toBe(1);
    expect(scan.ingestionDiagnostics?.fileDiagnostics?.[0]).toMatchObject({
      extractor: "tesseract_ocr",
      partialOcr: true,
      ocrPageLimit: 2,
    });
  });
});
