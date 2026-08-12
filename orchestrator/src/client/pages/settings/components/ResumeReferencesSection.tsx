import * as api from "@client/api";
import type {
  ResumeReferenceIngestFile,
  ResumeReferenceScanResult,
} from "@shared/types.js";
import JSZip from "jszip";
import { FileSearch, FolderOpen, Loader2, RotateCcw } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsSectionFrame } from "./SettingsSectionFrame";

type ResumeReferenceItem = ResumeReferenceScanResult["items"][number];
type ResumeReferenceChunk = NonNullable<
  ResumeReferenceScanResult["chunks"]
>[number];
type ResumeReferenceRepresentative = NonNullable<
  ResumeReferenceScanResult["representatives"]
>[number];

const STORAGE_KEY = "jobops.resumeReferences.scan";
const REFERENCE_INDEX_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_REFERENCE_ITEMS_PER_SCAN = 600;
const MAX_REFERENCE_CHUNKS_PER_FILE = 180;
const MAX_REFERENCE_CHUNKS_PER_SCAN = 18_000;
const TARGET_REFERENCE_CHUNK_LENGTH = 420;
const MAX_REFERENCE_CHUNK_LENGTH = 700;
const ROLE_FAMILIES = [
  "consulting_strategy",
  "public_sector_policy_economic_development",
  "data_analytics_operations",
  "market_insights_research",
] as const;

const ROLE_LABELS: Record<string, string> = {
  consulting_strategy: "Consulting / strategy",
  public_sector_policy_economic_development: "City / public policy / data",
  data_analytics_operations: "Pure data / analytics",
  market_insights_research: "Research / insights",
  general: "General",
};

const SECTION_PATTERNS: Array<[string, RegExp]> = [
  ["Summary", /\b(summary|profile|objective)\b/i],
  ["Skills", /\b(skills|technical skills|core competencies)\b/i],
  ["Experience", /\b(experience|professional experience|work history)\b/i],
  ["Projects", /\b(projects|selected projects|portfolio)\b/i],
  ["Education", /\b(education|academic)\b/i],
  ["Certifications", /\b(certifications?|credentials?)\b/i],
];

const KEYWORD_PATTERNS: Array<[string, RegExp]> = [
  ["Stakeholder engagement", /\bstakeholder engagement\b/i],
  ["Policy analysis", /\bpolicy analysis\b/i],
  ["Briefing notes", /\bbriefing notes?\b/i],
  ["Research", /\bresearch\b/i],
  ["Project coordination", /\bproject coordination\b/i],
  ["Project management", /\bproject management\b/i],
  ["Strategic planning", /\bstrategic planning\b/i],
  ["Enterprise strategy", /\benterprise strategy\b/i],
  ["Business planning", /\bbusiness planning\b/i],
  ["Data analysis", /\bdata analysis\b/i],
  ["Reporting", /\breporting\b/i],
  ["Dashboard", /\bdashboards?\b/i],
  ["Quality assurance", /\bquality assurance\b|\bQA\b/i],
  ["Excel", /\bexcel\b/i],
  ["Power BI", /\bpower\s*bi\b/i],
  ["Tableau", /\btableau\b/i],
  ["SQL", /\bsql\b/i],
  ["Python", /\bpython\b/i],
  ["SAS", /\bsas\b/i],
  ["Market research", /\bmarket research\b/i],
  ["Communications", /\bcommunications?\b/i],
  ["French", /\bfrench\b/i],
];

function getRelativePath(file: File): string {
  const withDirectory = file as File & { webkitRelativePath?: string };
  return withDirectory.webkitRelativePath || file.name;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    chunks.push(String.fromCharCode(...chunk));
  }
  return window.btoa(chunks.join(""));
}

async function toIngestFile(file: File): Promise<ResumeReferenceIngestFile> {
  const relativePath = getRelativePath(file);
  return {
    fileName: file.name,
    relativePath,
    kind: classifyKind(relativePath),
    contentBase64: arrayBufferToBase64(await file.arrayBuffer()),
    mimeType: file.type || null,
    lastModified: file.lastModified || null,
    size: file.size || null,
  };
}

function classifyKind(path: string): ResumeReferenceItem["kind"] {
  const lower = path.toLowerCase();
  if (/cover|letter/.test(lower)) return "cover";
  if (/combined|package|application/.test(lower)) return "combined";
  if (/resume|cv/.test(lower)) return "resume";
  return "unknown";
}

