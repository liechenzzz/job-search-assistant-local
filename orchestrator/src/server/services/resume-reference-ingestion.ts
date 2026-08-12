import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ResumeReferenceChunk,
  ResumeReferenceIngestFile,
  ResumeReferenceRepresentative,
  ResumeReferenceScanItem,
  ResumeReferenceScanResult,
} from "@shared/types";
import JSZip from "jszip";
import { z } from "zod";

const MAX_REFERENCE_ITEMS_PER_SCAN = 600;
const MAX_REFERENCE_CHUNKS_PER_FILE = 180;
const MAX_REFERENCE_CHUNKS_PER_SCAN = 18_000;
const TARGET_REFERENCE_CHUNK_LENGTH = 420;
const MAX_REFERENCE_CHUNK_LENGTH = 700;
const LOW_QUALITY_TEXT_LENGTH = 300;
const OCR_PAGE_LIMIT = 12;
const COMMAND_TIMEOUT_MS = 60_000;

const execFile = promisify(execFileCallback);

type EvidenceExtractor =
  | "docx_xml"
  | "poppler_text"
  | "tesseract_ocr"
  | "lightweight_pdf_fallback";
type ExtractorCounts = Partial<Record<EvidenceExtractor, number>>;

type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

type IngestionOptions = {
  runCommand?: CommandRunner;
  ocrPageLimit?: number;
};

type ParsedFileText = {
  text: string;
  pageCount: number | null;
  confidence: "high" | "medium" | "low";
  reason: string;
  extractor: EvidenceExtractor;
  ocrUsed: boolean;
  missingDependencies: string[];
  partialOcr?: boolean;
  ocrPageLimit?: number;
};

const ROLE_FAMILIES = [
  "consulting_strategy",
  "public_sector_policy_economic_development",
  "data_analytics_operations",
  "market_insights_research",
] as const;

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

