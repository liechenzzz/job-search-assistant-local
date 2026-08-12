import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sqliteState = vi.hoisted(() => ({
  meta: new Map<string, Record<string, unknown>>(),
  fts: new Map<string, Record<string, unknown>>(),
  countOverride: null as number | null,
}));

vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    pragma() {
      return undefined;
    }

    exec(sql: string) {
      if (/DELETE FROM reference_chunks_meta/i.test(sql)) {
        sqliteState.meta.clear();
        sqliteState.fts.clear();
      }
    }

    prepare(sql: string) {
      if (/INSERT INTO reference_chunks_meta/i.test(sql)) {
        return {
          run: (row: Record<string, unknown>) => {
            sqliteState.meta.set(String(row.id), row);
          },
        };
      }
      if (/INSERT INTO reference_chunks_fts/i.test(sql)) {
        return {
          run: (row: Record<string, unknown>) => {
            sqliteState.fts.set(String(row.id), row);
          },
        };
      }
      if (/SELECT count\(\*\) AS count FROM reference_chunks_fts/i.test(sql)) {
        return {
          get: () => ({
            count: sqliteState.countOverride ?? sqliteState.fts.size,
          }),
        };
      }
      if (/SELECT count\(\*\) AS count FROM reference_chunks_meta/i.test(sql)) {
        return {
          get: () => ({
            count: sqliteState.countOverride ?? sqliteState.meta.size,
          }),
        };
      }
      return {
        all: (query?: string) => {
          const tokens = Array.from(String(query ?? "").matchAll(/"([^"]+)"/g))
            .map((match) => match[1]?.toLowerCase() ?? "")
            .filter(Boolean);
          return [...sqliteState.fts.values()]
            .filter((row) => {
              if (tokens.length === 0) return true;
              const haystack = [
                row.text,
                row.keywords,
                row.fileName,
                row.roleFamily,
                row.section,
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              return tokens.some((token) => haystack.includes(token));
            })
            .map((row) => {
              const meta = sqliteState.meta.get(String(row.id)) ?? {};
              return {
                ...row,
                relativePath: meta.relativePath,
                fileName: meta.fileName,
                kind: meta.kind,
                roleFamily: meta.roleFamily,
                section: meta.section,
                experienceAnchorId: meta.experienceAnchorId,
                claimType: meta.claimType,
                anchorSection: meta.anchorSection,
                sourceQuality: meta.sourceQuality,
                lastModified: meta.lastModified,
                size: meta.size,
              };
            });
        },
      };
    }

    transaction(fn: (items: unknown[]) => void) {
      return (items: unknown[]) => fn(items);
    }

    close() {
      return undefined;
    }
  },
}));