function inferRole(path: string, text: string): string {
  const p = path.toLowerCase();
  const t = text.toLowerCase();

  type RoleId =
    | "consulting_strategy"
    | "public_sector_policy_economic_development"
    | "data_analytics_operations"
    | "market_insights_research";

  interface Rule {
    role: RoleId;
    pathPattern: RegExp;
    textPattern: RegExp;
  }

  const rules: Rule[] = [
    {
      role: "consulting_strategy",
      pathPattern:
        /\b(consult(?:ant|ing)?|strateg(?:y|ist)|deloitte|ibm|kpmg|ey\b|pwc|mckinsey|bcg|bain|accenture|advisory|konrad|altus group|turner & townsend)\b/i,
      textPattern:
        /\b(consult(?:ant|ing)?|strateg(?:y|ist|ic)|deloitte|ibm|kpmg|ey\b|pwc|mckinsey|bcg|bain|accenture|advisory|konrad|altus group|turner & townsend|enterprise strateg|management consulting)\b/i,
    },
    {
      role: "public_sector_policy_economic_development",
      pathPattern:
        /\b(policy|government|municipal|city of|province|ontario public service|ops\b|public sector|ministry|economic development|national research council|building ontario fund|greater toronto airports|ccppp|responsible gambling council|government of canada|government of ontario|canadian climate institute|food bank|climate institute|think tank|non.profit|charity|foundation)\b/i,
      textPattern:
        /\b(policy|government|municipal|city of|province|ontario public service|ops\b|public sector|ministry|economic development|national research council|building ontario fund|greater toronto airports|ccppp|responsible gambling council|government of canada|government of ontario|canadian climate institute|food bank|climate institute|think tank|non.profit|charity|foundation)\b/i,
    },
    {
      role: "data_analytics_operations",
      pathPattern:
        /\b(data (?:analyst|analytics|science|engineer|transformation)|analytics|sql|power\s*bi|tableau|dashboard|ai\b|machine learning|operations analyst|jerry\.ai)\b/i,
      textPattern:
        /\b(data (?:analyst|analytics|science|engineer|transformation|analysis|visualization)|analytics|sql|power\s*bi|tableau|dashboard|ai\b|machine learning|operations analyst|python|sas|jerry\.ai)\b/i,
    },
    {
      role: "market_insights_research",
      pathPattern:
        /\b(research (?:analyst|associate)|market research|market insights|survey|ipsos|dynata|insight analyst|cossette|savanta)\b/i,
      textPattern:
        /\b(research (?:analyst|associate)|market research|market insights|survey research|ipsos|dynata|insight analyst|cossette|savanta|qualitative|quantitative)\b/i,
    },
  ];

  const scores: Record<RoleId, { total: number; pathHits: number }> = {
    consulting_strategy: { total: 0, pathHits: 0 },
    public_sector_policy_economic_development: { total: 0, pathHits: 0 },
    data_analytics_operations: { total: 0, pathHits: 0 },
    market_insights_research: { total: 0, pathHits: 0 },
  };

  for (const rule of rules) {
    const pathMatches = (p.match(rule.pathPattern) ?? []).length;
    const textMatches = (t.match(rule.textPattern) ?? []).length;
    scores[rule.role].pathHits = pathMatches;
    scores[rule.role].total = pathMatches * 2 + textMatches;
  }

  const ranked = (Object.keys(scores) as RoleId[])
    .filter((role) => scores[role].total > 0)
    .sort((a, b) => {
      const diff = scores[b].total - scores[a].total;
      if (diff !== 0) return diff;
      return scores[b].pathHits - scores[a].pathHits;
    });

  if (
    ranked.length >= 2 &&
    scores[ranked[0]].total === scores[ranked[1]].total &&
    scores[ranked[0]].pathHits === scores[ranked[1]].pathHits
  ) {
    return "general";
  }

  return ranked[0] ?? "general";
}

function detectSections(text: string): string[] {
  const found = SECTION_PATTERNS.filter(([, pattern]) =>
    pattern.test(text),
  ).map(([label]) => label);
  return Array.from(new Set(found));
}

function extractKeywords(text: string): string[] {
  const found = KEYWORD_PATTERNS.filter(([, pattern]) =>
    pattern.test(text),
  ).map(([label]) => label);
  const acronyms = text.match(/\b[A-Z]{2,6}\b/g) ?? [];
  return Array.from(new Set([...found, ...acronyms])).slice(0, 30);
}

function countPdfPages(text: string): number | null {
  return text.match(/\/Type\s*\/Page\b/g)?.length ?? null;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").replaceAll("\0", "").trim();
}

function cleanLineText(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replaceAll("\0", "")
    .trim();
}