const ingestFileSchema = z.object({
  fileName: z.string().min(1).max(255),
  relativePath: z.string().min(1).max(1000).optional(),
  kind: z.enum(["resume", "cover", "combined", "unknown"]).optional(),
  contentBase64: z.string().min(1),
  mimeType: z.string().max(255).nullable().optional(),
  lastModified: z.number().int().positive().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

export const resumeReferenceIngestionSchema = z.object({
  files: z.array(ingestFileSchema).min(1).max(MAX_REFERENCE_ITEMS_PER_SCAN),
});

type ParsedIngestFile = z.infer<typeof ingestFileSchema>;

type IngestedFile = {
  item: ResumeReferenceScanItem;
  chunks: ResumeReferenceChunk[];
  textLength: number;
};

export async function ingestResumeReferenceFiles(
  input: unknown,
  existingItems: ResumeReferenceScanItem[] = [],
  options: IngestionOptions = {},
): Promise<ResumeReferenceScanResult> {
  const parsed = resumeReferenceIngestionSchema.parse(input);
  const skippedFiles: NonNullable<
    ResumeReferenceScanResult["ingestionDiagnostics"]
  >["skippedFiles"] = [];
  const emptyTextFiles: NonNullable<
    ResumeReferenceScanResult["ingestionDiagnostics"]
  >["emptyTextFiles"] = [];
  const lowQualityFiles: NonNullable<
    ResumeReferenceScanResult["ingestionDiagnostics"]
  >["lowQualityFiles"] = [];
  const fileDiagnostics: NonNullable<
    ResumeReferenceScanResult["ingestionDiagnostics"]
  >["fileDiagnostics"] = [];
  const ingested: IngestedFile[] = [];

  for (const file of parsed.files) {
    const relativePath = file.relativePath || file.fileName;
    const extension = file.fileName.split(".").pop()?.toLowerCase() ?? "";
    const kind = file.kind ?? classifyKind(relativePath);
    if (!["docx", "pdf"].includes(extension) || kind === "unknown") {
      skippedFiles.push({
        fileName: file.fileName,
        relativePath,
        reason:
          kind === "unknown"
            ? "File name does not look like a resume, cover letter, or combined package."
            : "Unsupported file type.",
      });
      continue;
    }

    const parsedText = await extractFileText(file, extension, options);
    fileDiagnostics.push({
      fileName: file.fileName,
      relativePath,
      extractor: parsedText.extractor,
      ocrUsed: parsedText.ocrUsed,
      pageCount: parsedText.pageCount,
      textLength: parsedText.text.length,
      missingDependencies: parsedText.missingDependencies,
      reason: parsedText.reason,
      partialOcr: parsedText.partialOcr,
      ocrPageLimit: parsedText.ocrPageLimit,
    });
    if (!parsedText.text.trim()) {
      emptyTextFiles.push({
        fileName: file.fileName,
        relativePath,
        reason: parsedText.reason,
      });
      continue;
    }

    if (
      parsedText.text.length < LOW_QUALITY_TEXT_LENGTH ||
      parsedText.confidence === "low"
    ) {
      lowQualityFiles.push({
        fileName: file.fileName,
        relativePath,
        reason: parsedText.reason,
        textLength: parsedText.text.length,
      });
    }

    const item = buildReferenceItem(file, relativePath, kind, parsedText);
    ingested.push({
      item,
      chunks: buildReferenceChunks(item, parsedText.text),
      textLength: parsedText.text.length,
    });
  }

  const rawChunks = ingested.flatMap((entry) => entry.chunks);
  const dedupedChunks = deduplicateReferenceChunks(rawChunks);
  const chunks = limitReferenceChunks(dedupedChunks);
  const clusters = new Set(chunks.map((chunk) => buildClusterId(chunk)));
  const items = ingested.map((entry) => entry.item);
  const extractorCounts = fileDiagnostics.reduce<ExtractorCounts>((counts, diagnostic) => {
    counts[diagnostic.extractor] = (counts[diagnostic.extractor] ?? 0) + 1;
    return counts;
  }, {});
  const missingDependencies = Array.from(
    new Set(fileDiagnostics.flatMap((diagnostic) => diagnostic.missingDependencies)),
  ).sort();
  return summarize(items, existingItems, chunks, dedupedChunks.length, {
    totalFiles: parsed.files.length,
    parsedFiles: ingested.length,
    skippedFiles,
    emptyTextFiles,
    lowQualityFiles,
    duplicateChunkRatio: rawChunks.length
      ? Number(((rawChunks.length - dedupedChunks.length) / rawChunks.length).toFixed(4))
      : 0,
    clusterCount: clusters.size,
    chunkCount: chunks.length,
    extractorCounts,
    ocrFileCount: fileDiagnostics.filter((diagnostic) => diagnostic.ocrUsed).length,
    partialOcrFileCount: fileDiagnostics.filter(
      (diagnostic) => diagnostic.partialOcr,
    ).length,
    missingDependencies,
    fileDiagnostics,
    parser: "server",
  });
}

function classifyKind(path: string): ResumeReferenceScanItem["kind"] {
  const lower = path.toLowerCase();
  const fileName = lower.split(/[\\/]/).pop() ?? lower;
  if (/cover|letter/.test(fileName)) return "cover";
  if (/resume|cv/.test(fileName)) return "resume";
  if (/combined|package|application/.test(fileName)) return "combined";
  if (/cover|letter/.test(lower)) return "cover";
  if (/resume|cv/.test(lower)) return "resume";
  if (/combined|package|application/.test(lower)) return "combined";
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

  const rules: Array<{
    role: RoleId;
    pathPattern: RegExp;
    textPattern: RegExp;
  }> = [
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
      return diff || scores[b].pathHits - scores[a].pathHits;
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

function decodeBase64(contentBase64: string): Buffer {
  const normalized = contentBase64.includes(",")
    ? contentBase64.slice(contentBase64.indexOf(",") + 1)
    : contentBase64;
  return Buffer.from(normalized, "base64");
}

async function extractFileText(
  file: ParsedIngestFile,
  extension: string,
  options: IngestionOptions,
): Promise<ParsedFileText> {
  const buffer = decodeBase64(file.contentBase64);
  if (extension === "docx") {
    const text = await extractDocxText(buffer).catch(() => "");
    return {
      text,
      pageCount: null,
      confidence: text.length >= LOW_QUALITY_TEXT_LENGTH ? "high" : "medium",
      reason: text ? "DOCX text extracted from word/document.xml." : "DOCX document.xml text was empty.",
      extractor: "docx_xml",
      ocrUsed: false,
      missingDependencies: [],
    };
  }

  return await extractPdfTextWithFallback(buffer, options);
}

async function extractPdfTextWithFallback(
  buffer: Buffer,
  options: IngestionOptions,
): Promise<ParsedFileText> {
  const commandRunner = options.runCommand ?? runCommand;
  const pageCount = countPdfPages(buffer);
  const missingDependencies = new Set<string>();
  const popplerText = await extractPdfTextWithPoppler(buffer, commandRunner);
  for (const dependency of popplerText.missingDependencies) {
    missingDependencies.add(dependency);
  }
  if (popplerText.text.length >= LOW_QUALITY_TEXT_LENGTH) {
    return {
      text: popplerText.text,
      pageCount,
      confidence: "high",
      reason: "PDF text extracted with Poppler pdftotext.",
      extractor: "poppler_text",
      ocrUsed: false,
      missingDependencies: Array.from(missingDependencies).sort(),
    };
  }

  const ocrText = await extractPdfTextWithOcr(
    buffer,
    commandRunner,
    options.ocrPageLimit ?? OCR_PAGE_LIMIT,
    pageCount,
  );
  for (const dependency of ocrText.missingDependencies) {
    missingDependencies.add(dependency);
  }
  if (ocrText.text.length >= 40) {
    return {
      text: ocrText.text,
      pageCount,
      confidence: ocrText.text.length >= LOW_QUALITY_TEXT_LENGTH ? "medium" : "low",
      reason: ocrText.reason,
      extractor: "tesseract_ocr",
      ocrUsed: true,
      missingDependencies: Array.from(missingDependencies).sort(),
      partialOcr: ocrText.partialOcr,
      ocrPageLimit: ocrText.ocrPageLimit,
    };
  }

  const text = extractPdfTextLightweight(buffer);
  return {
    text,
    pageCount,
    confidence: text.length >= LOW_QUALITY_TEXT_LENGTH ? "medium" : "low",
    reason: text
      ? "PDF text extracted with lightweight embedded stream fallback."
      : "PDF appears scanned, compressed, or otherwise has no embedded text.",
    extractor: "lightweight_pdf_fallback",
    ocrUsed: false,
    missingDependencies: Array.from(missingDependencies).sort(),
  };
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) return "";
  return decodeXmlText(documentXml)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, " ")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function countPdfPages(buffer: Buffer): number | null {
  const latin = buffer.toString("latin1");
  return latin.match(/\/Type\s*\/Page\b/g)?.length ?? null;
}

async function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return await execFile(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
}

async function withTempPdf<T>(
  buffer: Buffer,
  callback: (inputPath: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jobops-reference-pdf-"));
  const inputPath = join(dir, "input.pdf");
  try {
    await writeFile(inputPath, buffer);
    return await callback(inputPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function commandMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return maybeCode === "ENOENT" || /not recognized|not found|ENOENT/i.test(error.message);
}

async function extractPdfTextWithPoppler(
  buffer: Buffer,
  run: CommandRunner,
): Promise<{ text: string; missingDependencies: string[] }> {
  try {
    const text = await withTempPdf(buffer, async (inputPath) => {
      const result = await run("pdftotext", [
        "-layout",
        "-enc",
        "UTF-8",
        inputPath,
        "-",
      ]);
      return typeof result.stdout === "string"
        ? result.stdout
        : result.stdout.toString("utf8");
    });
    return { text: cleanLineText(text), missingDependencies: [] };
  } catch (error) {
    return {
      text: "",
      missingDependencies: commandMissing(error) ? ["pdftotext"] : [],
    };
  }
}

async function extractPdfTextWithOcr(
  buffer: Buffer,
  run: CommandRunner,
  ocrPageLimit: number,
  pageCount: number | null,
): Promise<{
  text: string;
  missingDependencies: string[];
  reason: string;
  partialOcr?: boolean;
  ocrPageLimit?: number;
}> {
  const missingDependencies = new Set<string>();
  const boundedPageLimit = Math.max(1, Math.min(ocrPageLimit, OCR_PAGE_LIMIT));
  const partialOcr =
    typeof pageCount === "number" && pageCount > boundedPageLimit
      ? true
      : undefined;
  try {
    const text = await withTempPdf(buffer, async (inputPath, dir) => {
      const outputPrefix = join(dir, "page");
      try {
        await run("pdftoppm", [
          "-f",
          "1",
          "-l",
          String(boundedPageLimit),
          "-r",
          "200",
          "-png",
          inputPath,
          outputPrefix,
        ]);
      } catch (error) {
        if (commandMissing(error)) missingDependencies.add("pdftoppm");
        return "";
      }

      const imageFiles = (await readdir(dir))
        .filter((name) => /^page-\d+\.png$/i.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const pages: string[] = [];
      for (const imageFile of imageFiles) {
        try {
          const result = await run("tesseract", [
            join(dir, imageFile),
            "stdout",
            "-l",
            "eng",
            "--psm",
            "6",
          ]);
          const pageText =
            typeof result.stdout === "string"
              ? result.stdout
              : result.stdout.toString("utf8");
          pages.push(pageText);
        } catch (error) {
          if (commandMissing(error)) {
            missingDependencies.add("tesseract");
            break;
          }
        }
      }
      return cleanLineText(pages.join("\n\n"));
    });
    return {
      text,
      missingDependencies: Array.from(missingDependencies).sort(),
      reason: partialOcr
        ? `PDF OCR extracted with Tesseract from the first ${boundedPageLimit} pages.`
        : "PDF OCR extracted with Tesseract.",
      partialOcr,
      ocrPageLimit: boundedPageLimit,
    };
  } catch (error) {
    if (commandMissing(error)) missingDependencies.add("pdftoppm");
    return {
      text: "",
      missingDependencies: Array.from(missingDependencies).sort(),
      reason: "PDF OCR could not run locally.",
      partialOcr,
      ocrPageLimit: boundedPageLimit,
    };
  }
}

function extractPdfTextLightweight(buffer: Buffer): string {
  const latin = buffer.toString("latin1");
  const literalStrings = Array.from(latin.matchAll(/\((?:\\.|[^\\)]){2,500}\)/g))
    .map((match) => decodePdfLiteral(match[0]))
    .filter((value) => /[A-Za-z]{3,}/.test(value));
  const utf8Readable = buffer
    .toString("utf8")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const text = cleanLineText(
    [...literalStrings, utf8Readable.length > 80 ? utf8Readable : ""]
      .filter(Boolean)
      .join("\n"),
  );
  return text.length > 20 ? text : "";
}

function decodePdfLiteral(value: string): string {
  return value
    .slice(1, -1)
    .replace(/\\([nrtbf()\\])/g, (_match, escaped: string) => {
      if (escaped === "n" || escaped === "r") return "\n";
      if (escaped === "t") return "\t";
      if (escaped === "b" || escaped === "f") return " ";
      return escaped;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    )
    .replace(/\s+/g, " ")
    .trim();
}

function buildReferenceItem(
  file: ParsedIngestFile,
  relativePath: string,
  kind: ResumeReferenceScanItem["kind"],
  parsedText: { text: string; pageCount: number | null },
): ResumeReferenceScanItem {
  const sections = detectSections(`${relativePath}\n${parsedText.text}`);
  return {
    fileName: file.fileName,
    relativePath,
    inferredRole: inferRole(relativePath, parsedText.text),
    kind,
    sections,
    hasSkills: sections.includes("Skills"),
    pageCount: parsedText.pageCount,
    lastModified: file.lastModified ?? null,
    size: file.size ?? null,
    keywords: extractKeywords(`${relativePath}\n${parsedText.text}`),
    snippets: extractReferenceSnippets(kind, parsedText.text),
  };
}

function detectSections(text: string): string[] {
  const found = SECTION_PATTERNS.filter(([, pattern]) =>
    pattern.test(text),
  ).map(([label]) => label);
  return Array.from(new Set(found));
}

function extractKeywords(text: string): string[] {
  const found = KEYWORD_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([label]) => label,
  );
  const acronyms = text.match(/\b[A-Z]{2,6}\b/g) ?? [];
  return Array.from(new Set([...found, ...acronyms])).slice(0, 30);
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function cleanLineText(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000/g, "")
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
  kind: ResumeReferenceScanItem["kind"],
  text: string,
): ResumeReferenceScanItem["snippets"] {
  const normalized = cleanText(text);
  if (!normalized) return {};

  if (kind === "cover") {
    const reLine = normalized.match(/\bRe:\s*[^.]{1,180}/i)?.[0] ?? "";
    return {
      coverLetter: clip([normalized.slice(0, 500), reLine].filter(Boolean).join(" "), 800),
    };
  }

  const summaryMatch =
    normalized.match(/\b(?:summary|profile|objective)\b[:\s-]+(.{80,500})/i)?.[1] ??
    normalized.slice(0, 420);
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

function createChunkId(relativePath: string, section: string, index: number): string {
  const pathHash = createHash("sha1").update(relativePath).digest("hex").slice(0, 10);
  const slug = section.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${pathHash}#${slug}-${index}`;
}

const SECTION_HEADING_PATTERNS: Array<[string, RegExp]> = [
  ["Summary", /^(?:summary|professional summary|profile|professional profile|objective)$/i],
  ["Skills", /^(?:skills|technical skills|core competencies|key skills|competencies)$/i],
  [
    "Experience",
    /^(?:experience|professional experience|work experience|work history|employment history|relevant experience)$/i,
  ],
  ["Projects", /^(?:projects|selected projects|portfolio|project experience)$/i],
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
    .split(/\n+|(?=•)|(?=â€¢)|(?=\s[-*]\s)/)
    .map((line) => cleanText(line.replace(/^(?:•|â€¢|[-*])\s*/, "")))
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
  item: ResumeReferenceScanItem,
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
        rawText: chunkText,
        normalizedText: normalizeClusterText(chunkText),
        keywords: extractKeywords(chunkText),
        clusterId: buildClusterId({ ...item, section, text: chunkText }),
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
    paragraphs.forEach((paragraph, index) =>
      pushChunk(index === 0 ? "Cover Opening" : "Cover Letter", paragraph),
    );
    return chunks;
  }

  const legacyLines = text
    .split(/\n+|(?=•)|(?=\s[-*]\s)/)
    .map((line) => cleanText(line.replace(/^(?:•|[-*])\s*/, "")))
    .filter((line) => line.length >= 24);
  void legacyLines;
  for (const block of splitReferenceSectionBlocks(text)) {
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

function buildClusterId(input: Pick<ResumeReferenceChunk, "section" | "text">): string {
  return createHash("sha1")
    .update(`${input.section}:${normalizeClusterText(input.text)}`)
    .digest("hex")
    .slice(0, 16);
}

function normalizeClusterText(text: string): string {
  return cleanText(text)
    .toLowerCase()
    .replace(/\b\d{4}\b/g, "")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g, "")
    .replace(/[^a-z0-9+#.% ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deduplicateReferenceChunks(
  chunks: ResumeReferenceChunk[],
): ResumeReferenceChunk[] {
  if (chunks.length <= 1) return chunks;
  const seen = new Map<string, ResumeReferenceChunk>();
  for (const chunk of chunks) {
    const normalized = normalizeClusterText(chunk.text);
    if (normalized.length < 30) {
      seen.set(chunk.id, chunk);
      continue;
    }
    const hash = `${chunk.section}:${normalized.length}:${normalized.slice(0, 120)}:${normalized.slice(-60)}`;
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

function buildCoverage(items: ResumeReferenceScanItem[]): ResumeReferenceScanResult["coverage"] {
  return items.reduce<Record<string, number>>((coverage, item) => {
    coverage[item.inferredRole] = (coverage[item.inferredRole] ?? 0) + 1;
    return coverage;
  }, {});
}

function referenceKey(item: ResumeReferenceScanItem): string {
  return `${item.relativePath}|${item.size ?? "unknown"}|${item.lastModified ?? "unknown"}`;
}

function sortNewestFirst(
  a: ResumeReferenceScanItem,
  b: ResumeReferenceScanItem,
): number {
  return (b.lastModified ?? 0) - (a.lastModified ?? 0) || a.fileName.localeCompare(b.fileName);
}

function pickRepresentativeResume(
  items: ResumeReferenceScanItem[],
  roleFamily: string,
): ResumeReferenceScanItem | null {
  const candidates = items
    .filter((item) => item.inferredRole === roleFamily)
    .filter((item) => item.kind === "resume" || item.kind === "combined");
  const preferred =
    roleFamily === "consulting_strategy"
      ? candidates.filter((item) => item.pageCount === 1)
      : roleFamily === "public_sector_policy_economic_development"
        ? candidates.filter((item) => item.pageCount === null || item.pageCount >= 2)
        : candidates;
  return [...(preferred.length ? preferred : candidates)].sort(sortNewestFirst)[0] ?? null;
}

function pickRepresentativeCover(
  items: ResumeReferenceScanItem[],
  roleFamily: string,
): ResumeReferenceScanItem | null {
  return (
    items
      .filter((item) => item.inferredRole === roleFamily)
      .filter((item) => item.kind === "cover" || item.kind === "combined")
      .sort(sortNewestFirst)[0] ?? null
  );
}

export function buildRepresentatives(
  items: ResumeReferenceScanItem[],
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
    .filter((representative) => representative.resume || representative.coverLetter);
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
  newItems: ResumeReferenceScanItem[],
  existingItems: ResumeReferenceScanItem[] = [],
  chunks: ResumeReferenceChunk[] = [],
  dedupedChunkCount = 0,
  ingestionDiagnostics: NonNullable<ResumeReferenceScanResult["ingestionDiagnostics"]>,
): ResumeReferenceScanResult {
  const existingByPath = new Map(
    existingItems.map((item) => [item.relativePath, item]),
  );
  const nextByPath = new Map<string, ResumeReferenceScanItem>();
  for (const item of newItems) {
    nextByPath.set(item.relativePath, item);
  }
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const item of nextByPath.values()) {
    const previous = existingByPath.get(item.relativePath);
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
    (item) => !nextByPath.has(item.relativePath),
  ).length;
  const items = Array.from(nextByPath.values()).sort(sortNewestFirst);
  const representatives = buildRepresentatives(items);
  return {
    scannedAt: new Date().toISOString(),
    filesConsidered: ingestionDiagnostics.totalFiles,
    activeCount: items.length,
    resumeCount: items.filter((item) => item.kind === "resume").length,
    coverLetterCount: items.filter((item) => item.kind === "cover").length,
    combinedCount: items.filter((item) => item.kind === "combined").length,
    chunkCount: chunks.length,
    truncatedChunks: Math.max(0, dedupedChunkCount - chunks.length),
    indexStatus: "not_indexed",
    changeSummary: { added, updated, removed, unchanged },
    coverage: buildCoverage(items),
    items: items.slice(0, MAX_REFERENCE_ITEMS_PER_SCAN),
    chunks,
    representatives,
    ingestionDiagnostics,
    writingGuide: buildWritingGuide(representatives),
  };
}