describe("resume reference RAG index", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    sqliteState.meta.clear();
    sqliteState.fts.clear();
    sqliteState.countOverride = null;
    vi.resetModules();
  });

  it("indexes chunks and retrieves qualification evidence", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-reference-rag-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    const { findReferenceChunksForQualifications, saveResumeReferenceScan } =
      await import("./resume-references");

    const saved = await saveResumeReferenceScan({
      scannedAt: new Date().toISOString(),
      filesConsidered: 1,
      activeCount: 1,
      resumeCount: 1,
      coverLetterCount: 0,
      combinedCount: 0,
      coverage: { data_analytics_operations: 1 },
      items: [
        {
          fileName: "Data Analyst Resume.docx",
          relativePath: "refs/Data Analyst Resume.docx",
          inferredRole: "data_analytics_operations",
          kind: "resume",
          sections: ["Experience", "Skills"],
          hasSkills: true,
          pageCount: 1,
          lastModified: 10,
          size: 100,
          keywords: ["Dashboard", "Reporting", "Quality assurance"],
          snippets: {
            experience: "Built dashboard reporting and QA checks.",
          },
        },
      ],
      chunks: [
        {
          id: "refs/Data Analyst Resume.docx#experience-0",
          relativePath: "refs/Data Analyst Resume.docx",
          fileName: "Data Analyst Resume.docx",
          kind: "resume",
          roleFamily: "data_analytics_operations",
          section: "Experience",
          text: "Built recurring dashboard reporting and quality assurance checks for operational decision support.",
          keywords: ["Dashboard", "Reporting", "Quality assurance"],
          lastModified: 10,
          size: 100,
        },
      ],
    });

    const hits = await findReferenceChunksForQualifications({
      qualificationProfile: {
        required: [
          "Experience with dashboard reporting and quality assurance.",
        ],
        preferred: [],
        keywords: ["Dashboard", "Reporting", "Quality assurance"],
        confidence: "high",
      },
      keywordProfile: {
        roleFamily: "data_analytics_operations",
        requiredKeywords: ["dashboard", "reporting"],
        domainKeywordsPresent: [],
        blockedUnlessPresent: [],
        experienceFocus: ["quality assurance"],
      },
    });

    expect(saved.indexStatus).toBe("indexed");
    expect(saved.chunkCount).toBe(1);
    expect(saved.indexedChunkCount).toBe(1);
    expect(saved.experienceAnchors).toHaveLength(1);
    expect(saved.anchorDiagnostics?.anchorCount).toBe(1);
    expect(saved.ragProbe?.hitCount).toBeGreaterThan(0);
    expect(hits[0]?.chunks[0]?.fileName).toBe("Data Analyst Resume.docx");
    expect(hits[0]?.chunks[0]?.text).toContain("dashboard reporting");
    expect(hits[0]?.chunks[0]?.experienceAnchorId).toMatch(/^anchor:/);
    expect(hits[0]?.chunks[0]?.claimType).toBeTruthy();
    expect(hits[0]?.chunks[0]?.clusterId).toMatch(/^cluster:/);
    expect(hits[0]?.chunks[0]?.evidenceGroupId).toMatch(/^exp_anchor:anchor:/);
    expect(hits[0]?.chunks[0]?.evidenceGroupLabel).toBe(
      "Data Analyst Resume.docx > data_analytics_operations > Experience",
    );
    expect(hits[0]?.chunks[0]?.qualitySignals?.confidence).toBe("high");
  });

  it("dedupes repeated experience clusters across uploaded resumes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-reference-rag-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    const {
      buildSelectedResumeEvidence,
      findReferenceChunksForQualifications,
      saveResumeReferenceScan,
    } = await import("./resume-references");

    const sharedText =
      "Built recurring dashboard reporting and quality assurance checks for operational decision support.";
    await saveResumeReferenceScan({
      scannedAt: new Date().toISOString(),
      filesConsidered: 2,
      activeCount: 2,
      resumeCount: 2,
      coverLetterCount: 0,
      combinedCount: 0,
      coverage: { data_analytics_operations: 2 },
      items: ["A", "B"].map((suffix) => ({
        fileName: `Resume ${suffix}.docx`,
        relativePath: `refs/Resume ${suffix}.docx`,
        inferredRole: "data_analytics_operations",
        kind: "resume" as const,
        sections: ["Experience"],
        hasSkills: false,
        pageCount: 1,
      })),
      chunks: ["A", "B"].map((suffix) => ({
        id: `refs/Resume ${suffix}.docx#experience-0`,
        relativePath: `refs/Resume ${suffix}.docx`,
        fileName: `Resume ${suffix}.docx`,
        kind: "resume" as const,
        roleFamily: "data_analytics_operations",
        section: "Experience",
        text: sharedText,
        keywords: ["Dashboard", "Reporting", "Quality assurance"],
      })),
    });

    const qualificationProfile = {
      required: ["Experience with dashboard reporting and quality assurance."],
      preferred: [],
      keywords: ["Dashboard", "Reporting", "Quality assurance"],
      confidence: "high" as const,
    };
    const hits = await findReferenceChunksForQualifications({
      qualificationProfile,
      keywordProfile: {
        roleFamily: "data_analytics_operations",
        requiredKeywords: ["dashboard", "reporting"],
        domainKeywordsPresent: [],
        blockedUnlessPresent: [],
        experienceFocus: ["quality assurance"],
      },
      maxChunksPerQualification: 6,
    });
    const selectedEvidence = buildSelectedResumeEvidence({
      qualificationProfile,
      knowledgeHits: hits,
      maxChunksPerRequirement: 6,
    });

    expect(hits[0]?.chunks).toHaveLength(1);
    expect(selectedEvidence[0]?.chunks).toHaveLength(1);
    expect(selectedEvidence[0]?.chunks[0]?.clusterId).toMatch(/^cluster:/);
    expect(selectedEvidence[0]?.chunks[0]?.evidenceGroupId).toMatch(
      /^exp_anchor:anchor:/,
    );
  });

  it("adds stable fallback evidence groups for unanchored chunks", async () => {
    vi.resetModules();
    const { buildSelectedResumeEvidence } = await import("./resume-references");
    const qualificationProfile = {
      required: ["Experience with dashboard reporting."],
      preferred: [],
      keywords: ["dashboard", "reporting"],
      confidence: "high" as const,
    };

    const selectedEvidence = buildSelectedResumeEvidence({
      qualificationProfile,
      knowledgeHits: [
        {
          qualification: "Experience with dashboard reporting.",
          chunks: [
            {
              id: "chunk-experience-1",
              relativePath: "refs/Data Analyst Resume.docx",
              fileName: "Data Analyst Resume.docx",
              kind: "resume" as const,
              roleFamily: "data_analytics_operations",
              section: "Experience",
              text: "Built dashboard reporting.",
              keywords: ["dashboard", "reporting"],
            },
            {
              id: "chunk-experience-2",
              relativePath: "refs/Data Analyst Resume.docx",
              fileName: "Data Analyst Resume.docx",
              kind: "resume" as const,
              roleFamily: "data_analytics_operations",
              section: "Experience",
              text: "Maintained reporting quality checks.",
              keywords: ["reporting", "quality"],
            },
            {
              id: "chunk-skills-1",
              relativePath: "refs/Data Analyst Skills.docx",
              fileName: "Data Analyst Skills.docx",
              kind: "resume" as const,
              roleFamily: "data_analytics_operations",
              section: "Skills",
              text: "Power BI, Excel, SQL.",
              keywords: ["Power BI", "Excel", "SQL"],
            },
          ],
        },
      ],
      maxChunksPerRequirement: 3,
    });

    const chunks = selectedEvidence[0]?.chunks ?? [];
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.evidenceGroupId).toMatch(/^evidence_group:/);
    expect(chunks[0]?.evidenceGroupId).toBe(chunks[1]?.evidenceGroupId);
    expect(chunks[2]?.evidenceGroupId).toMatch(/^evidence_group:/);
    expect(chunks[2]?.evidenceGroupId).not.toBe(chunks[0]?.evidenceGroupId);
    expect(chunks[0]?.evidenceGroupLabel).toBe(
      "Data Analyst Resume.docx > data_analytics_operations > Experience",
    );
    expect(chunks[2]?.evidenceGroupLabel).toBe(
      "Data Analyst Skills.docx > data_analytics_operations > Skills",
    );
  });

  it("marks the scan failed when indexed row verification does not match", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-reference-rag-"));
    process.env.DATA_DIR = tempDir;
    sqliteState.countOverride = 0;
    vi.resetModules();
    const { saveResumeReferenceScan } = await import("./resume-references");

    const saved = await saveResumeReferenceScan({
      scannedAt: new Date().toISOString(),
      filesConsidered: 1,
      activeCount: 1,
      resumeCount: 1,
      coverLetterCount: 0,
      combinedCount: 0,
      coverage: { data_analytics_operations: 1 },
      items: [
        {
          fileName: "Data Analyst Resume.docx",
          relativePath: "refs/Data Analyst Resume.docx",
          inferredRole: "data_analytics_operations",
          kind: "resume",
          sections: ["Experience"],
          hasSkills: false,
          pageCount: 1,
          lastModified: 10,
          size: 100,
        },
      ],
      chunks: [
        {
          id: "refs/Data Analyst Resume.docx#experience-0",
          relativePath: "refs/Data Analyst Resume.docx",
          fileName: "Data Analyst Resume.docx",
          kind: "resume",
          roleFamily: "data_analytics_operations",
          section: "Experience",
          text: "Built dashboard reporting.",
          keywords: ["Dashboard", "Reporting"],
          lastModified: 10,
          size: 100,
        },
      ],
    });

    expect(saved.indexStatus).toBe("failed");
    expect(saved.indexedChunkCount).toBe(0);
    expect(saved.lastIndexError).toContain("row count mismatch");
    expect(sqliteState.fts.size).toBe(0);
  });

  it("falls back to JD keyword evidence when exact qualification wording misses", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-reference-rag-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    const { findReferenceChunksForQualifications, saveResumeReferenceScan } =
      await import("./resume-references");

    await saveResumeReferenceScan({
      scannedAt: new Date().toISOString(),
      filesConsidered: 1,
      activeCount: 1,
      resumeCount: 1,
      coverLetterCount: 0,
      combinedCount: 0,
      coverage: { market_insights_research: 1 },
      items: [
        {
          fileName: "Insights Resume.docx",
          relativePath: "refs/Insights Resume.docx",
          inferredRole: "market_insights_research",
          kind: "resume",
          sections: ["Experience"],
          hasSkills: false,
          pageCount: 1,
          lastModified: 10,
          size: 100,
        },
      ],
      chunks: [
        {
          id: "refs/Insights Resume.docx#experience-0",
          relativePath: "refs/Insights Resume.docx",
          fileName: "Insights Resume.docx",
          kind: "resume",
          roleFamily: "market_insights_research",
          section: "Experience",
          text: "Delivered survey analysis and market research synthesis for product teams.",
          keywords: ["Survey analysis", "Market research"],
          lastModified: 10,
          size: 100,
        },
      ],
    });

    const hits = await findReferenceChunksForQualifications({
      qualificationProfile: {
        required: [
          "Experience translating customer ambiguity into recommendations.",
        ],
        preferred: [],
        keywords: [],
        confidence: "high",
      },
      keywordProfile: {
        roleFamily: "market_insights_research",
        requiredKeywords: ["market research"],
        domainKeywordsPresent: [],
        blockedUnlessPresent: [],
        experienceFocus: ["survey analysis"],
      },
    });

    expect(hits[0]?.chunks[0]?.fileName).toBe("Insights Resume.docx");
    expect(hits[0]?.chunks[0]?.text).toContain("survey analysis");
  });

  it("accepts scans with 300 resumes and 150 cover letters", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-reference-rag-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    const { saveResumeReferenceScan } = await import("./resume-references");
    const items = Array.from({ length: 450 }, (_, index) => {
      const isCover = index >= 300;
      return {
        fileName: isCover
          ? `Cover Letter ${index - 300}.docx`
          : `Resume ${index}.docx`,
        relativePath: isCover
          ? `refs/Cover Letter ${index - 300}.docx`
          : `refs/Resume ${index}.docx`,
        inferredRole: "data_analytics_operations",
        kind: isCover ? ("cover" as const) : ("resume" as const),
        sections: isCover ? ["Cover Letter"] : ["Experience", "Skills"],
        hasSkills: !isCover,
        pageCount: isCover ? 1 : 2,
        lastModified: index + 1,
        size: 100 + index,
        keywords: isCover ? ["Cover Letter"] : ["Experience"],
        snippets: isCover
          ? { coverLetter: "Concise cover letter evidence." }
          : { experience: "Resume experience evidence." },
      };
    });

    const saved = await saveResumeReferenceScan({
      scannedAt: new Date().toISOString(),
      filesConsidered: 450,
      activeCount: 450,
      resumeCount: 300,
      coverLetterCount: 150,
      combinedCount: 0,
      coverage: { data_analytics_operations: 450 },
      items,
      chunks: [],
    });

    expect(saved.activeCount).toBe(450);
    expect(saved.items).toHaveLength(450);
    expect(saved.resumeCount).toBe(300);
    expect(saved.coverLetterCount).toBe(150);
  });

  it("treats each scan as a full snapshot and clears searchable chunks when the folder has no evidence", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-reference-rag-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    const { findReferenceChunksForQualifications, saveResumeReferenceScan } =
      await import("./resume-references");

    await saveResumeReferenceScan({
      scannedAt: new Date().toISOString(),
      filesConsidered: 1,
      activeCount: 1,
      resumeCount: 1,
      coverLetterCount: 0,
      combinedCount: 0,
      coverage: { data_analytics_operations: 1 },
      items: [
        {
          fileName: "Data Analyst Resume.docx",
          relativePath: "refs/Data Analyst Resume.docx",
          inferredRole: "data_analytics_operations",
          kind: "resume",
          sections: ["Experience"],
          hasSkills: false,
          pageCount: 1,
          lastModified: 10,
          size: 100,
        },
      ],
      chunks: [
        {
          id: "refs/Data Analyst Resume.docx#experience-0",
          relativePath: "refs/Data Analyst Resume.docx",
          fileName: "Data Analyst Resume.docx",
          kind: "resume",
          roleFamily: "data_analytics_operations",
          section: "Experience",
          text: "Built dashboard reporting.",
          keywords: ["Dashboard", "Reporting"],
          lastModified: 10,
          size: 100,
        },
      ],
    });

    const emptyScan = await saveResumeReferenceScan({
      scannedAt: new Date().toISOString(),
      filesConsidered: 0,
      activeCount: 0,
      resumeCount: 0,
      coverLetterCount: 0,
      combinedCount: 0,
      coverage: {},
      items: [],
      chunks: [],
    });

    const hits = await findReferenceChunksForQualifications({
      qualificationProfile: {
        required: ["Experience with dashboard reporting."],
        preferred: [],
        keywords: ["Dashboard", "Reporting"],
        confidence: "high",
      },
      keywordProfile: {
        roleFamily: "data_analytics_operations",
        requiredKeywords: ["dashboard"],
        domainKeywordsPresent: [],
        blockedUnlessPresent: [],
        experienceFocus: ["reporting"],
      },
    });

    expect(emptyScan.indexStatus).toBe("not_indexed");
    expect(emptyScan.chunkCount).toBe(0);
    expect(sqliteState.fts.size).toBe(0);
    expect(hits).toEqual([]);
  });

  it("selects same-page format references separately from RAG evidence", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-reference-rag-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    const {
      saveResumeReferenceScan,
      selectFormatReferenceSummaries,
      summarizeEvidenceReferenceHits,
    } = await import("./resume-references");

    await saveResumeReferenceScan({
      scannedAt: new Date().toISOString(),
      filesConsidered: 2,
      activeCount: 2,
      resumeCount: 2,
      coverLetterCount: 0,
      combinedCount: 0,
      coverage: { public_sector_policy_economic_development: 1 },
      items: [
        {
          fileName: "City Two Page Resume.docx",
          relativePath: "refs/City Two Page Resume.docx",
          inferredRole: "public_sector_policy_economic_development",
          kind: "resume",
          sections: ["Summary", "Experience", "Skills"],
          hasSkills: true,
          pageCount: 2,
          lastModified: 20,
          size: 200,
        },
        {
          fileName: "Consulting One Page Resume.docx",
          relativePath: "refs/Consulting One Page Resume.docx",
          inferredRole: "consulting_strategy",
          kind: "resume",
          sections: ["Summary", "Experience"],
          hasSkills: true,
          pageCount: 1,
          lastModified: 30,
          size: 180,
        },
      ],
      representatives: [
        {
          roleFamily: "public_sector_policy_economic_development",
          resume: {
            fileName: "City Two Page Resume.docx",
            relativePath: "refs/City Two Page Resume.docx",
            inferredRole: "public_sector_policy_economic_development",
            kind: "resume",
            sections: ["Summary", "Experience", "Skills"],
            hasSkills: true,
            pageCount: 2,
            lastModified: 20,
            size: 200,
          },
          coverLetter: null,
        },
      ],
      chunks: [],
    });

    const formatRefs = await selectFormatReferenceSummaries({
      referenceRoleFamilies: ["public_sector_policy_economic_development"],
      targetPages: 2,
    });
    const evidenceRefs = summarizeEvidenceReferenceHits([
      {
        qualification: "Stakeholder research",
        chunks: [
          {
            id: "chunk-1",
            fileName: "City Two Page Resume.docx",
            relativePath: "refs/City Two Page Resume.docx",
            kind: "resume",
            roleFamily: "public_sector_policy_economic_development",
            section: "Experience",
            text: "Prepared stakeholder research evidence.",
            keywords: ["Stakeholder", "Research"],
          },
        ],
      },
    ]);

    expect(formatRefs).toEqual([
      expect.objectContaining({
        purpose: "format",
        fileName: "City Two Page Resume.docx",
      }),
    ]);
    expect(evidenceRefs).toEqual([
      expect.objectContaining({
        purpose: "evidence",
        section: "Experience",
      }),
    ]);
  });
});