function clip(text: string, maxLength: number): string {
  const normalized = cleanText(text);
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trim()}...`
    : normalized;
}

function splitSearchableText(text: string): string[] {
  const normalized = cleanText(text);
  if (normalized.length < 40) return [];
  if (normalized.length <= MAX_REFERENCE_CHUNK_LENGTH) return [normalized];

  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferLength = 0;
  for (const word of normalized.split(/\s+/)) {
    const nextLength = bufferLength + word.length + (buffer.length ? 1 : 0);
    if (
      buffer.length > 0 &&
      nextLength > MAX_REFERENCE_CHUNK_LENGTH &&
      bufferLength >= 40
    ) {
      chunks.push(buffer.join(" "));
      buffer = [];
      bufferLength = 0;
    }

    buffer.push(word);
    bufferLength += word.length + (buffer.length > 1 ? 1 : 0);
    if (bufferLength >= TARGET_REFERENCE_CHUNK_LENGTH) {
      chunks.push(buffer.join(" "));
      buffer = [];
      bufferLength = 0;
    }
  }

  if (bufferLength >= 40) chunks.push(buffer.join(" "));
  return chunks;
}

function extractReferenceSnippets(
  kind: ResumeReferenceItem["kind"],
  text: string,
): ResumeReferenceItem["snippets"] {
  const normalized = cleanText(text);
  if (!normalized) return {};

  if (kind === "cover") {
    const reLine = normalized.match(/\bRe:\s*[^.]{1,180}/i)?.[0] ?? "";
    return {
      coverLetter: clip(
        [normalized.slice(0, 500), reLine].filter(Boolean).join(" "),
        800,
      ),
    };
  }

  const summaryMatch =
    normalized.match(
      /\b(?:summary|profile|objective)\b[:\s-]+(.{80,500})/i,
    )?.[1] ?? normalized.slice(0, 420);
  const bulletMatches = Array.from(
    text.matchAll(/(?:^|\n|•|-|\*)\s*([A-Z][^\n]{45,220})/g),
  )
    .map((match) => match[1])
    .slice(0, 4);

  return {
    summary: clip(summaryMatch, 600),
    experience: bulletMatches.length
      ? clip(bulletMatches.join(" | "), 1000)
      : undefined,
  };
}

async function extractDocxText(file: File): Promise<string> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) return "";
  return documentXml
    .replace(/<w:tab\/>/g, " ")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function createChunkId(
  relativePath: string,
  section: string,
  index: number,
): string {
  return `${relativePath}#${section.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index}`;
}

const SECTION_HEADING_PATTERNS: Array<[string, RegExp]> = [
  [
    "Summary",
    /^(?:summary|professional summary|profile|professional profile|objective)$/i,
  ],
  [
    "Skills",
    /^(?:skills|technical skills|core competencies|key skills|competencies)$/i,
  ],
  [
    "Experience",
    /^(?:experience|professional experience|work experience|work history|employment history|relevant experience)$/i,
  ],
  [
    "Projects",
    /^(?:projects|selected projects|portfolio|project experience)$/i,
  ],
  [
    "Education",
    /^(?:education|academic|academic background|education and credentials|education & credentials)$/i,
  ],
  [
    "Certifications",
    /^(?:certifications?|credentials?|certifications and credentials|certifications & credentials)$/i,
  ],
];

