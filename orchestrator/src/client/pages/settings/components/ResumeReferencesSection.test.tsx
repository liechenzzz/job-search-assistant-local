import type { ResumeReferenceScanResult } from "@shared/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getResumeReferenceScan: vi.fn(),
  saveResumeReferenceScan: vi.fn(),
}));

vi.mock("@client/api", () => apiMocks);

import {
  buildReferenceChunks,
  buildRepresentatives,
  buildWritingGuide,
  getResumeReferenceIndexNotice,
  limitReferenceChunks,
  saveConfirmedResumeReferenceScan,
} from "./ResumeReferencesSection";

type ReferenceItem = ResumeReferenceScanResult["items"][number];

function item(overrides: Partial<ReferenceItem>): ReferenceItem {
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

function scan(overrides: Partial<ResumeReferenceScanResult>): ResumeReferenceScanResult {
  return {
    scannedAt: "2026-05-20T00:00:00.000Z",
    filesConsidered: 1,
    activeCount: 1,
    resumeCount: 1,
    coverLetterCount: 0,
    combinedCount: 0,
    chunkCount: 1,
    indexedChunkCount: 1,
    indexStatus: "indexed",
    coverage: { data_analytics_operations: 1 },
    items: [item({ inferredRole: "data_analytics_operations" })],
    ...overrides,
  };
}

beforeEach(() => {
  apiMocks.getResumeReferenceScan.mockReset();
  apiMocks.saveResumeReferenceScan.mockReset();
});

describe("buildRepresentatives", () => {
  it("chooses newest resume and cover letter representatives by role family", () => {
    const representatives = buildRepresentatives([
      item({
        fileName: "old-data-resume.docx",
        relativePath: "old-data-resume.docx",
        inferredRole: "data_analytics_operations",
        kind: "resume",
        lastModified: 10,
      }),
      item({
        fileName: "new-data-resume.docx",
        relativePath: "new-data-resume.docx",
        inferredRole: "data_analytics_operations",
        kind: "resume",
        lastModified: 20,
      }),
      item({
        fileName: "new-data-cover.docx",
        relativePath: "new-data-cover.docx",
        inferredRole: "data_analytics_operations",
        kind: "cover",
        lastModified: 30,
      }),
    ]);

    const dataRepresentative = representatives.find(
      (representative) =>
        representative.roleFamily === "data_analytics_operations",
    );

    expect(dataRepresentative?.resume?.fileName).toBe("new-data-resume.docx");
    expect(dataRepresentative?.coverLetter?.fileName).toBe(
      "new-data-cover.docx",
    );
  });

  it("prefers one-page consulting resumes and two-page public-sector resumes", () => {
    const representatives = buildRepresentatives([
      item({
        fileName: "consulting-two-page.docx",
        inferredRole: "consulting_strategy",
        pageCount: 2,
        lastModified: 50,
      }),
      item({
        fileName: "consulting-one-page.docx",
        inferredRole: "consulting_strategy",
        pageCount: 1,
        lastModified: 40,
      }),
      item({
        fileName: "city-one-page.docx",
        inferredRole: "public_sector_policy_economic_development",
        pageCount: 1,
        lastModified: 80,
      }),
      item({
        fileName: "city-two-page.docx",
        inferredRole: "public_sector_policy_economic_development",
        pageCount: 2,
        lastModified: 70,
      }),
    ]);

    expect(
      representatives.find(
        (representative) => representative.roleFamily === "consulting_strategy",
      )?.resume?.fileName,
    ).toBe("consulting-one-page.docx");
    expect(
      representatives.find(
        (representative) =>
          representative.roleFamily ===
          "public_sector_policy_economic_development",
      )?.resume?.fileName,
    ).toBe("city-two-page.docx");
  });

  it("builds a lightweight writing guide from selected representatives", () => {
    const representatives = buildRepresentatives([
      item({
        fileName: "strategy-resume.docx",
        relativePath: "strategy-resume.docx",
        inferredRole: "consulting_strategy",
        kind: "resume",
        pageCount: 1,
        keywords: ["Strategic planning", "Reporting"],
        snippets: {
          experience: "Built concise executive-ready planning bullets.",
        },
      }),
      item({
        fileName: "strategy-cover.docx",
        relativePath: "strategy-cover.docx",
        inferredRole: "consulting_strategy",
        kind: "cover",
        snippets: {
          coverLetter: "Header. To Whom It May Concern. Re: Job ID.",
        },
      }),
    ]);

    const guide = buildWritingGuide(representatives);

    expect(guide.consulting_strategy?.resumeStyle).toContain("strategy");
    expect(guide.consulting_strategy?.bulletStyle).toContain(
      "executive-ready",
    );
    expect(guide.consulting_strategy?.coverLetterStyle).toContain(
      "To Whom It May Concern",
    );
    expect(guide.consulting_strategy?.sourceFiles).toEqual([
      "strategy-resume.docx",
      "strategy-cover.docx",
    ]);
  });
});

describe("buildReferenceChunks", () => {
  it("only changes sections for heading lines, not body keywords", () => {
    const chunks = buildReferenceChunks(
      item({ sections: ["Experience", "Skills", "Education"] }),
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
      item({ sections: ["Experience"] }),
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

  it("splits long resume evidence into bounded searchable chunks", () => {
    const longBullet = Array.from(
      { length: 160 },
      (_, index) => `analysis${index}`,
    ).join(" ");
    const chunks = buildReferenceChunks(
      item({
        fileName: "Data Analyst Resume.docx",
        relativePath: "Data Analyst Resume.docx",
        inferredRole: "data_analytics_operations",
        kind: "resume",
      }),
      `Summary\n${longBullet}\nExperience\n${longBullet}\n${longBullet}`,
    );

    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.length).toBeLessThanOrEqual(180);
    expect(chunks.every((chunk) => chunk.text.length <= 700)).toBe(true);
  });

  it("keeps all 300 resumes and 150 cover letters represented when capped", () => {
    const chunks = Array.from({ length: 45_000 }, (_, index) => {
      const fileIndex = Math.floor(index / 100);
      const isCover = fileIndex >= 300;
      return {
        id: `reference-${fileIndex}-${index}`,
        relativePath: isCover
          ? `Cover Letter ${fileIndex - 300}.docx`
          : `Resume ${fileIndex}.docx`,
        fileName: isCover
          ? `Cover Letter ${fileIndex - 300}.docx`
          : `Resume ${fileIndex}.docx`,
        kind: isCover ? ("cover" as const) : ("resume" as const),
        roleFamily: "data_analytics_operations",
        section: isCover
          ? "Cover Letter"
          : index % 2 === 0
            ? "Experience"
            : "Skills",
        text: `Experience evidence ${index}`,
        keywords: ["Experience"],
      };
    });

    const limited = limitReferenceChunks(chunks);
    const representedFiles = new Set(limited.map((chunk) => chunk.relativePath));

    expect(limited).toHaveLength(18_000);
    expect(representedFiles.size).toBe(450);
    expect(representedFiles.has("Resume 299.docx")).toBe(true);
    expect(representedFiles.has("Cover Letter 149.docx")).toBe(true);
  });
});

describe("saveConfirmedResumeReferenceScan", () => {
  it("surfaces the real API error when saving fails", async () => {
    const next = scan({});
    apiMocks.saveResumeReferenceScan.mockRejectedValue(
      new Error("Payload Too Large"),
    );

    await expect(saveConfirmedResumeReferenceScan(next)).rejects.toThrow(
      "Payload Too Large",
    );
    expect(apiMocks.getResumeReferenceScan).not.toHaveBeenCalled();
  });

  it("fails when the saved scan cannot be read back", async () => {
    const next = scan({});
    apiMocks.saveResumeReferenceScan.mockResolvedValue(next);
    apiMocks.getResumeReferenceScan.mockResolvedValue(null);

    await expect(saveConfirmedResumeReferenceScan(next)).rejects.toThrow(
      "could not read the same index back",
    );
  });

  it("returns readback only when the indexed scan matches the saved scan", async () => {
    const saved = scan({ ragProbe: { checkedAt: "2026-05-20T00:00:01.000Z", hitCount: 1, sampleFiles: ["reference.docx"] } });
    apiMocks.saveResumeReferenceScan.mockResolvedValue(saved);
    apiMocks.getResumeReferenceScan.mockResolvedValue(saved);

    await expect(saveConfirmedResumeReferenceScan(saved)).resolves.toEqual(saved);
  });
});

describe("getResumeReferenceIndexNotice", () => {
  it("warns when the index is unavailable or stale", () => {
    expect(getResumeReferenceIndexNotice(null)?.message).toContain(
      "Reference index unavailable",
    );

    const scannedAt = "2026-05-01T00:00:00.000Z";
    const staleScan: ResumeReferenceScanResult = {
      scannedAt,
      filesConsidered: 1,
      activeCount: 1,
      resumeCount: 1,
      coverLetterCount: 0,
      combinedCount: 0,
      chunkCount: 2,
      indexStatus: "indexed",
      lastIndexedAt: scannedAt,
      coverage: { data_analytics_operations: 1 },
      items: [item({})],
    };

    expect(
      getResumeReferenceIndexNotice(
        staleScan,
        Date.parse("2026-05-20T00:00:00.000Z"),
      )?.message,
    ).toContain("may be stale");
  });

  it("returns no notice when a recent index is searchable", () => {
    const scannedAt = "2026-05-20T00:00:00.000Z";
    expect(
      getResumeReferenceIndexNotice(
        {
          scannedAt,
          filesConsidered: 1,
          activeCount: 1,
          resumeCount: 1,
          coverLetterCount: 0,
          combinedCount: 0,
          chunkCount: 2,
          indexStatus: "indexed",
          lastIndexedAt: scannedAt,
          coverage: { data_analytics_operations: 1 },
          items: [item({})],
        },
        Date.parse("2026-05-21T00:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("distinguishes unsaved local scans from empty reference indexes", () => {
    const scannedAt = "2026-05-20T00:00:00.000Z";
    const notice = getResumeReferenceIndexNotice({
      scannedAt,
      filesConsidered: 1,
      activeCount: 1,
      resumeCount: 1,
      coverLetterCount: 0,
      combinedCount: 0,
      chunkCount: 3,
      indexStatus: "not_indexed",
      coverage: { data_analytics_operations: 1 },
      items: [item({})],
    });

    expect(notice?.message).toContain("scanned locally");
    expect(notice?.message).not.toContain("no searchable chunks");
  });
});
