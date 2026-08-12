import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "@server/config/dataDir";
import { getActiveTenantId } from "@server/tenancy/context";
import type {
  ExperienceAnchorSummary,
  JdKeywordProfile,
  JdNormalizedRequirement,
  JdQualificationProfile,
  ResumeGenerationReferenceSummary,
  ResumeReferenceChunk,
  ResumeReferenceScanItem,
  ResumeReferenceScanResult,
  SelectedResumeEvidence,
} from "@shared/types";
import Database from "better-sqlite3";
import { z } from "zod";
import { buildExperienceAnchorBank } from "./experience-anchor-bank";

const referenceItemSchema = z.object({
  fileName: z.string().max(255),
  relativePath: z.string().max(1000),
  inferredRole: z.string().max(120),
  kind: z.enum(["resume", "cover", "combined", "unknown"]),
  sections: z.array(z.string().max(80)).max(30),
  hasSkills: z.boolean(),
  pageCount: z.number().int().positive().nullable(),
  lastModified: z.number().int().positive().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  keywords: z.array(z.string().max(80)).max(40).optional(),
  snippets: z
    .object({
      summary: z.string().max(1200).optional(),
      experience: z.string().max(1800).optional(),
      coverLetter: z.string().max(1800).optional(),
    })
    .optional(),
});