function detectSectionHeading(line: string): string | null {
  const candidate = cleanText(line)
    .replace(/^[#:-]+\s*/, "")
    .replace(/\s*[:|]\s*$/, "")
    .trim();
  if (!candidate || candidate.length > 72) return null;
  if (/[.!?]/.test(candidate)) return null;
  if (candidate.split(/\s+/).length > 8) return null;
  const matched = SECTION_HEADING_PATTERNS.find(([, pattern]) =>
    pattern.test(candidate),
  );
  return matched?.[0] ?? null;
}

function splitReferenceLines(text: string): string[] {
  return text
    .split(/\n+|(?=•)|(?=Ã¢â‚¬Â¢)|(?=\s[-*]\s)/)
    .map((line) => cleanText(line.replace(/^(?:•|Ã¢â‚¬Â¢|[-*])\s*/, "")))
    .filter(Boolean);
}

function splitReferenceSectionBlocks(
  text: string,
): Array<{ section: string; lines: string[] }> {
  const blocks: Array<{ section: string; lines: string[] }> = [];
  let currentSection = "General";
  let buffer: string[] = [];
  const flush = () => {
    if (cleanText(buffer.join(" ")).length >= 40) {
      blocks.push({ section: currentSection, lines: buffer });
    }
    buffer = [];
  };

  for (const line of splitReferenceLines(text)) {
    const nextSection = detectSectionHeading(line);
    if (nextSection) {
      flush();
      currentSection = nextSection;
      continue;
    }
    if (line.length >= 24) buffer.push(line);
  }
  flush();
  return blocks;
}

export function buildReferenceChunks(
  item: ResumeReferenceItem,
  rawText: string,
): ResumeReferenceChunk[] {
  const text = cleanLineText(rawText);
  if (!text) return [];
  const chunks: ResumeReferenceChunk[] = [];
  let chunkIndex = 0;
  const pushChunk = (section: string, value: string) => {
    for (const chunkText of splitSearchableText(value)) {
      if (chunks.length >= MAX_REFERENCE_CHUNKS_PER_FILE) return;
      chunks.push({
        id: createChunkId(item.relativePath, section, chunkIndex),
        relativePath: item.relativePath,
        fileName: item.fileName,
        kind: item.kind,
        roleFamily: item.inferredRole,
        section,
        text: chunkText,
        keywords: extractKeywords(chunkText),
        lastModified: item.lastModified,
        size: item.size,
      });
      chunkIndex += 1;
    }
  };

  if (item.kind === "cover") {
    const paragraphs = text
      .split(/\n{2,}|(?=\bRe:\s*)/i)
      .map(cleanText)
      .filter((line) => line.length >= 40);
    paragraphs.forEach((paragraph, index) => {
      pushChunk(index === 0 ? "Cover Opening" : "Cover Letter", paragraph);
    });
    return chunks;
  }

  const lines = text
    .split(/\n+|(?=â€¢)|(?=\s[-*]\s)/)
    .map((line) => cleanText(line.replace(/^(?:â€¢|[-*])\s*/, "")))
    .filter((line) => line.length >= 24);
  void lines;
  const sectionBlocks = splitReferenceSectionBlocks(text);

  for (const block of sectionBlocks) {
    let buffer: string[] = [];
    const flush = () => {
      const value = cleanText(buffer.join(" "));
      if (value.length >= 40) pushChunk(block.section, value);
      buffer = [];
    };

    for (const line of block.lines) {
      if (chunks.length >= MAX_REFERENCE_CHUNKS_PER_FILE) break;
      buffer.push(line);
      if (
        block.section === "Experience" ||
        line.length >= 120 ||
        buffer.join(" ").length >= 650
      ) {
        flush();
      }
    }
    flush();
    if (chunks.length >= MAX_REFERENCE_CHUNKS_PER_FILE) break;
  }
  return chunks;
}

export function deduplicateReferenceChunks(
  chunks: ResumeReferenceChunk[],
): ResumeReferenceChunk[] {
  if (chunks.length <= 1) return chunks;
  const seen = new Map<string, ResumeReferenceChunk>();
  for (const chunk of chunks) {
    const text = (chunk.text ?? "").trim();
    if (text.length < 30) {
      seen.set(chunk.id, chunk);
      continue;
    }
    const normalized = text
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .trim();
    const hash = `${normalized.length}:${normalized.slice(0, 80)}:${normalized.slice(-40)}`;
    const existing = seen.get(hash);
    if (!existing) {
      seen.set(hash, chunk);
    } else if (
      (chunk.lastModified ?? 0) > (existing.lastModified ?? 0) ||
      ((chunk.lastModified ?? 0) === (existing.lastModified ?? 0) &&
        chunk.text.length > existing.text.length)
    ) {
      seen.set(hash, chunk);
    }
  }
  return Array.from(seen.values());
}

export function limitReferenceChunks(
  chunks: ResumeReferenceChunk[],
): ResumeReferenceChunk[] {
  if (chunks.length <= MAX_REFERENCE_CHUNKS_PER_SCAN) return chunks;

  const chunksByFile = new Map<string, ResumeReferenceChunk[]>();
  for (const chunk of chunks) {
    const key = chunk.relativePath || chunk.fileName;
    chunksByFile.set(key, [...(chunksByFile.get(key) ?? []), chunk]);
  }

  const selected: ResumeReferenceChunk[] = [];
  let index = 0;
  while (selected.length < MAX_REFERENCE_CHUNKS_PER_SCAN) {
    let added = false;
    for (const fileChunks of chunksByFile.values()) {
      const chunk = fileChunks[index];
      if (!chunk) continue;
      selected.push(chunk);
      added = true;
      if (selected.length >= MAX_REFERENCE_CHUNKS_PER_SCAN) break;
    }
    if (!added) break;
    index += 1;
  }
  return selected;
}

async function inspectFile(file: File): Promise<{
  item: ResumeReferenceItem;
  chunks: ResumeReferenceChunk[];
} | null> {
  const relativePath = getRelativePath(file);
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const kind = classifyKind(relativePath);
  if (!["docx", "pdf"].includes(extension) || kind === "unknown") return null;

  let text = "";
  let pageCount: number | null = null;
  if (extension === "docx") {
    text = await extractDocxText(file).catch(() => "");
  } else {
    text = await file.text().catch(() => "");
    pageCount = countPdfPages(text);
  }

  const sections = detectSections(`${relativePath}\n${text}`);
  const item: ResumeReferenceItem = {
    fileName: file.name,
    relativePath,
    inferredRole: inferRole(relativePath, text),
    kind,
    sections,
    hasSkills: sections.includes("Skills"),
    pageCount,
    lastModified: file.lastModified || null,
    size: file.size || null,
    keywords: extractKeywords(`${relativePath}\n${text}`),
    snippets: extractReferenceSnippets(kind, text),
  };
  return {
    item,
    chunks: buildReferenceChunks(item, text),
  };
}

function buildCoverage(
  items: ResumeReferenceItem[],
): ResumeReferenceScanResult["coverage"] {
  return items.reduce<Record<string, number>>((coverage, item) => {
    coverage[item.inferredRole] = (coverage[item.inferredRole] ?? 0) + 1;
    return coverage;
  }, {});
}

function referenceKey(item: ResumeReferenceItem): string {
  return `${item.relativePath}|${item.size ?? "unknown"}|${item.lastModified ?? "unknown"}`;
}

function referenceIdentity(item: ResumeReferenceItem): string {
  return item.relativePath;
}

function sortNewestFirst(
  a: ResumeReferenceItem,
  b: ResumeReferenceItem,
): number {
  return (
    (b.lastModified ?? 0) - (a.lastModified ?? 0) ||
    a.fileName.localeCompare(b.fileName)
  );
}

export function getResumeReferenceIndexNotice(
  scan: ResumeReferenceScanResult | null,
  now = Date.now(),
): { tone: "warning" | "error"; message: string } | null {
  if (!scan) {
    return {
      tone: "warning",
      message:
        "Reference index unavailable. Re-scan the folder before generating if you want Job Ops to use reference evidence.",
    };
  }
  if (scan.indexStatus === "failed") {
    return {
      tone: "error",
      message: scan.lastIndexError
        ? `Reference index failed to build: ${scan.lastIndexError}`
        : "Reference index failed to build. Re-scan the folder; resume generation will fall back to the master resume until the index is rebuilt.",
    };
  }
  if (scan.indexStatus !== "indexed" && (scan.chunkCount ?? 0) > 0) {
    return {
      tone: "warning",
      message:
        "Reference index was scanned locally but is not searchable yet. Re-scan the folder so Job Ops can save and index the reference evidence.",
    };
  }
  if ((scan.chunkCount ?? 0) === 0) {
    return {
      tone: "warning",
      message:
        "Reference index has no searchable chunks. Re-scan the folder after adding resume or cover letter files.",
    };
  }
  const indexedAt = Date.parse(scan.lastIndexedAt ?? scan.scannedAt);
  if (
    Number.isFinite(indexedAt) &&
    now - indexedAt > REFERENCE_INDEX_STALE_MS
  ) {
    return {
      tone: "warning",
      message:
        "Reference index may be stale. Re-scan after folder changes so Generate Resume uses the latest files.",
    };
  }
  return null;
}

export function isMatchingSavedReferenceScan(
  saved: ResumeReferenceScanResult,
  readback: ResumeReferenceScanResult | null,
): boolean {
  return Boolean(
    readback &&
      readback.scannedAt === saved.scannedAt &&
      readback.activeCount === saved.activeCount &&
      readback.chunkCount === saved.chunkCount &&
      readback.indexedChunkCount === saved.indexedChunkCount &&
      readback.indexStatus === saved.indexStatus,
  );
}

export async function saveConfirmedResumeReferenceScan(
  scan: ResumeReferenceScanResult,
): Promise<ResumeReferenceScanResult> {
  const saved = await api.saveResumeReferenceScan(scan);
  const readback = await api.getResumeReferenceScan();
  if (!readback || !isMatchingSavedReferenceScan(saved, readback)) {
    throw new Error(
      "Reference scan save completed, but Job Ops could not read the same index back.",
    );
  }
  return readback;
}

function formatSaveError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Reference scan was not saved.";
}

function pickRepresentativeResume(
  items: ResumeReferenceItem[],
  roleFamily: string,
): ResumeReferenceItem | null {
  const candidates = items
    .filter((item) => item.inferredRole === roleFamily)
    .filter((item) => item.kind === "resume" || item.kind === "combined");
  const preferred =
    roleFamily === "consulting_strategy"
      ? candidates.filter((item) => item.pageCount === 1)
      : roleFamily === "public_sector_policy_economic_development"
        ? candidates.filter(
            (item) => item.pageCount === null || item.pageCount >= 2,
          )
        : candidates;
  return (
    [...(preferred.length ? preferred : candidates)].sort(sortNewestFirst)[0] ??
    null
  );
}

function pickRepresentativeCover(
  items: ResumeReferenceItem[],
  roleFamily: string,
): ResumeReferenceItem | null {
  return (
    items
      .filter((item) => item.inferredRole === roleFamily)
      .filter((item) => item.kind === "cover" || item.kind === "combined")
      .sort(sortNewestFirst)[0] ?? null
  );
}

export function buildRepresentatives(
  items: ResumeReferenceItem[],
): ResumeReferenceRepresentative[] {
  const roleFamilies = Array.from(
    new Set([...ROLE_FAMILIES, ...items.map((item) => item.inferredRole)]),
  );
  return roleFamilies
    .map((roleFamily) => ({
      roleFamily,
      resume: pickRepresentativeResume(items, roleFamily),
      coverLetter: pickRepresentativeCover(items, roleFamily),
    }))
    .filter(
      (representative) => representative.resume || representative.coverLetter,
    );
}

export function buildWritingGuide(
  representatives: ResumeReferenceRepresentative[],
): NonNullable<ResumeReferenceScanResult["writingGuide"]> {
  const guide: NonNullable<ResumeReferenceScanResult["writingGuide"]> = {};
  for (const representative of representatives) {
    const resume = representative.resume;
    const cover = representative.coverLetter;
    const resumeKeywords = resume?.keywords?.slice(0, 8).join(", ");
    const sourceFiles = [resume?.relativePath, cover?.relativePath].filter(
      (value): value is string => Boolean(value),
    );
    guide[representative.roleFamily] = {
      resumeStyle:
        representative.roleFamily === "consulting_strategy"
          ? "Use compact strategy language, business planning outcomes, executive synthesis, and tight one-page phrasing."
          : representative.roleFamily === "data_analytics_operations"
            ? "Use analyst language around reporting, dashboards, QA, data cleaning, workflow improvement, and decision support."
            : representative.roleFamily ===
                "public_sector_policy_economic_development"
              ? "Use policy and stakeholder language only when the JD supports it; otherwise keep the same evidence in neutral research and planning terms."
              : "Use concise research language around synthesis, evidence review, insights, and recommendations.",
      bulletStyle: resume?.snippets?.experience
        ? `Follow this bullet rhythm without copying domain terms: ${clip(
            resume.snippets.experience,
            420,
          )}`
        : "Use action-result bullets grounded in existing resume evidence.",
      skillsStyle: resumeKeywords
        ? `Prefer short JD-backed skill groups. Common supported signals: ${resumeKeywords}.`
        : "Keep skills short and only include JD-backed, evidence-supported keywords.",
      coverLetterStyle: cover?.snippets?.coverLetter
        ? `Cover letters use this structure: ${clip(
            cover.snippets.coverLetter,
            420,
          )}`
        : "Cover letters should keep the fixed header, To Whom It May Concern, Re line, concise body, and signoff.",
      sourceFiles,
    };
  }
  return guide;
}

function summarize(
  newItems: ResumeReferenceItem[],
  existingItems: ResumeReferenceItem[] = [],
  chunks: ResumeReferenceChunk[] = [],
  dedupedChunkCount = 0,
): ResumeReferenceScanResult {
  const existingByPath = new Map(
    existingItems.map((item) => [referenceIdentity(item), item]),
  );
  const nextByPath = new Map<string, ResumeReferenceItem>();
  for (const item of newItems) {
    nextByPath.set(referenceIdentity(item), item);
  }
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const item of nextByPath.values()) {
    const previous = existingByPath.get(referenceIdentity(item));
    if (!previous) {
      added += 1;
      continue;
    }
    if (referenceKey(previous) === referenceKey(item)) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }
  const removed = existingItems.filter(
    (item) => !nextByPath.has(referenceIdentity(item)),
  ).length;
  const items = Array.from(nextByPath.values()).sort(sortNewestFirst);
  const representatives = buildRepresentatives(items);
  return {
    scannedAt: new Date().toISOString(),
    filesConsidered: newItems.length,
    activeCount: items.length,
    resumeCount: items.filter((item) => item.kind === "resume").length,
    coverLetterCount: items.filter((item) => item.kind === "cover").length,
    combinedCount: items.filter((item) => item.kind === "combined").length,
    chunkCount: chunks.length,
    truncatedChunks: Math.max(0, dedupedChunkCount - chunks.length),
    indexStatus: chunks.length ? "not_indexed" : "not_indexed",
    changeSummary: { added, updated, removed, unchanged },
    coverage: buildCoverage(items),
    items: items.slice(0, MAX_REFERENCE_ITEMS_PER_SCAN),
    chunks,
    representatives,
    writingGuide: buildWritingGuide(representatives),
  };
}

export const ResumeReferencesSection: React.FC<{
  layoutMode?: "accordion" | "panel";
}> = ({ layoutMode = "accordion" }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [scan, setScan] = useState<ResumeReferenceScanResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) setScan(JSON.parse(stored) as ResumeReferenceScanResult);
    } catch {
      setScan(null);
    }
    void api
      .getResumeReferenceScan()
      .then((serverScan) => {
        if (!cancelled && serverScan) {
          setScan(serverScan);
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serverScan));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setIsScanning(true);
    try {
      try {
        const ingestFiles = await Promise.all(
          Array.from(files).map(toIngestFile),
        );
        const readback = await api.ingestResumeReferenceFiles({
          files: ingestFiles,
        });
        setScan(readback);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(readback));
        const diagnostics = readback.ingestionDiagnostics;
        const rawChunkCount = diagnostics?.duplicateChunkRatio
          ? Math.round(
              (diagnostics.chunkCount || 0) /
                Math.max(0.0001, 1 - diagnostics.duplicateChunkRatio),
            )
          : (readback.chunkCount ?? 0);
        const deduped = Math.max(0, rawChunkCount - (readback.chunkCount ?? 0));
        const truncated = readback.truncatedChunks ?? 0;
        if (readback.indexStatus === "indexed") {
          const parts: string[] = [
            `Reference RAG ready: ${(readback.indexedChunkCount ?? readback.chunkCount ?? 0).toLocaleString()} chunks indexed.`,
          ];
          if (deduped > 0) {
            parts.push(`${deduped.toLocaleString()} duplicates removed.`);
          }
          if (truncated > 0) {
            parts.push(`${truncated.toLocaleString()} truncated (18k limit).`);
          }
          toast.success(parts.join(" "));
        } else {
          toast.error(
            readback.lastIndexError
              ? `Reference index failed: ${readback.lastIndexError}`
              : "Reference scan saved, but the RAG index is not ready.",
          );
        }
        if ((diagnostics?.lowQualityFiles.length ?? 0) > 0) {
          toast.warning(
            `${diagnostics?.lowQualityFiles.length.toLocaleString()} files had weak extracted text; check scan diagnostics.`,
          );
        }
        if (truncated > 0) {
          toast.warning(
            `${truncated.toLocaleString()} unique chunks dropped (18k limit).`,
          );
        }
      } catch (error) {
        toast.warning(`Reference scan failed: ${formatSaveError(error)}`);
      }
    } finally {
      setIsScanning(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const coverageEntries = Object.entries(scan?.coverage ?? {});
  const indexNotice = getResumeReferenceIndexNotice(scan);

  return (
    <SettingsSectionFrame
      mode={layoutMode}
      title="Resume References"
      value="resume-references"
    >
      <div className="rounded-lg border border-border/50 bg-muted/5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground/90">
              <FileSearch className="h-4 w-4 text-sky-400/80" />
              Resume References
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Scan your local Job Applications folder so tailoring can search
              the latest resume and cover letter evidence. Each scan replaces
              the local Job Ops reference index with that folder snapshot.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 text-xs"
              onClick={() => inputRef.current?.click()}
              disabled={isScanning}
            >
              {isScanning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FolderOpen className="h-3.5 w-3.5" />
              )}
              Scan folder
            </Button>
            {scan ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => {
                  setScan(null);
                  window.localStorage.removeItem(STORAGE_KEY);
                }}
                aria-label="Clear resume reference scan"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        </div>

        <input
          ref={(node) => {
            inputRef.current = node;
            if (node) {
              (
                node as HTMLInputElement & { webkitdirectory?: boolean }
              ).webkitdirectory = true;
            }
          }}
          type="file"
          multiple
          className="hidden"
          accept=".docx,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
          onChange={(event) => void handleFiles(event.currentTarget.files)}
        />

        {scan ? (
          <div className="mt-4 space-y-3">
            {indexNotice ? (
              <div
                className={cn(
                  "rounded-md border px-3 py-2 text-xs leading-relaxed",
                  indexNotice.tone === "error"
                    ? "border-rose-500/35 bg-rose-500/10 text-rose-200"
                    : "border-amber-500/35 bg-amber-500/10 text-amber-100",
                )}
              >
                {indexNotice.message}
              </div>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-4">
              {(
                [
                  ["Resumes", scan.resumeCount],
                  ["Cover letters", scan.coverLetterCount],
                  ["Combined", scan.combinedCount],
                  ["Indexed files", scan.activeCount ?? scan.items.length],
                ] satisfies Array<[string, number]>
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-md border border-border/35 bg-background/30 px-3 py-2"
                >
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                    {label}
                  </div>
                  <div className="mt-1 text-sm font-semibold tabular-nums text-foreground/85">
                    {value}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {(
                [
                  ["Last scan", new Date(scan.scannedAt).toLocaleString()],
                  [
                    "Last indexed",
                    scan.lastIndexedAt
                      ? new Date(scan.lastIndexedAt).toLocaleString()
                      : "Not indexed",
                  ],
                  ["Indexed chunks", String(scan.chunkCount ?? 0)],
                  ["Index status", scan.indexStatus ?? "not_indexed"],
                  ["Added", String(scan.changeSummary?.added ?? 0)],
                  [
                    "Updated/removed",
                    `${scan.changeSummary?.updated ?? 0}/${scan.changeSummary?.removed ?? 0}`,
                  ],
                ] satisfies Array<[string, string]>
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-md border border-border/35 bg-background/20 px-3 py-2"
                >
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                    {label}
                  </div>
                  <div className="mt-1 truncate text-xs font-medium text-foreground/80">
                    {value}
                  </div>
                </div>
              ))}
            </div>

            {scan.ingestionDiagnostics ? (
              <div className="rounded-md border border-border/35 bg-background/25 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Server ingestion diagnostics
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {(
                    [
                      [
                        "Parsed files",
                        `${scan.ingestionDiagnostics.parsedFiles}/${scan.ingestionDiagnostics.totalFiles}`,
                      ],
                      [
                        "Clusters",
                        String(scan.ingestionDiagnostics.clusterCount),
                      ],
                      [
                        "Duplicate ratio",
                        `${Math.round(scan.ingestionDiagnostics.duplicateChunkRatio * 100)}%`,
                      ],
                      [
                        "Weak text",
                        String(
                          scan.ingestionDiagnostics.lowQualityFiles.length,
                        ),
                      ],
                      [
                        "OCR used",
                        String(scan.ingestionDiagnostics.ocrFileCount ?? 0),
                      ],
                      [
                        "Partial OCR",
                        String(
                          scan.ingestionDiagnostics.partialOcrFileCount ?? 0,
                        ),
                      ],
                      [
                        "Empty text",
                        String(scan.ingestionDiagnostics.emptyTextFiles.length),
                      ],
                      [
                        "Skipped",
                        String(scan.ingestionDiagnostics.skippedFiles.length),
                      ],
                    ] satisfies Array<[string, string]>
                  ).map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-md border border-border/30 bg-muted/10 px-3 py-2"
                    >
                      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                        {label}
                      </div>
                      <div className="mt-1 text-xs font-semibold tabular-nums text-foreground/85">
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
                {scan.ingestionDiagnostics.extractorCounts ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(
                      scan.ingestionDiagnostics.extractorCounts,
                    ).map(([extractor, count]) => (
                      <Badge
                        key={extractor}
                        variant="secondary"
                        className="rounded-md text-[11px]"
                      >
                        {extractor}: {count}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {scan.ingestionDiagnostics.missingDependencies?.length ? (
                  <div className="mt-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
                    Missing local extraction tools:{" "}
                    {scan.ingestionDiagnostics.missingDependencies.join(", ")}.
                    Docker installs these automatically; local Windows scans
                    will use lightweight fallback until those tools are
                    installed.
                  </div>
                ) : null}
                {scan.ingestionDiagnostics.lowQualityFiles.length ||
                scan.ingestionDiagnostics.emptyTextFiles.length ? (
                  <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Files with weak or empty extracted text may be scanned PDFs
                    or heavily compressed documents. They are saved in
                    diagnostics so the backend can be upgraded to OCR/Poppler
                    without changing the resume generation flow.
                  </div>
                ) : null}
              </div>
            ) : null}

            {coverageEntries.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {coverageEntries.map(([role, count]) => (
                  <Badge
                    key={role}
                    variant="secondary"
                    className="rounded-md text-[11px]"
                  >
                    {role}: {count}
                  </Badge>
                ))}
              </div>
            ) : null}

            {scan.representatives?.length ? (
              <div className="rounded-md border border-border/35 bg-background/25 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Representative References
                </div>
                <div className="mt-2 grid gap-2 lg:grid-cols-2">
                  {scan.representatives.map((representative) => (
                    <div
                      key={representative.roleFamily}
                      className="rounded-md border border-border/30 bg-muted/10 px-3 py-2 text-xs"
                    >
                      <div className="font-medium text-foreground/85">
                        {ROLE_LABELS[representative.roleFamily] ??
                          representative.roleFamily}
                      </div>
                      <div className="mt-1 truncate text-muted-foreground">
                        Resume: {representative.resume?.fileName ?? "Not found"}
                      </div>
                      <div className="truncate text-muted-foreground">
                        Cover:{" "}
                        {representative.coverLetter?.fileName ?? "Not found"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-md border border-border/35">
              {scan.items.slice(0, 8).map((item, index) => (
                <div
                  key={`${item.relativePath}-${index}`}
                  className={cn(
                    "grid gap-2 px-3 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_130px_160px]",
                    index > 0 && "border-t border-border/35",
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground/85">
                      {item.fileName}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground/60">
                      {item.relativePath}
                    </div>
                  </div>
                  <div className="text-muted-foreground">{item.kind}</div>
                  <div className="truncate text-muted-foreground">
                    {item.sections.length
                      ? item.sections.join(", ")
                      : "No sections found"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-md border border-border/35 bg-background/30 px-3 py-2 text-xs text-muted-foreground">
            No local references scanned yet.
          </div>
        )}
      </div>
    </SettingsSectionFrame>
  );
};