const referenceChunkSchema = z.object({
  id: z.string().max(1200),
  relativePath: z.string().max(1000),
  fileName: z.string().max(255),
  kind: z.enum(["resume", "cover", "combined", "unknown"]),
  roleFamily: z.string().max(120),
  section: z.string().max(80),
  text: z.string().max(1200),
  rawText: z.string().max(3000).optional(),
  normalizedText: z.string().max(3000).optional(),
  keywords: z.array(z.string().max(80)).max(40),
  clusterId: z.string().max(120).optional(),
  embedding: z.array(z.number()).max(4096).optional(),
  qualitySignals: z
    .object({
      textLength: z.number().int().min(0).max(3000),
      keywordCount: z.number().int().min(0).max(100),
      hasMetrics: z.boolean(),
      sectionScore: z.number().min(0).max(10),
      sourceKindScore: z.number().min(0).max(10),
      recencyScore: z.number().min(0).max(10),
      confidence: z.enum(["high", "medium", "low"]),
    })
    .optional(),
  experienceAnchorId: z.string().max(120).optional(),
  claimType: z
    .enum([
      "responsibility",
      "tool",
      "domain",
      "outcome",
      "metric",
      "stakeholder",
      "summary",
      "education",
      "other",
    ])
    .optional(),
  anchorSection: z.string().max(80).optional(),
  sourceQuality: z.enum(["high", "medium", "low"]).optional(),
  extractorUsed: z
    .enum([
      "docx_xml",
      "poppler_text",
      "tesseract_ocr",
      "lightweight_pdf_fallback",
    ])
    .optional(),
  lastModified: z.number().int().positive().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

const anchorFactSchema = z.object({
  text: z.string().max(1200),
  sourceChunkIds: z.array(z.string().max(1200)).max(40),
  sourceFiles: z.array(z.string().max(1000)).max(40).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});

const experienceAnchorSummarySchema = z.object({
  experienceAnchorId: z.string().max(120),
  identity: z.object({
    company: z.string().max(180),
    title: z.string().max(180),
    dateRange: z.string().max(80).optional(),
    location: z.string().max(180).optional(),
    roleAliases: z.array(z.string().max(120)).max(12),
  }),
  roleOverview: anchorFactSchema,
  responsibilityAreas: z.array(anchorFactSchema).max(30),
  majorProjects: z.array(anchorFactSchema).max(30),
  toolsAndMethods: z.array(anchorFactSchema).max(30),
  domains: z.array(anchorFactSchema).max(30),
  stakeholders: z.array(anchorFactSchema).max(30),
  measurableOutcomes: z.array(anchorFactSchema).max(30),
  transferableStrengths: z.array(anchorFactSchema).max(30),
  limitationsOrUnverifiedClaims: z.array(anchorFactSchema).max(30),
  sourceChunkIds: z.array(z.string().max(1200)).max(1000),
  sourceFiles: z.array(z.string().max(1000)).max(300),
  sourceDigestHash: z.string().max(120),
  confidence: z.enum(["high", "medium", "low"]),
  diagnostics: z.object({
    buildMethod: z.enum(["deterministic", "llm", "fallback"]),
    sourceChunkCount: z.number().int().min(0).max(20000),
    lowQualitySourceChunkIds: z.array(z.string().max(1200)).max(1000),
    orphanChunkIds: z.array(z.string().max(1200)).max(1000),
    warnings: z.array(z.string().max(500)).max(100),
  }),
  lastBuiltAt: z.string().max(80),
  version: z.number().int().min(1).max(20),
});

const representativeSchema = z.object({
  roleFamily: z.string().max(120),
  resume: referenceItemSchema.nullable(),
  coverLetter: referenceItemSchema.nullable(),
});

const writingGuideSchema = z.record(
  z.string().max(120),
  z.object({
    resumeStyle: z.string().max(700).optional(),
    bulletStyle: z.string().max(700).optional(),
    skillsStyle: z.string().max(500).optional(),
    coverLetterStyle: z.string().max(700).optional(),
    sourceFiles: z.array(z.string().max(1000)).max(10),
  }),
);

const ingestionDiagnosticsSchema = z.object({
  totalFiles: z.number().int().min(0).max(5000),
  parsedFiles: z.number().int().min(0).max(5000),
  skippedFiles: z
    .array(
      z.object({
        fileName: z.string().max(255),
        relativePath: z.string().max(1000),
        reason: z.string().max(500),
      }),
    )
    .max(5000),
  emptyTextFiles: z
    .array(
      z.object({
        fileName: z.string().max(255),
        relativePath: z.string().max(1000),
        reason: z.string().max(500),
      }),
    )
    .max(5000),
  lowQualityFiles: z
    .array(
      z.object({
        fileName: z.string().max(255),
        relativePath: z.string().max(1000),
        reason: z.string().max(500),
        textLength: z.number().int().min(0).max(1_000_000),
      }),
    )
    .max(5000),
  duplicateChunkRatio: z.number().min(0).max(1),
  clusterCount: z.number().int().min(0).max(20000),
  chunkCount: z.number().int().min(0).max(20000),
  extractorCounts: z
    .record(
      z.enum([
        "docx_xml",
        "poppler_text",
        "tesseract_ocr",
        "lightweight_pdf_fallback",
      ]),
      z.number().int().min(0).max(5000),
    )
    .optional(),
  ocrFileCount: z.number().int().min(0).max(5000).optional(),
  partialOcrFileCount: z.number().int().min(0).max(5000).optional(),
  missingDependencies: z.array(z.string().max(80)).max(20).optional(),
  fileDiagnostics: z
    .array(
      z.object({
        fileName: z.string().max(255),
        relativePath: z.string().max(1000),
        extractor: z.enum([
          "docx_xml",
          "poppler_text",
          "tesseract_ocr",
          "lightweight_pdf_fallback",
        ]),
        ocrUsed: z.boolean(),
        pageCount: z.number().int().positive().nullable(),
        textLength: z.number().int().min(0).max(1_000_000),
        missingDependencies: z.array(z.string().max(80)).max(20),
        reason: z.string().max(800),
        partialOcr: z.boolean().optional(),
        ocrPageLimit: z.number().int().positive().max(100).optional(),
      }),
    )
    .max(5000)
    .optional(),
  parser: z.literal("server"),
});

export const resumeReferenceScanSchema = z.object({
  scannedAt: z.string().max(80),
  filesConsidered: z.number().int().min(0).max(5000),
  activeCount: z.number().int().min(0).max(5000).optional(),
  resumeCount: z.number().int().min(0).max(5000),
  coverLetterCount: z.number().int().min(0).max(5000),
  combinedCount: z.number().int().min(0).max(5000),
  chunkCount: z.number().int().min(0).max(20000).optional(),
  indexedChunkCount: z.number().int().min(0).max(20000).optional(),
  indexStatus: z.enum(["not_indexed", "indexed", "failed"]).optional(),
  lastIndexError: z.string().max(1000).optional(),
  lastIndexedAt: z.string().max(80).optional(),
  ragProbe: z
    .object({
      checkedAt: z.string().max(80),
      hitCount: z.number().int().min(0).max(5000),
      sampleFiles: z.array(z.string().max(255)).max(10),
    })
    .optional(),
  changeSummary: z
    .object({
      added: z.number().int().min(0).max(5000),
      updated: z.number().int().min(0).max(5000),
      removed: z.number().int().min(0).max(5000),
      unchanged: z.number().int().min(0).max(5000),
    })
    .optional(),
  coverage: z.record(z.string().max(120), z.number().int().min(0).max(5000)),
  items: z.array(referenceItemSchema).max(600),
  representatives: z.array(representativeSchema).max(20).optional(),
  ingestionDiagnostics: ingestionDiagnosticsSchema.optional(),
  writingGuide: writingGuideSchema.optional(),
  experienceAnchors: z
    .array(experienceAnchorSummarySchema)
    .max(2000)
    .optional(),
  anchorDiagnostics: z
    .object({
      anchorCount: z.number().int().min(0).max(2000),
      orphanEvidenceChunks: z
        .array(
          z.object({
            chunkId: z.string().max(1200),
            sourceFile: z.string().max(255),
            reason: z.string().max(500),
          }),
        )
        .max(20000),
      staleAnchorWarnings: z.array(z.string().max(500)).max(500),
    })
    .optional(),
});

const resumeReferenceScanInputSchema = resumeReferenceScanSchema.extend({
  chunks: z.array(referenceChunkSchema).max(20000).optional(),
});

type ReferenceIndexResult = {
  indexStatus: NonNullable<ResumeReferenceScanResult["indexStatus"]>;
  indexedChunkCount: number;
  lastIndexError?: string;
  ragProbe?: NonNullable<ResumeReferenceScanResult["ragProbe"]>;
};

function getReferencesDir(): string {
  return join(getDataDir(), "resume-references", getActiveTenantId());
}

function getReferencesPath(): string {
  return join(getReferencesDir(), "scan.json");
}

function getReferenceIndexPath(): string {
  return join(getReferencesDir(), "reference-index.sqlite");
}

export async function saveResumeReferenceScan(
  input: unknown,
): Promise<ResumeReferenceScanResult> {
  const parsed = resumeReferenceScanInputSchema.parse(input);
  const enrichedChunks = (parsed.chunks ?? []).map(enrichEvidenceChunk);
  const anchorBank = enrichedChunks.length
    ? buildExperienceAnchorBank({
        items: parsed.items,
        chunks: enrichedChunks,
      })
    : {
        chunks: enrichedChunks,
        anchors: parsed.experienceAnchors ?? [],
        diagnostics: parsed.anchorDiagnostics ?? {
          anchorCount: parsed.experienceAnchors?.length ?? 0,
          orphanEvidenceChunks: [],
          staleAnchorWarnings: [],
        },
      };
  const chunks = anchorBank.chunks.map(enrichEvidenceChunk);
  await mkdir(getReferencesDir(), { recursive: true });
  const indexedAt = new Date().toISOString();
  const indexResult = chunks.length
    ? rebuildReferenceIndex(chunks, indexedAt)
    : clearReferenceIndex();
  const { chunks: _chunks, ...scan } = {
    ...parsed,
    experienceAnchors: anchorBank.anchors,
    anchorDiagnostics: anchorBank.diagnostics,
    chunkCount: chunks.length,
    indexedChunkCount: indexResult.indexedChunkCount,
    indexStatus: indexResult.indexStatus,
    lastIndexError: indexResult.lastIndexError,
    ragProbe: indexResult.ragProbe,
    lastIndexedAt:
      indexResult.indexStatus === "indexed" ? indexedAt : parsed.lastIndexedAt,
  };
  await writeFile(getReferencesPath(), JSON.stringify(scan, null, 2), "utf8");
  return scan;
}

export async function getResumeReferenceScan(): Promise<ResumeReferenceScanResult | null> {
  try {
    return resumeReferenceScanSchema.parse(
      JSON.parse(await readFile(getReferencesPath(), "utf8")),
    );
  } catch {
    return null;
  }
}

export async function getExperienceAnchorSummaries(): Promise<
  ExperienceAnchorSummary[]
> {
  return (await getResumeReferenceScan())?.experienceAnchors ?? [];
}

function clearReferenceIndex(): ReferenceIndexResult {
  try {
    const db = openReferenceIndex();
    db.exec(
      "DELETE FROM reference_chunks_meta; DELETE FROM reference_chunks_fts;",
    );
    db.close();
    return { indexStatus: "not_indexed", indexedChunkCount: 0 };
  } catch (error) {
    return {
      indexStatus: "failed",
      indexedChunkCount: 0,
      lastIndexError:
        error instanceof Error ? error.message : "Index clear failed",
    };
  }
}

function openReferenceIndex(): Database.Database {
  const db = new Database(getReferenceIndexPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS reference_chunks_meta (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      role_family TEXT NOT NULL,
      section TEXT NOT NULL,
      experience_anchor_id TEXT,
      claim_type TEXT,
      anchor_section TEXT,
      source_quality TEXT,
      last_modified INTEGER,
      size INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS reference_chunks_fts USING fts5(
      id UNINDEXED,
      text,
      keywords,
      file_name,
      role_family,
      section
    );
  `);
  ensureReferenceMetaColumns(db);
  return db;
}

function ensureReferenceMetaColumns(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(reference_chunks_meta)").all() as Array<{
        name?: string;
      }>
    ).map((column) => String(column.name ?? "")),
  );
  const expected: Array<[string, string]> = [
    ["experience_anchor_id", "TEXT"],
    ["claim_type", "TEXT"],
    ["anchor_section", "TEXT"],
    ["source_quality", "TEXT"],
  ];
  for (const [name, sqlType] of expected) {
    if (!columns.has(name)) {
      db.exec(
        `ALTER TABLE reference_chunks_meta ADD COLUMN ${name} ${sqlType};`,
      );
    }
  }
}

function enrichEvidenceChunk(
  chunk: ResumeReferenceChunk,
): ResumeReferenceChunk {
  const rawText = chunk.rawText ?? chunk.text;
  const normalizedText = chunk.normalizedText ?? normalizeText(rawText);
  const clusterId =
    chunk.clusterId ?? buildEvidenceClusterId(chunk, normalizedText);
  const evidenceGroupId = chunk.evidenceGroupId ?? buildEvidenceGroupId(chunk);
  const evidenceGroupLabel =
    chunk.evidenceGroupLabel ?? buildEvidenceGroupLabel(chunk);
  const qualitySignals =
    chunk.qualitySignals ?? buildQualitySignals(chunk, rawText);
  return {
    ...chunk,
    rawText,
    normalizedText,
    clusterId,
    evidenceGroupId,
    evidenceGroupLabel,
    qualitySignals,
  };
}

function buildEvidenceClusterId(
  chunk: ResumeReferenceChunk,
  normalizedText: string,
): string {
  const fingerprint = [
    chunk.roleFamily,
    chunk.section.toLowerCase(),
    normalizedText
      .replace(/[^a-z0-9+#.-]+/g, " ")
      .trim()
      .slice(0, 600),
  ].join("|");
  return `cluster:${createHash("sha1").update(fingerprint).digest("hex").slice(0, 14)}`;
}

function buildEvidenceGroupId(chunk: ResumeReferenceChunk): string {
  if (chunk.experienceAnchorId) return `exp_anchor:${chunk.experienceAnchorId}`;
  const fingerprint = [
    chunk.relativePath || chunk.fileName,
    chunk.roleFamily,
    chunk.section.toLowerCase(),
  ].join("|");
  return `evidence_group:${createHash("sha1")
    .update(fingerprint)
    .digest("hex")
    .slice(0, 14)}`;
}

function buildEvidenceGroupLabel(chunk: ResumeReferenceChunk): string {
  return [chunk.fileName, chunk.roleFamily, chunk.section]
    .filter(Boolean)
    .join(" > ");
}

function buildQualitySignals(
  chunk: ResumeReferenceChunk,
  rawText: string,
): NonNullable<ResumeReferenceChunk["qualitySignals"]> {
  const section = chunk.section.toLowerCase();
  const sectionScore = /experience|project|achievement/i.test(section)
    ? 3
    : /skills|summary|education/i.test(section)
      ? 2
      : 1;
  const sourceKindScore =
    chunk.kind === "combined" ? 3 : chunk.kind === "resume" ? 2 : 1;
  const recencyScore = (chunk.lastModified ?? 0) > 0 ? 1 : 0;
  const hasMetrics = /\b\d+(?:\.\d+)?%|\$\s?\d|\b\d{2,}\b/.test(rawText);
  const textLength = rawText.trim().length;
  const keywordCount = chunk.keywords.length;
  const confidence =
    textLength >= 80 && (hasMetrics || keywordCount >= 3)
      ? "high"
      : textLength >= 40
        ? "medium"
        : "low";
  return {
    textLength,
    keywordCount,
    hasMetrics,
    sectionScore,
    sourceKindScore,
    recencyScore,
    confidence,
  };
}

function rebuildReferenceIndex(
  chunks: ResumeReferenceChunk[],
  checkedAt: string,
): ReferenceIndexResult {
  let db: Database.Database | null = null;
  try {
    const activeDb = openReferenceIndex();
    db = activeDb;
    const insertMeta = activeDb.prepare(`
      INSERT INTO reference_chunks_meta (
        id, relative_path, file_name, kind, role_family, section,
        experience_anchor_id, claim_type, anchor_section, source_quality,
        last_modified, size
      ) VALUES (
        @id, @relativePath, @fileName, @kind, @roleFamily, @section,
        @experienceAnchorId, @claimType, @anchorSection, @sourceQuality,
        @lastModified, @size
      )
    `);
    const insertFts = activeDb.prepare(`
      INSERT INTO reference_chunks_fts (
        id, text, keywords, file_name, role_family, section
      ) VALUES (
        @id, @text, @keywordsText, @fileName, @roleFamily, @section
      )
    `);
    const rebuild = activeDb.transaction((items: ResumeReferenceChunk[]) => {
      activeDb.exec(
        "DELETE FROM reference_chunks_meta; DELETE FROM reference_chunks_fts;",
      );
      for (const chunk of items) {
        const row = {
          ...chunk,
          keywordsText: chunk.keywords.join(", "),
          lastModified: chunk.lastModified ?? null,
          size: chunk.size ?? null,
        };
        insertMeta.run(row);
        insertFts.run(row);
      }
    });
    rebuild(chunks);
    const indexCounts = countReferenceIndexRows(activeDb);
    if (
      indexCounts.metaCount !== chunks.length ||
      indexCounts.ftsCount !== chunks.length
    ) {
      throw new Error(
        `Reference index row count mismatch: expected ${chunks.length}, indexed ${indexCounts.ftsCount} FTS rows and ${indexCounts.metaCount} metadata rows.`,
      );
    }
    const ragProbe = probeReferenceIndex(activeDb, chunks, checkedAt);
    if (ragProbe.hitCount === 0) {
      throw new Error("Reference index probe returned no searchable chunks.");
    }
    activeDb.close();
    db = null;
    return {
      indexStatus: "indexed",
      indexedChunkCount: indexCounts.ftsCount,
      ragProbe,
    };
  } catch (error) {
    try {
      db?.exec(
        "DELETE FROM reference_chunks_meta; DELETE FROM reference_chunks_fts;",
      );
      db?.close();
    } catch {
      // Keep the original indexing error below.
    }
    return {
      indexStatus: "failed",
      indexedChunkCount: 0,
      lastIndexError:
        error instanceof Error
          ? error.message
          : "Reference index rebuild failed",
    };
  }
}

function countReferenceIndexRows(db: Database.Database): {
  ftsCount: number;
  metaCount: number;
} {
  const ftsRow = db
    .prepare("SELECT count(*) AS count FROM reference_chunks_fts")
    .get() as { count?: number } | undefined;
  const metaRow = db
    .prepare("SELECT count(*) AS count FROM reference_chunks_meta")
    .get() as { count?: number } | undefined;
  return {
    ftsCount: typeof ftsRow?.count === "number" ? ftsRow.count : 0,
    metaCount: typeof metaRow?.count === "number" ? metaRow.count : 0,
  };
}

function probeReferenceIndex(
  db: Database.Database,
  chunks: ResumeReferenceChunk[],
  checkedAt: string,
): NonNullable<ResumeReferenceScanResult["ragProbe"]> {
  const firstChunk = chunks[0];
  const query = buildFtsQuery([
    firstChunk?.fileName ?? "",
    firstChunk?.section ?? "",
    firstChunk?.keywords.join(" ") ?? "",
    firstChunk?.text ?? "",
  ]);
  const hits = query ? queryReferenceChunks(db, query).slice(0, 10) : [];
  return {
    checkedAt,
    hitCount: hits.length,
    sampleFiles: Array.from(new Set(hits.map((hit) => hit.fileName))).slice(
      0,
      5,
    ),
  };
}

function roleMatches(requested: string | null | undefined, candidate: string) {
  if (!requested) return false;
  if (requested === candidate) return true;
  if (
    requested === "public_sector_policy_economic_development" &&
    candidate === "city_public_policy_data_research"
  ) {
    return true;
  }
  if (
    requested === "market_insights_research" &&
    candidate === "city_public_policy_data_research"
  ) {
    return true;
  }
  return false;
}

function formatRepresentative(
  item: ResumeReferenceScanResult["items"][number] | null,
) {
  if (!item) return "";
  const snippets = [
    item.snippets?.summary ? `Summary style: ${item.snippets.summary}` : "",
    item.snippets?.experience
      ? `Experience bullet pattern: ${item.snippets.experience}`
      : "",
    item.snippets?.coverLetter
      ? `Cover letter structure: ${item.snippets.coverLetter}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return [`${item.kind}: ${item.fileName}`, snippets]
    .filter(Boolean)
    .join("\n");
}

function referenceSummary(
  item: ResumeReferenceScanItem,
  purpose: "format" | "evidence",
  roleFamily?: string,
  section?: string,
): ResumeGenerationReferenceSummary {
  return {
    purpose,
    fileName: item.fileName,
    relativePath: item.relativePath,
    roleFamily: roleFamily ?? item.inferredRole,
    section,
  };
}

export async function selectFormatReferenceSummaries(args: {
  referenceRoleFamilies: string[];
  targetPages: 1 | 2;
  maxItems?: number;
}): Promise<ResumeGenerationReferenceSummary[]> {
  const scan = await getResumeReferenceScan();
  if (!scan) return [];
  const maxItems = Math.max(1, Math.min(args.maxItems ?? 2, 3));
  const selected = new Map<string, ResumeGenerationReferenceSummary>();
  const add = (
    item: ResumeReferenceScanItem | null | undefined,
    roleFamily?: string,
  ) => {
    if (!item || !["resume", "combined"].includes(item.kind)) return;
    if (item.pageCount != null && item.pageCount !== args.targetPages) return;
    const key = item.relativePath || item.fileName;
    if (!selected.has(key)) {
      selected.set(key, referenceSummary(item, "format", roleFamily));
    }
  };

  for (const family of args.referenceRoleFamilies) {
    for (const representative of scan.representatives ?? []) {
      if (roleMatches(family, representative.roleFamily)) {
        add(representative.resume, representative.roleFamily);
      }
      if (selected.size >= maxItems) return Array.from(selected.values());
    }
  }

  const fallback = scan.items
    .filter((item) => ["resume", "combined"].includes(item.kind))
    .filter(
      (item) => item.pageCount == null || item.pageCount === args.targetPages,
    )
    .filter((item) =>
      args.referenceRoleFamilies.some((family) =>
        roleMatches(family, item.inferredRole),
      ),
    )
    .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
  for (const item of fallback) {
    add(item, item.inferredRole);
    if (selected.size >= maxItems) break;
  }
  return Array.from(selected.values());
}

export async function buildResumeReferenceInstructions(args?: {
  roleFamily?: string | null;
  targetPages?: 1 | 2;
  formatReferences?: ResumeGenerationReferenceSummary[];
}): Promise<string> {
  const scan = await getResumeReferenceScan();
  if (!scan || scan.items.length === 0) return "";

  const coverage = Object.entries(scan.coverage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([role, count]) => `${role}: ${count}`)
    .join("; ");
  const skillsSignals = scan.items.filter((item) => item.hasSkills).length;
  const sectionExamples = scan.items
    .slice(0, 8)
    .map((item) => {
      const sections = item.sections.length
        ? item.sections.join(", ")
        : "sections not detected";
      return `- ${item.kind} / ${item.inferredRole}: ${sections}`;
    })
    .join("\n");
  const representatives = scan.representatives ?? [];
  const selectedRepresentatives = representatives.filter((representative) =>
    roleMatches(args?.roleFamily, representative.roleFamily),
  );
  const representativeBlock = selectedRepresentatives
    .map((representative) =>
      [
        `Representative for ${representative.roleFamily}:`,
        formatRepresentative(representative.resume),
        formatRepresentative(representative.coverLetter),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  const writingGuide = scan.writingGuide
    ? Object.entries(scan.writingGuide)
        .filter(
          (
            entry,
          ): entry is [
            string,
            NonNullable<ResumeReferenceScanResult["writingGuide"]>[string],
          ] => Boolean(entry[1]) && roleMatches(args?.roleFamily, entry[0]),
        )
        .map(([role, guide]) => {
          const safeGuide = guide ?? { sourceFiles: [] };
          return [
            `Writing guide for ${role}:`,
            safeGuide.resumeStyle
              ? `Resume style: ${safeGuide.resumeStyle}`
              : "",
            safeGuide.bulletStyle
              ? `Bullet style: ${safeGuide.bulletStyle}`
              : "",
            safeGuide.skillsStyle
              ? `Skills style: ${safeGuide.skillsStyle}`
              : "",
            safeGuide.coverLetterStyle
              ? `Cover letter style: ${safeGuide.coverLetterStyle}`
              : "",
            safeGuide.sourceFiles?.length
              ? `Guide sources: ${safeGuide.sourceFiles.slice(0, 5).join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n")
    : "";

  return [
    `Resume reference library scanned ${scan.items.length} local documents.`,
    coverage ? `Role-family coverage: ${coverage}.` : "",
    `${skillsSignals} documents show a Skills/Core Competencies section.`,
    "Use representative references only for structure, tone, section vocabulary, and bullet style. Do not copy domain terms from references unless they are also allowed by the current JD keyword profile.",
    "When tailoring, preserve the user's established section vocabulary and document structure unless the current job policy requires a stricter length.",
    args?.formatReferences?.length
      ? `Selected format references (${args.targetPages ?? "unknown"}-page): ${args.formatReferences
          .slice(0, 3)
          .map((item) => item.relativePath || item.fileName)
          .join(
            "; ",
          )}. Use these for layout, section ordering, tone, and bullet style only.`
      : "",
    writingGuide,
    representativeBlock,
    sectionExamples,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function findResumeReferenceEvidenceForQualifications(args: {
  qualificationProfile: JdQualificationProfile;
  maxItems?: number;
}): Promise<ResumeReferenceScanResult["items"]> {
  const scan = await getResumeReferenceScan();
  if (!scan) return [];
  const terms = [
    ...args.qualificationProfile.required,
    ...args.qualificationProfile.preferred,
    ...args.qualificationProfile.keywords,
  ]
    .flatMap((value) => value.toLowerCase().split(/[^a-z0-9+#.-]+/))
    .filter((value) => value.length >= 4);
  if (terms.length === 0) return scan.items.slice(0, args.maxItems ?? 5);
  const scored = scan.items
    .map((item) => {
      const text = [
        item.fileName,
        item.inferredRole,
        item.sections.join(" "),
        item.keywords?.join(" "),
        item.snippets?.summary,
        item.snippets?.experience,
        item.snippets?.coverLetter,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const score = terms.reduce(
        (sum, term) => sum + (text.includes(term) ? 1 : 0),
        0,
      );
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, args.maxItems ?? 5).map((entry) => entry.item);
}

export type ResumeReferenceKnowledgeHit = {
  qualification: string;
  requirementId?: string;
  category?: string;
  priority?: number;
  chunks: ResumeReferenceChunk[];
};

export function buildSelectedResumeEvidence(args: {
  qualificationProfile: JdQualificationProfile;
  knowledgeHits: ResumeReferenceKnowledgeHit[];
  maxChunksPerRequirement?: number;
}): SelectedResumeEvidence[] {
  const hitsByRequirement = new Map(
    args.knowledgeHits.map((hit) => [normalizeText(hit.qualification), hit]),
  );
  const maxChunks = Math.max(1, Math.min(args.maxChunksPerRequirement ?? 3, 6));
  return getTopNormalizedRequirements(args.qualificationProfile).map(
    (requirement) => {
      const hit = hitsByRequirement.get(normalizeText(requirement.text));
      const chunks = dedupeChunksByClusterAndFile(hit?.chunks ?? [])
        .slice(0, maxChunks)
        .map((chunk) => {
          const evidenceGroupId =
            chunk.evidenceGroupId ?? buildEvidenceGroupId(chunk);
          return {
            chunkId: chunk.id,
            clusterId: chunk.clusterId,
            evidenceGroupId,
            evidenceGroupLabel:
              chunk.evidenceGroupLabel ?? buildEvidenceGroupLabel(chunk),
            experienceAnchorId: chunk.experienceAnchorId,
            sourceFile: chunk.fileName,
            relativePath: chunk.relativePath,
            section: chunk.section,
            roleFamily: chunk.roleFamily,
            rawText: chunk.rawText ?? chunk.text,
            keywords: chunk.keywords,
            qualitySignals: chunk.qualitySignals,
            claimType: chunk.claimType,
            anchorSection: chunk.anchorSection,
            sourceQuality: chunk.sourceQuality,
            fit: "transferable" as const,
            confidence: "low" as const,
          };
        });
      return chunks.length
        ? {
            requirement: requirement.text,
            requirementId: requirement.id,
            category: requirement.category,
            priority: requirement.priority,
            status: "transferable_only" as const,
            fit: "transferable" as const,
            confidence: "low" as const,
            chunks,
            reason:
              "Deterministic fallback selected keyword-matching evidence; claims must be softened unless reranked direct.",
            allowedClaims: buildFallbackAllowedClaims(
              requirement.text,
              chunks.map((chunk) => chunk.rawText),
            ),
            blockedClaims: [
              `Do not claim direct ${requirement.text} experience unless the selected chunk explicitly says it.`,
            ],
            candidateChunkCount: hit?.chunks.length ?? chunks.length,
            sourceClusterIds: Array.from(
              new Set(chunks.map((chunk) => chunk.clusterId).filter(Boolean)),
            ) as string[],
          }
        : {
            requirement: requirement.text,
            requirementId: requirement.id,
            category: requirement.category,
            priority: requirement.priority,
            status: "no_evidence" as const,
            fit: "unsupported" as const,
            confidence: "low" as const,
            chunks: [],
            missingReason:
              "No matching resume evidence chunk found in the evidence bank.",
            reason:
              "No matching resume evidence chunk found in the evidence bank.",
            allowedClaims: [],
            blockedClaims: [`Do not claim ${requirement.text}.`],
            candidateChunkCount: 0,
            sourceClusterIds: [],
          };
    },
  );
}

export async function findReferenceChunksForQualifications(args: {
  qualificationProfile: JdQualificationProfile;
  keywordProfile?: JdKeywordProfile | null;
  maxChunksPerQualification?: number;
}): Promise<ResumeReferenceKnowledgeHit[]> {
  const scan = await getResumeReferenceScan();
  if (!scan || scan.indexStatus !== "indexed" || (scan.chunkCount ?? 0) === 0) {
    return [];
  }
  const maxChunks = Math.max(
    1,
    Math.min(args.maxChunksPerQualification ?? 3, 20),
  );
  let db: Database.Database;
  try {
    db = openReferenceIndex();
  } catch {
    return [];
  }
  try {
    return getTopNormalizedRequirements(args.qualificationProfile).map(
      (requirement) => {
        const qualification = requirement.text;
        const primaryQuery = buildFtsQuery([
          qualification,
          ...args.qualificationProfile.keywords,
        ]);
        const fallbackQuery = buildFtsQuery([
          ...(args.keywordProfile?.requiredKeywords ?? []),
          ...(args.keywordProfile?.experienceFocus ?? []),
          ...args.qualificationProfile.keywords,
        ]);
        const primaryRows = primaryQuery
          ? queryReferenceChunks(db, primaryQuery)
          : [];
        const rows =
          primaryRows.length > 0 || !fallbackQuery
            ? primaryRows
            : queryReferenceChunks(db, fallbackQuery);
        const reranked = rows
          .map((chunk) => ({
            chunk,
            score: scoreChunkForQualification({
              chunk,
              qualification,
              keywordProfile: args.keywordProfile,
            }),
          }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.chunk);
        return {
          qualification,
          requirementId: requirement.id,
          category: requirement.category,
          priority: requirement.priority,
          chunks: dedupeChunksByClusterAndFile(reranked).slice(0, maxChunks),
        };
      },
    );
  } finally {
    db.close();
  }
}

export function getTopNormalizedRequirements(
  profile: JdQualificationProfile,
): JdNormalizedRequirement[] {
  if (profile.requirements?.length) return profile.requirements.slice(0, 12);
  return profile.required.slice(0, 8).map((text, index) => ({
    id: `req-${index + 1}`,
    text,
    category: "experience",
    priority: 100 - index,
    targetSections: ["experience", "summary"],
    mustHave: true,
    evidenceNeeded: "direct",
  }));
}

function buildFallbackAllowedClaims(
  requirement: string,
  chunkTexts: string[],
): string[] {
  const text = chunkTexts.join(" ").toLowerCase();
  return requirement
    .split(/[^a-z0-9+#.]+/i)
    .filter((term) => term.length >= 4)
    .filter((term) => text.includes(term.toLowerCase()))
    .slice(0, 5);
}

function queryReferenceChunks(
  db: Database.Database,
  query: string,
): ResumeReferenceChunk[] {
  try {
    return db
      .prepare(
        `
        SELECT
          f.id,
          m.relative_path AS relativePath,
          m.file_name AS fileName,
          m.kind,
          m.role_family AS roleFamily,
          m.section,
          m.experience_anchor_id AS experienceAnchorId,
          m.claim_type AS claimType,
          m.anchor_section AS anchorSection,
          m.source_quality AS sourceQuality,
          f.text,
          f.keywords,
          m.last_modified AS lastModified,
          m.size
        FROM reference_chunks_fts f
        JOIN reference_chunks_meta m ON m.id = f.id
        WHERE reference_chunks_fts MATCH ?
        ORDER BY bm25(reference_chunks_fts)
        LIMIT 80
      `,
      )
      .all(query)
      .map(rowToChunk);
  } catch {
    return [];
  }
}

function rowToChunk(row: unknown): ResumeReferenceChunk {
  const record = row as Record<string, unknown>;
  return enrichEvidenceChunk({
    id: String(record.id ?? ""),
    relativePath: String(record.relativePath ?? ""),
    fileName: String(record.fileName ?? ""),
    kind: isReferenceKind(record.kind) ? record.kind : "unknown",
    roleFamily: String(record.roleFamily ?? "general"),
    section: String(record.section ?? "General"),
    text: String(record.text ?? ""),
    experienceAnchorId:
      typeof record.experienceAnchorId === "string" && record.experienceAnchorId
        ? record.experienceAnchorId
        : undefined,
    claimType: isEvidenceClaimType(record.claimType)
      ? record.claimType
      : undefined,
    anchorSection:
      typeof record.anchorSection === "string" && record.anchorSection
        ? record.anchorSection
        : undefined,
    sourceQuality: isSourceQuality(record.sourceQuality)
      ? record.sourceQuality
      : undefined,
    keywords: String(record.keywords ?? "")
      .split(/\s*,\s*|\s{2,}/)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 40),
    lastModified:
      typeof record.lastModified === "number" ? record.lastModified : null,
    size: typeof record.size === "number" ? record.size : null,
  });
}

export function summarizeEvidenceReferenceHits(
  hits: ResumeReferenceKnowledgeHit[],
  maxItems = 5,
): ResumeGenerationReferenceSummary[] {
  const out: ResumeGenerationReferenceSummary[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    for (const chunk of hit.chunks) {
      const key = `${chunk.relativePath || chunk.fileName}:${chunk.section}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        purpose: "evidence",
        fileName: chunk.fileName,
        relativePath: chunk.relativePath,
        roleFamily: chunk.roleFamily,
        section: chunk.section,
      });
      if (out.length >= maxItems) return out;
    }
  }
  return out;
}

function isReferenceKind(
  value: unknown,
): value is ResumeReferenceScanItem["kind"] {
  return (
    value === "resume" ||
    value === "cover" ||
    value === "combined" ||
    value === "unknown"
  );
}

function isEvidenceClaimType(
  value: unknown,
): value is NonNullable<ResumeReferenceChunk["claimType"]> {
  return (
    value === "responsibility" ||
    value === "tool" ||
    value === "domain" ||
    value === "outcome" ||
    value === "metric" ||
    value === "stakeholder" ||
    value === "summary" ||
    value === "education" ||
    value === "other"
  );
}

function isSourceQuality(value: unknown): value is "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low";
}

function buildFtsQuery(values: string[]): string {
  const tokens = values
    .flatMap((value) => value.toLowerCase().split(/[^a-z0-9+#.-]+/))
    .filter((value) => value.length >= 4)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 24);
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

function scoreChunkForQualification(args: {
  chunk: ResumeReferenceChunk;
  qualification: string;
  keywordProfile?: JdKeywordProfile | null;
}): number {
  const text = normalizeText(
    [
      args.chunk.text,
      args.chunk.keywords.join(" "),
      args.chunk.section,
      args.chunk.roleFamily,
    ].join(" "),
  );
  const qualificationTerms = normalizeTerms(args.qualification);
  const keywordTerms = normalizeTerms(
    [
      ...(args.keywordProfile?.requiredKeywords ?? []),
      ...(args.keywordProfile?.experienceFocus ?? []),
    ].join(" "),
  );
  let score = 0;
  for (const term of qualificationTerms) {
    if (text.includes(term)) score += term.includes(" ") ? 4 : 2;
  }
  for (const term of keywordTerms) {
    if (text.includes(term)) score += 1;
  }
  if (
    args.keywordProfile?.roleFamily &&
    roleMatches(args.keywordProfile.roleFamily, args.chunk.roleFamily)
  ) {
    score += 4;
  }
  if (/experience|project|skills/i.test(args.chunk.section)) score += 2;
  if (args.chunk.kind === "resume" || args.chunk.kind === "combined")
    score += 1;
  if ((args.chunk.lastModified ?? 0) > 0) score += 0.5;
  return score;
}

function normalizeTerms(value: string): string[] {
  const normalized = normalizeText(value);
  const phrases =
    normalized.match(/\b[a-z][a-z0-9+#.-]*(?:\s+[a-z][a-z0-9+#.-]*){1,3}\b/g) ??
    [];
  const words = normalized
    .split(/[^a-z0-9+#.-]+/)
    .filter((word) => word.length >= 4);
  return Array.from(new Set([...phrases, ...words])).slice(0, 24);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeChunksByClusterAndFile(
  chunks: ResumeReferenceChunk[],
): ResumeReferenceChunk[] {
  const seenClusters = new Set<string>();
  const seenByFile = new Map<string, number>();
  const out: ResumeReferenceChunk[] = [];
  for (const chunk of chunks) {
    const clusterId = chunk.clusterId || chunk.id;
    if (seenClusters.has(clusterId)) continue;
    seenClusters.add(clusterId);
    const count = seenByFile.get(chunk.relativePath) ?? 0;
    if (count >= 2) continue;
    seenByFile.set(chunk.relativePath, count + 1);
    out.push(chunk);
  }
  return out;
}
