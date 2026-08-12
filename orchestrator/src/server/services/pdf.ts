/**
 * Service for generating PDF resumes from the local Design Resume when available,
 * falling back to the configured Reactive Resume base resume otherwise.
 */

import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, type AppErrorCode, notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import { getSetting } from "@server/repositories/settings";
import type { DomainGateResidual } from "@shared/jd-domain-gate.js";
import { applyDomainGateToExperience } from "@shared/jd-domain-gate.js";
import { buildJdKeywordProfile } from "@shared/jd-keyword-profile.js";
import { formatResumeGenerationDecisionMarker } from "@shared/resume-generation-decision.js";
import { settingsRegistry } from "@shared/settings-registry";
import type {
  DesignResumePdfResponse,
  DesignResumeVariant,
  JdKeywordProfile,
  PdfRenderer,
  ResumeGenerationDecision,
  ResumeOutputMode,
  TailoredExperienceItem,
} from "@shared/types";
import JSZip from "jszip";
import {
  getCurrentDesignResume,
  getDesignResumeForTargetPages,
} from "./design-resume";
import { compactDesignResumeJson } from "./design-resume/compact";
import { resolveWritingOutputLanguageForResumeJson } from "./output-language";
import {
  getLegacyJobPdfPath,
  getTenantDesignResumePdfPath,
  getTenantJobDocxPath,
  getTenantJobHtmlPath,
  getTenantJobPdfPath,
  getTenantPdfDir,
} from "./pdf-storage";
import type { LatexResumeLayout } from "./resume-renderer";
import {
  DomainGateResidualError,
  normalizeResumeJsonToLatexDocument,
  renderResumePdf,
} from "./resume-renderer";
import {
  deleteResume as deleteRxResume,
  exportResumePdf as exportRxResumePdf,
  getResume as getRxResume,
  importResume as importRxResume,
  type PreparedRxResumePdfPayload,
  prepareTailoredResumeForPdf,
} from "./rxresume";
import { getConfiguredRxResumeBaseResumeId } from "./rxresume/baseResumeId";
import {
  mergeReactiveResumeV5Content,
  prepareReactiveResumeV5DocumentForExternalUse,
} from "./rxresume/document";
import { parseV5ResumeData } from "./rxresume/schema/v5";
import { getWritingStyle } from "./writing-style";

export interface PdfResult {
  success: boolean;
  pdfPath?: string;
  error?: string;
  errorCode?: AppErrorCode;
  warnings?: string[];
  jdKeywordProfile?: JdKeywordProfile;
  domainGateResiduals?: DomainGateResidual[];
}

export interface DocxResult {
  success: boolean;
  docxPath?: string;
  error?: string;
  errorCode?: AppErrorCode;
  jdKeywordProfile?: JdKeywordProfile;
}

export interface HtmlResult {
  success: boolean;
  htmlPath?: string;
  error?: string;
  errorCode?: AppErrorCode;
  jdKeywordProfile?: JdKeywordProfile;
}

export interface TailoredPdfContent {
  summary?: string | null;
  headline?: string | null;
  skills?: Array<{ name: string; keywords: string[] }> | null;
  experience?: TailoredExperienceItem[] | string | null;
  jdKeywordProfile?: JdKeywordProfile | string | null;
}

export interface GeneratePdfOptions {
  tracerLinksEnabled?: boolean;
  requestOrigin?: string | null;
  tracerCompanyName?: string | null;
  resumeTargetPages?: 1 | 2;
  jobTitle?: string | null;
  jobEmployer?: string | null;
  resumeDecision?: ResumeGenerationDecision;
}

async function ensureOutputDir(): Promise<void> {
  const outputDir = getTenantPdfDir();
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }
}

function sanitizePdfFileName(value: string): string {
  const base = value
    .trim()
    .replace(/\.pdf$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return `${base || "Design_Resume"}.pdf`;
}

async function resolvePdfRenderer(): Promise<PdfRenderer> {
  const storedValue = await getSetting("pdfRenderer");
  return (
    settingsRegistry.pdfRenderer.parse(storedValue ?? undefined) ??
    settingsRegistry.pdfRenderer.default()
  );
}

async function resolveResumeOutputMode(): Promise<ResumeOutputMode> {
  const storedValue = await getSetting("resumeOutputMode");
  return (
    settingsRegistry.resumeOutputMode.parse(storedValue ?? undefined) ??
    settingsRegistry.resumeOutputMode.default()
  );
}

async function resolveLatexResumeLanguage(resumeJson: Record<string, unknown>) {
  const writingStyle = await getWritingStyle();
  return resolveWritingOutputLanguageForResumeJson({
    style: writingStyle,
    resumeJson,
  }).language;
}

async function countPdfPages(outputPath: string): Promise<number | null> {
  try {
    const contents = await readFile(outputPath, "latin1");
    const matches = contents.match(/\/Type\s*\/Page\b/g);
    return matches?.length ?? null;
  } catch (error) {
    logger.warn("Failed to count generated PDF pages", {
      outputPath,
      error,
    });
    return null;
  }
}

function targetPagesForDesignResumeVariant(
  variant?: DesignResumeVariant,
): 1 | 2 {
  return variant === "one_page" ? 1 : 2;
}

async function downloadRxResumePdf(
  url: string,
  outputPath: string,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Reactive Resume PDF download failed with HTTP ${response.status}.`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(outputPath, bytes);
}

async function renderRxResumePdf(args: {
  preparedResume: PreparedRxResumePdfPayload;
  outputPath: string;
  jobId: string;
  name?: string;
  requestOrigin?: string | null;
}): Promise<void> {
  const { preparedResume, outputPath, jobId } = args;
  let importedResumeId: string | null = null;
  const importData = prepareReactiveResumeV5DocumentForExternalUse(
    preparedResume.data,
    {
      requestOrigin: args.requestOrigin ?? null,
    },
  );

  try {
    importedResumeId = await importRxResume({
      name: args.name?.trim() || `JobOps Tailored Resume ${jobId}`,
      data: importData,
    });

    const downloadUrl = await exportRxResumePdf(importedResumeId);
    if (!downloadUrl || typeof downloadUrl !== "string") {
      throw new Error(
        "Reactive Resume did not return a PDF download URL. Please ensure your Reactive Resume API key and instance URL are configured correctly in Settings.",
      );
    }
    await downloadRxResumePdf(downloadUrl, outputPath);
  } finally {
    if (importedResumeId) {
      try {
        await deleteRxResume(importedResumeId);
      } catch (error) {
        logger.warn("Failed to clean up temporary Reactive Resume PDF export", {
          jobId,
          importedResumeId,
          error,
        });
      }
    }
  }
}

async function renderPreparedPdf(args: {
  renderer: PdfRenderer;
  preparedResume: PreparedRxResumePdfPayload;
  outputPath: string;
  jobId: string;
  name?: string;
  requestOrigin?: string | null;
  jdKeywordProfile?: JdKeywordProfile | null;
  layout?: LatexResumeLayout;
}): Promise<void> {
  if (args.renderer === "latex") {
    const language = await resolveLatexResumeLanguage(args.preparedResume.data);
    await renderResumePdf({
      resumeJson: args.preparedResume.data,
      outputPath: args.outputPath,
      jobId: args.jobId,
      language,
      jdKeywordProfile: args.jdKeywordProfile ?? null,
      layout: args.layout,
    });
    return;
  }

  await renderRxResumePdf({
    preparedResume: args.preparedResume,
    outputPath: args.outputPath,
    jobId: args.jobId,
    name: args.name,
    requestOrigin: args.requestOrigin ?? null,
  });
}

function initialLatexLayoutForTarget(
  targetPages: 1 | 2 | undefined,
): LatexResumeLayout | undefined {
  return targetPages === 1 ? "one-page-compact" : undefined;
}

function latexFallbackLayoutsForTarget(
  targetPages: 1 | 2,
): LatexResumeLayout[] {
  return targetPages === 1
    ? ["one-page-ultra-compact"]
    : ["two-page-compact", "two-page-ultra-compact"];
}

function classifyPdfGenerationError(error: unknown): AppErrorCode {
  if (error instanceof DomainGateResidualError) {
    return "UNPROCESSABLE_ENTITY";
  }

  if (error instanceof AppError) {
    return error.code;
  }

  if (
    error instanceof Error &&
    /Reactive Resume|RxResume/i.test(error.message)
  ) {
    return "UPSTREAM_ERROR";
  }

  if (error instanceof Error && error.name === "AbortError") {
    return "REQUEST_TIMEOUT";
  }

  return "INTERNAL_ERROR";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(value: string): string {
  return escapeXml(value);
}

type WordRun = {
  text?: string;
  bold?: boolean;
  italic?: boolean;
  tab?: boolean;
  font?: string;
  size?: number;
};

type WordParagraphOptions = {
  style?: string;
  keepNext?: boolean;
  keepLines?: boolean;
  alignment?: "center" | "left" | "right";
  borderBottom?: { size: number; space: number; color: string };
  numId?: number;
  indentLeft?: number;
  hanging?: number;
  tabs?: boolean;
  tabPosition?: number;
  spacingBefore?: number;
  spacingAfter?: number;
  spacingLine?: number;
  lineRule?: "auto";
};

function wordParagraphPr(options: WordParagraphOptions = {}): string {
  const parts: string[] = [];
  if (options.style) parts.push(`<w:pStyle w:val="${options.style}"/>`);
  if (options.keepNext) parts.push("<w:keepNext/>");
  if (options.keepLines) parts.push("<w:keepLines/>");
  if (options.alignment === "center") parts.push('<w:jc w:val="center"/>');
  if (options.alignment === "left") parts.push('<w:jc w:val="left"/>');
  if (options.alignment === "right") parts.push('<w:jc w:val="right"/>');
  if (options.tabs) {
    parts.push(
      `<w:tabs><w:tab w:val="right" w:pos="${options.tabPosition ?? 10800}"/></w:tabs>`,
    );
  }
  if (options.numId) {
    parts.push(
      `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${options.numId}"/></w:numPr>`,
    );
  }
  if (options.indentLeft || options.hanging) {
    parts.push(
      `<w:ind w:left="${options.indentLeft ?? 0}" w:hanging="${options.hanging ?? 0}"/>`,
    );
  }
  if (
    options.spacingBefore !== undefined ||
    options.spacingAfter !== undefined ||
    options.spacingLine !== undefined
  ) {
    parts.push(
      `<w:spacing w:before="${options.spacingBefore ?? 0}" w:after="${options.spacingAfter ?? 0}"${options.spacingLine !== undefined ? ` w:line="${options.spacingLine}" w:lineRule="${options.lineRule ?? "auto"}"` : ""}/>`,
    );
  }
  if (options.borderBottom) {
    parts.push(
      `<w:pBdr><w:bottom w:val="single" w:sz="${options.borderBottom.size}" w:space="${options.borderBottom.space}" w:color="${options.borderBottom.color}"/></w:pBdr>`,
    );
  }
  return parts.length ? `<w:pPr>${parts.join("")}</w:pPr>` : "";
}

function wordRun(run: WordRun): string {
  if (run.tab) return "<w:r><w:tab/></w:r>";
  const runPr = [
    run.font
      ? `<w:rFonts w:ascii="${escapeXml(run.font)}" w:eastAsia="${escapeXml(run.font)}" w:hAnsi="${escapeXml(run.font)}"/>`
      : "",
    run.bold ? "<w:b/>" : "",
    run.italic ? "<w:i/>" : "",
    run.size ? `<w:sz w:val="${run.size}"/>` : "",
  ].join("");
  return `<w:r>${runPr ? `<w:rPr>${runPr}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(run.text ?? "")}</w:t></w:r>`;
}

function wordRunsParagraph(
  runs: WordRun[],
  options: WordParagraphOptions = {},
): string {
  return `<w:p>${wordParagraphPr(options)}${runs.map(wordRun).join("")}</w:p>`;
}

function wordBullet(
  text: string,
  keepNext: boolean,
  settings: ReturnType<typeof targetDocxSettings>,
): string {
  const cleaned = text.replace(/^\s*[•\u2022]\s*/, "").trim();
  return wordRunsParagraph(
    [{ text: `\u2022  ${cleaned}`, size: settings.bodySize }],
    {
      keepNext,
      keepLines: true,
      indentLeft: 504,
      hanging: 245,
      spacingBefore: settings.bulletBefore,
      spacingAfter: settings.bulletAfter,
      spacingLine: settings.bulletLine,
    },
  );
}

function wordPageBreakParagraph(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function wordHiddenMarkerParagraph(marker: string): string {
  const value = marker.trim();
  if (!value) return "";
  return `<w:p><w:r><w:rPr><w:vanish/><w:sz w:val="1"/></w:rPr><w:t>${escapeXml(
    `resume-generation-decision: ${value}`,
  )}</w:t></w:r></w:p>`;
}

function targetDocxSettings(targetPages?: 1 | 2): {
  mode: "reference_template_1_page" | "reference_template_2_page";
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  tableWidth: number;
  tableLeftWidth: number;
  tableRightWidth: number;
  bodySize: number;
  line: number;
  bodyAfter: number;
  sectionBefore: number;
  sectionAfter: number;
  bulletBefore: number;
  bulletAfter: number;
  bulletLine: number;
  nameBefore: number;
  contactBefore: number;
  summaryBefore: number;
  experienceBefore: number;
  trailingSectionBefore: number;
} {
  if (targetPages === 1) {
    return {
      mode: "reference_template_1_page",
      pageWidth: 11906,
      pageHeight: 16838,
      marginTop: 461,
      marginRight: 475,
      marginBottom: 317,
      marginLeft: 475,
      tableWidth: 11088,
      tableLeftWidth: 8813,
      tableRightWidth: 2275,
      bodySize: 18,
      line: 228,
      bodyAfter: 20,
      sectionBefore: 24,
      sectionAfter: 30,
      bulletBefore: 0,
      bulletAfter: 16,
      bulletLine: 259,
      nameBefore: 0,
      contactBefore: 0,
      summaryBefore: 24,
      experienceBefore: 8,
      trailingSectionBefore: 6,
    };
  }
  return {
    mode: "reference_template_2_page",
    pageWidth: 11906,
    pageHeight: 16838,
    marginTop: 576,
    marginRight: 720,
    marginBottom: 576,
    marginLeft: 720,
    tableWidth: 10466,
    tableLeftWidth: 8373,
    tableRightWidth: 2093,
    bodySize: 20,
    line: 270,
    bodyAfter: 20,
    sectionBefore: 80,
    sectionAfter: 30,
    bulletBefore: 20,
    bulletAfter: 20,
    bulletLine: 270,
    nameBefore: 100,
    contactBefore: 100,
    summaryBefore: 80,
    experienceBefore: 80,
    trailingSectionBefore: 80,
  };
}

type ReferenceResumeDocument = {
  name: string;
  contactLine: string | null;
  summaryParagraph: string | null;
  summaryBullets: string[];
  experience: Array<{
    title: string;
    company: string | null;
    location: string | null;
    date: string | null;
    bullets: string[];
  }>;
  educationLines: Array<{
    text: string;
    bold?: boolean;
    italic?: boolean;
    bullet?: boolean;
  }>;
  skillGroups: Array<{ name: string; keywords: string[] }>;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nestedText(source: Record<string, unknown>, path: string): string {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, source) as string;
}

function splitSummaryForReferenceBullets(summary: string | null): string[] {
  if (!summary) return [];
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (sentences.length <= 1) return [normalized];
  return sentences.slice(0, 5);
}

function splitEntrySubtitle(subtitle: string | null | undefined): {
  company: string | null;
  location: string | null;
} {
  const value = (subtitle ?? "").trim();
  if (!value) return { company: null, location: null };
  const parts = value
    .split(/\s+(?:\/|\|)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return {
      company: parts[0] ?? null,
      location: parts.slice(1).join(" / ") || null,
    };
  }
  return { company: value, location: null };
}

function buildReferenceResumeDocument(
  resumeJson: Record<string, unknown>,
): ReferenceResumeDocument {
  const document = normalizeResumeJsonToLatexDocument(resumeJson);
  const basics = recordValue(resumeJson.basics) ?? {};
  const sections = recordValue(resumeJson.sections) ?? {};
  const profilesSection = recordValue(sections.profiles) ?? {};
  const profileItems = Array.isArray(profilesSection.items)
    ? profilesSection.items
    : [];
  const linkedin = profileItems
    .map((item) => recordValue(item) ?? {})
    .map((item) => ({
      network: textValue(item.network),
      username: textValue(item.username),
      url: nestedText(item, "website.url"),
    }))
    .find((item) =>
      [item.network, item.username, item.url]
        .join(" ")
        .toLowerCase()
        .includes("linkedin"),
    );
  const email = textValue(basics.email);
  const phone = textValue(basics.phone);
  const contactLine = [
    [email, phone].filter(Boolean).join(" | "),
    textValue(basics.location),
  ]
    .filter(Boolean)
    .join(" | ");
  const fullContactLine = linkedin?.url
    ? `${contactLine}${contactLine ? " | " : ""}LinkedIn: ${linkedin.url}`
    : contactLine;
  const experience = document.experience
    .map((entry) => {
      const subtitleParts = splitEntrySubtitle(entry.subtitle);
      return {
        title: subtitleParts.company ?? entry.title,
        company: entry.title,
        location: subtitleParts.location,
        date: entry.date ?? null,
        bullets: entry.bullets.map((bullet) => bullet.trim()).filter(Boolean),
      };
    })
    .filter(
      (entry) => entry.title || entry.company || entry.bullets.length > 0,
    );
  const educationLines = dedupeEducationLines(
    document.education.flatMap((entry) => {
      const lines: ReferenceResumeDocument["educationLines"] = [];
      const subtitle = [
        entry.subtitle,
        entry.secondaryTitle,
        entry.secondarySubtitle,
      ]
        .filter(Boolean)
        .join(" / ");
      if (entry.title) {
        lines.push({
          text: entry.date ? `${entry.title}\t${entry.date}` : entry.title,
          bold: true,
        });
      }
      if (subtitle) {
        lines.push({ text: subtitle, italic: true });
      }
      for (const bullet of entry.bullets) {
        if (bullet.trim()) lines.push({ text: bullet.trim(), bullet: true });
      }
      return lines;
    }),
  );

  return {
    name: document.name || "Candidate Name",
    contactLine:
      fullContactLine ||
      (document.contactItems.length > 0
        ? document.contactItems.map((item) => item.text).join(" , ")
        : null),
    summaryParagraph: document.summary ?? null,
    summaryBullets: splitSummaryForReferenceBullets(document.summary ?? null),
    experience,
    educationLines,
    skillGroups: document.skillGroups.map((group) => ({
      name: group.name,
      keywords: group.keywords,
    })),
  };
}

function dedupeEducationLines(
  lines: ReferenceResumeDocument["educationLines"],
): ReferenceResumeDocument["educationLines"] {
  const normalizedLines: ReferenceResumeDocument["educationLines"] = [];
  let shouldAddHighDistinctionBullet = false;
  for (const line of lines) {
    if (educationLineHasGpaOrDistinction(line.text)) {
      shouldAddHighDistinctionBullet = true;
      if (!line.bullet) {
        const cleaned = cleanEducationDistinctionFromLine(line.text);
        if (cleaned) normalizedLines.push({ ...line, text: cleaned });
      }
      continue;
    }
    normalizedLines.push(line);
  }
  if (shouldAddHighDistinctionBullet) {
    normalizedLines.push({
      text: "Graduated with High Distinction.",
      bullet: true,
    });
  }

  const seen = new Set<string>();
  return normalizedLines.filter((line) => {
    const key = educationLineKey(line.text);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function educationLineHasGpaOrDistinction(text: string): boolean {
  return (
    /\b(?:cumulative\s+)?gpa\b/i.test(text) ||
    /\bhigh distinction\b/i.test(text) ||
    /\b[0-4](?:\.\d+)?\s*\/\s*4(?:\.0+)?\b/.test(text)
  );
}

function cleanEducationDistinctionFromLine(text: string): string {
  const cleaned = text
    .replace(/\s*\([^)]*(?:gpa|high distinction)[^)]*\)/gi, "")
    .replace(
      /\b(?:graduated\s+with\s+)?(?:a\s+)?(?:cumulative\s+)?gpa(?:\s+of)?\s*[:=]?\s*[0-9.]+\s*\/\s*[0-9.]+/gi,
      "",
    )
    .replace(/\b[0-4](?:\.\d+)?\s*\/\s*4(?:\.0+)?\b/g, "")
    .replace(/\bhigh distinction\b/gi, "")
    .replace(/[ \t]*(?:\/|\||,|;)[ \t]*(?=\t|$)/g, "")
    .replace(/(^|\t)[ \t]*(?:\/|\||,|;)[ \t]*/g, "$1")
    .replace(/[ ]{2,}/g, " ")
    .replace(/[ ]+\t/g, "\t")
    .replace(/\t[ ]+/g, "\t")
    .replace(/\s*[,.]\s*$/, "")
    .trim();
  if (!/[A-Za-z]/.test(cleaned)) return "";
  if (/^graduated\s+with$/i.test(cleaned)) return "";
  return cleaned;
}

function educationLineKey(text: string): string | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized === "graduated with high distinction.") {
    return "high-distinction";
  }
  return null;
}

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));
const DOCX_TEMPLATE_PATHS: Record<1 | 2, string> = {
  1: join(SERVICE_DIR, "docx-templates", "reference-1page.docx"),
  2: join(SERVICE_DIR, "docx-templates", "reference-2page.docx"),
};

function docxSectPrFromSettings(
  settings: ReturnType<typeof targetDocxSettings>,
): string {
  return `<w:sectPr><w:pgSz w:w="${settings.pageWidth}" w:h="${settings.pageHeight}"/><w:pgMar w:top="${settings.marginTop}" w:right="${settings.marginRight}" w:bottom="${settings.marginBottom}" w:left="${settings.marginLeft}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
}

function extractTemplateSectPr(
  templateDocumentXml: string | undefined,
  settings: ReturnType<typeof targetDocxSettings>,
): string {
  if (!templateDocumentXml) return docxSectPrFromSettings(settings);
  const matches = [
    ...templateDocumentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g),
  ];
  return matches.at(-1)?.[0] ?? docxSectPrFromSettings(settings);
}

function wordSectionHeading(
  title: string,
  options: { spacingBefore: number; spacingAfter: number },
): string {
  return wordRunsParagraph(
    [{ text: title, bold: true, font: "Georgia", size: 24 }],
    {
      keepNext: true,
      spacingBefore: options.spacingBefore,
      spacingAfter: options.spacingAfter,
      spacingLine: 197,
      borderBottom: { size: 6, space: 1, color: "7A869A" },
    },
  );
}

function wordBodyParagraph(
  text: string,
  settings: ReturnType<typeof targetDocxSettings>,
  options: {
    bold?: boolean;
    italic?: boolean;
    keepNext?: boolean;
    keepLines?: boolean;
    tabs?: boolean;
  } = {},
): string {
  return wordRunsParagraph(
    [
      {
        text,
        bold: options.bold,
        italic: options.italic,
        size: settings.bodySize,
      },
    ],
    {
      keepNext: options.keepNext,
      keepLines: options.keepLines,
      tabs: options.tabs,
      tabPosition: settings.tableWidth - 180,
      spacingAfter: settings.bodyAfter,
      spacingLine: settings.line,
    },
  );
}

function wordTabbedLine(
  left: string | null | undefined,
  right: string | null | undefined,
  settings: ReturnType<typeof targetDocxSettings>,
  options: { bold?: boolean; size?: number; keepNext?: boolean } = {},
): string {
  return wordRunsParagraph(
    [
      {
        text: left ?? "",
        bold: options.bold,
        size: options.size ?? settings.bodySize,
      },
      { tab: true },
      {
        text: right ?? "",
        bold: options.bold,
        size: options.size ?? settings.bodySize,
      },
    ],
    {
      keepNext: options.keepNext ?? true,
      keepLines: true,
      tabs: true,
      tabPosition: settings.tableWidth - 180,
      spacingAfter: 0,
      spacingLine: 197,
    },
  );
}

function wordEntryCell(
  text: string | null | undefined,
  width: number,
  options: { right?: boolean; bold?: boolean; size: number },
): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${wordRunsParagraph(
    [
      {
        text: text ?? "",
        bold: options.bold,
        size: options.size,
      },
    ],
    {
      keepNext: true,
      alignment: options.right ? "right" : "left",
      spacingLine: 197,
    },
  )}</w:tc>`;
}

function wordExperienceHeadingTable(
  entry: ReferenceResumeDocument["experience"][number],
  settings: ReturnType<typeof targetDocxSettings>,
): string {
  const titleSize =
    settings.mode === "reference_template_2_page"
      ? settings.bodySize + 2
      : settings.bodySize;
  const metaSize = settings.bodySize;
  return `<w:tbl><w:tblPr><w:tblW w:w="${settings.tableWidth}" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="${settings.tableLeftWidth}"/><w:gridCol w:w="${settings.tableRightWidth}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr>${wordEntryCell(entry.title, settings.tableLeftWidth, { bold: true, size: titleSize })}${wordEntryCell(entry.date, settings.tableRightWidth, { right: true, size: titleSize })}</w:tr><w:tr><w:trPr><w:cantSplit/></w:trPr>${wordEntryCell(entry.company, settings.tableLeftWidth, { bold: true, size: metaSize })}${wordEntryCell(entry.location, settings.tableRightWidth, { right: true, bold: true, size: metaSize })}</w:tr></w:tbl>`;
}

function wordExperienceHeadingTabs(
  entry: ReferenceResumeDocument["experience"][number],
  settings: ReturnType<typeof targetDocxSettings>,
): string {
  const titleSize =
    settings.mode === "reference_template_2_page"
      ? settings.bodySize + 2
      : settings.bodySize;
  const metaSize = settings.bodySize;
  return [
    wordTabbedLine(entry.title, entry.date, settings, {
      bold: true,
      size: titleSize,
      keepNext: true,
    }),
    wordTabbedLine(entry.company, entry.location, settings, {
      bold: true,
      size: metaSize,
      keepNext: true,
    }),
  ].join("\n");
}

function estimatedTextLines(text: string, charsPerLine: number): number {
  return Math.max(
    1,
    Math.ceil(text.replace(/\s+/g, " ").trim().length / charsPerLine),
  );
}

function estimatedParagraphHeight(
  text: string,
  settings: ReturnType<typeof targetDocxSettings>,
  charsPerLine: number,
  options: { before?: number; after?: number; line?: number } = {},
): number {
  return (
    (options.before ?? 0) +
    estimatedTextLines(text, charsPerLine) * (options.line ?? settings.line) +
    (options.after ?? settings.bodyAfter)
  );
}

function estimatedSectionHeadingHeight(before: number, after: number): number {
  return before + 197 + after;
}

function estimatedExperienceHeight(
  entry: ReferenceResumeDocument["experience"][number],
  settings: ReturnType<typeof targetDocxSettings>,
): number {
  const charsPerLine =
    settings.mode === "reference_template_2_page" ? 112 : 120;
  const tableHeight = 2 * 197 + 32;
  const bulletHeight = entry.bullets.reduce((total, bullet) => {
    return (
      total +
      estimatedParagraphHeight(bullet, settings, charsPerLine, {
        before: settings.bulletBefore,
        after: settings.bulletAfter,
        line: settings.bulletLine,
      })
    );
  }, 0);
  return tableHeight + bulletHeight;
}

function estimatedUsablePageHeight(
  settings: ReturnType<typeof targetDocxSettings>,
): number {
  return settings.pageHeight - settings.marginTop - settings.marginBottom;
}

export function buildDocxDocumentXml(
  resumeJson: Record<string, unknown>,
  options?: {
    targetPages?: 1 | 2;
    templateDocumentXml?: string;
    resumeDecision?: ResumeGenerationDecision;
    outputMode?: ResumeOutputMode;
  },
): string {
  const document = buildReferenceResumeDocument(resumeJson);
  const paragraphs: string[] = [];
  const targetPages =
    options?.resumeDecision?.targetPages ?? options?.targetPages;
  const settings = targetDocxSettings(targetPages);
  const outputMode = options?.outputMode ?? "strict_ats_visual";
  const usablePageHeight = estimatedUsablePageHeight(settings);
  let estimatedPageUsed = 0;
  const decisionMarker = options?.resumeDecision
    ? formatResumeGenerationDecisionMarker(options.resumeDecision)
    : "";
  if (decisionMarker) {
    paragraphs.push(wordHiddenMarkerParagraph(decisionMarker));
  }

  if (document.name) {
    paragraphs.push(
      wordRunsParagraph(
        [
          {
            text: document.name.toUpperCase(),
            bold: true,
            font: "Georgia",
            size: 34,
          },
        ],
        {
          alignment: "center",
          spacingBefore: settings.nameBefore,
          spacingAfter: 24,
          spacingLine: 197,
        },
      ),
    );
    estimatedPageUsed += settings.nameBefore + 197 + 24;
  }
  if (document.contactLine) {
    paragraphs.push(
      wordRunsParagraph([{ text: document.contactLine, size: 14 }], {
        alignment: "center",
        spacingBefore: settings.contactBefore,
        spacingAfter: 60,
        spacingLine: 204,
        borderBottom: { size: 4, space: 2, color: "7A869A" },
      }),
    );
    estimatedPageUsed += settings.contactBefore + 204 + 60;
  }
  if (targetPages === 1) {
    if (document.summaryParagraph) {
      paragraphs.push(
        wordSectionHeading("SUMMARY", {
          spacingBefore: settings.summaryBefore,
          spacingAfter: 30,
        }),
      );
      estimatedPageUsed += estimatedSectionHeadingHeight(
        settings.summaryBefore,
        30,
      );
      paragraphs.push(wordBodyParagraph(document.summaryParagraph, settings));
      estimatedPageUsed += estimatedParagraphHeight(
        document.summaryParagraph,
        settings,
        120,
      );
    }
  } else if (document.summaryBullets.length > 0) {
    paragraphs.push(
      wordSectionHeading("SUMMARY OF QUALIFICATIONS", {
        spacingBefore: settings.summaryBefore,
        spacingAfter: 30,
      }),
    );
    estimatedPageUsed += estimatedSectionHeadingHeight(
      settings.summaryBefore,
      30,
    );
    document.summaryBullets.forEach((bullet) => {
      paragraphs.push(wordBullet(bullet, false, settings));
      estimatedPageUsed += estimatedParagraphHeight(bullet, settings, 112, {
        before: settings.bulletBefore,
        after: settings.bulletAfter,
        line: settings.bulletLine,
      });
    });
  }

  if (document.experience.length > 0) {
    paragraphs.push(
      wordSectionHeading("EXPERIENCE", {
        spacingBefore: settings.experienceBefore,
        spacingAfter: 22,
      }),
    );
    estimatedPageUsed += estimatedSectionHeadingHeight(
      settings.experienceBefore,
      22,
    );
    document.experience.forEach((entry) => {
      const blockHeight = estimatedExperienceHeight(entry, settings);
      if (
        estimatedPageUsed > 0 &&
        (estimatedPageUsed >= usablePageHeight * 0.7 ||
          estimatedPageUsed + Math.min(blockHeight, usablePageHeight) >
            usablePageHeight)
      ) {
        paragraphs.push(wordPageBreakParagraph());
        estimatedPageUsed = 0;
      }
      paragraphs.push(
        outputMode === "master_visual_table"
          ? wordExperienceHeadingTable(entry, settings)
          : wordExperienceHeadingTabs(entry, settings),
      );
      entry.bullets.forEach((bullet, index) => {
        paragraphs.push(
          wordBullet(bullet, index < entry.bullets.length - 1, settings),
        );
      });
      estimatedPageUsed += blockHeight;
    });
  }

  if (document.educationLines.length > 0) {
    paragraphs.push(
      wordSectionHeading("EDUCATION", {
        spacingBefore: settings.trailingSectionBefore,
        spacingAfter: 22,
      }),
    );
    for (const line of document.educationLines) {
      if (line.bullet) {
        paragraphs.push(wordBullet(line.text, false, settings));
        continue;
      }
      paragraphs.push(
        wordBodyParagraph(line.text, settings, {
          bold: line.bold,
          italic: line.italic,
          keepLines: true,
          tabs: line.text.includes("\t"),
        }),
      );
    }
  }

  if (document.skillGroups.length > 0) {
    paragraphs.push(
      wordSectionHeading("RESEARCH & TECHNICAL SKILLS", {
        spacingBefore: settings.trailingSectionBefore,
        spacingAfter: 22,
      }),
    );
    for (const group of document.skillGroups) {
      paragraphs.push(
        wordRunsParagraph(
          [
            { text: `${group.name}: `, bold: true, size: settings.bodySize },
            { text: group.keywords.join(", "), size: settings.bodySize },
          ],
          {
            keepLines: true,
            spacingAfter: settings.bodyAfter,
            spacingLine: settings.line,
          },
        ),
      );
    }
  }

  const sectPr = extractTemplateSectPr(options?.templateDocumentXml, settings);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join("\n")}
    ${sectPr}
  </w:body>
</w:document>`;
}

export async function buildDocxPackageBuffer(
  resumeJson: Record<string, unknown>,
  options?: {
    targetPages?: 1 | 2;
    resumeDecision?: ResumeGenerationDecision;
    outputMode?: ResumeOutputMode;
  },
): Promise<Buffer> {
  const targetPages =
    (options?.resumeDecision?.targetPages ?? options?.targetPages) === 1
      ? 1
      : 2;
  const templateBuffer = await readFile(DOCX_TEMPLATE_PATHS[targetPages]);
  const zip = await JSZip.loadAsync(templateBuffer);
  const templateDocumentXml = await zip
    .file("word/document.xml")
    ?.async("string");
  if (!templateDocumentXml) {
    throw new Error(
      `Reference DOCX template is missing word/document.xml: ${DOCX_TEMPLATE_PATHS[targetPages]}`,
    );
  }
  zip.file(
    "word/document.xml",
    buildDocxDocumentXml(resumeJson, {
      targetPages,
      templateDocumentXml,
      resumeDecision: options?.resumeDecision,
      outputMode: options?.outputMode,
    }),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function writeDocx(
  outputPath: string,
  resumeJson: Record<string, unknown>,
  options?: {
    targetPages?: 1 | 2;
    resumeDecision?: ResumeGenerationDecision;
    outputMode?: ResumeOutputMode;
  },
) {
  const buffer = await buildDocxPackageBuffer(resumeJson, options);
  await writeFile(outputPath, buffer);
}

function renderHtmlEntry(
  entry: ReferenceResumeDocument["experience"][number],
): string {
  return `<section class="resume-entry">
    <div class="entry-heading">
      <h3>${escapeHtml(entry.title)}</h3>
      ${entry.date ? `<span>${escapeHtml(entry.date)}</span>` : ""}
    </div>
    ${
      [entry.company, entry.location].filter(Boolean).length
        ? `<div class="entry-meta"><span>${escapeHtml(entry.company ?? "")}</span>${
            entry.location ? `<span>${escapeHtml(entry.location)}</span>` : ""
          }</div>`
        : ""
    }
    ${
      entry.bullets.length
        ? `<ul>${entry.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
        : ""
    }
  </section>`;
}

function renderHtmlEducation(
  lines: ReferenceResumeDocument["educationLines"],
): string {
  const parts: string[] = [];
  let bulletBuffer: string[] = [];
  const flushBullets = () => {
    if (!bulletBuffer.length) return;
    parts.push(
      `<ul>${bulletBuffer.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>`,
    );
    bulletBuffer = [];
  };
  for (const line of lines) {
    if (line.bullet) {
      bulletBuffer.push(line.text);
      continue;
    }
    flushBullets();
    const text = escapeHtml(line.text).replace(/\t/g, "</span><span>");
    parts.push(
      `<p class="${line.bold ? "bold" : ""} ${line.italic ? "italic" : ""}"><span>${text}</span></p>`,
    );
  }
  flushBullets();
  return parts.join("");
}

export function buildResumeHtml(
  resumeJson: Record<string, unknown>,
  options?: { targetPages?: 1 | 2; resumeDecision?: ResumeGenerationDecision },
): string {
  const document = buildReferenceResumeDocument(resumeJson);
  const targetPages =
    options?.resumeDecision?.targetPages ?? options?.targetPages ?? 2;
  const densityClass = targetPages === 1 ? "target-one" : "target-two";
  const decisionMarker = options?.resumeDecision
    ? formatResumeGenerationDecisionMarker(options.resumeDecision)
    : `targetPages=${targetPages}`;
  const isOnePage = targetPages === 1;
  const summary = isOnePage
    ? document.summaryParagraph
      ? `<section class="resume-section summary"><h2>SUMMARY</h2><p>${escapeHtml(
          document.summaryParagraph,
        )}</p></section>`
      : ""
    : document.summaryBullets.length
      ? `<section class="resume-section summary"><h2>SUMMARY OF QUALIFICATIONS</h2><ul>${document.summaryBullets
          .map((bullet) => `<li>${escapeHtml(bullet)}</li>`)
          .join("")}</ul></section>`
      : "";
  const experience = document.experience.length
    ? `<section class="resume-section"><h2>EXPERIENCE</h2>${document.experience
        .map(renderHtmlEntry)
        .join("")}</section>`
    : "";
  const education = document.educationLines.length
    ? `<section class="resume-section education"><h2>EDUCATION</h2>${renderHtmlEducation(document.educationLines)}</section>`
    : "";
  const skills = document.skillGroups.length
    ? `<section class="resume-section skills"><h2>RESEARCH &amp; TECHNICAL SKILLS</h2>${document.skillGroups
        .map(
          (group) =>
            `<p><strong>${escapeHtml(group.name)}:</strong> ${escapeHtml(group.keywords.join(", "))}</p>`,
        )
        .join("")}</section>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(document.name || "Resume")}</title>
  <style>
    @page { size: A4; margin: ${isOnePage ? "0.19in 0.20in 0.13in" : "0.48in 0.50in"}; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f1ec; color: #111; font-family: Georgia, "Times New Roman", serif; }
    .resume { width: 210mm; min-height: 297mm; margin: 24px auto; background: #fff; padding: ${isOnePage ? "0.19in 0.20in 0.13in" : "0.48in 0.50in"}; box-shadow: 0 12px 40px rgba(0,0,0,.12); }
    .target-one { font-size: 9pt; line-height: 1.16; }
    .target-two { font-size: 10.35pt; line-height: 1.30; }
    header { text-align: center; margin-bottom: ${isOnePage ? "10px" : "12px"}; break-inside: avoid; }
    h1 { margin: 0 0 2px; font-size: ${isOnePage ? "17pt" : "17pt"}; letter-spacing: 0; font-weight: 700; }
    .contact { margin: 0; padding-bottom: 3px; border-bottom: 1px solid #777; font-size: ${isOnePage ? "7pt" : "8pt"}; }
    .resume-section { break-inside: auto; margin-top: ${isOnePage ? "5px" : "10px"}; }
    .resume-section h2 { break-after: avoid; margin: 0 0 ${isOnePage ? "4px" : "5px"}; border-bottom: 1px solid #777; font-size: 12pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0; }
    .summary { break-inside: avoid; }
    .summary p, .skills p { margin: 0 0 ${isOnePage ? "3px" : "4px"}; }
    .resume-entry { break-inside: avoid; margin-top: ${isOnePage ? "3px" : "8px"}; }
    .entry-heading { display: flex; justify-content: space-between; gap: 16px; break-after: avoid; padding-right: ${isOnePage ? "0.02in" : "0.08in"}; }
    .entry-heading h3 { margin: 0; font-size: 1em; }
    .entry-heading span { white-space: nowrap; }
    .entry-meta { display: flex; justify-content: space-between; gap: 16px; font-weight: 700; margin-top: 1px; break-after: avoid; padding-right: ${isOnePage ? "0.02in" : "0.08in"}; }
    .entry-meta span:last-child { text-align: right; white-space: nowrap; }
    ul { margin: ${isOnePage ? "2px" : "3px"} 0 0 16px; padding: 0; }
    li { margin: 0 0 ${isOnePage ? "1px" : "2.5px"}; }
    .education p { display: flex; justify-content: space-between; gap: 16px; margin: 0 0 ${isOnePage ? "2px" : "3px"}; }
    .education ul { margin-top: 2px; }
    .education .bold { font-weight: 700; }
    .education .italic { font-style: italic; }
    @media print {
      body { background: #fff; }
      .resume { margin: 0; box-shadow: none; min-height: 0; }
    }
  </style>
</head>
<body>
  <!-- resume-generation-decision: ${escapeHtml(decisionMarker)} -->
  <article class="resume ${densityClass}" data-policy="${escapeHtml(decisionMarker)}">
    <header>
      <h1>${escapeHtml(document.name || "Candidate Name")}</h1>
      ${
        document.contactLine
          ? `<p class="contact">${escapeHtml(document.contactLine)}</p>`
          : ""
      }
    </header>
    ${summary}
    ${experience}
    ${education}
    ${skills}
  </article>
</body>
</html>`;
}

async function writeHtml(
  outputPath: string,
  resumeJson: Record<string, unknown>,
  options?: { targetPages?: 1 | 2; resumeDecision?: ResumeGenerationDecision },
) {
  await writeFile(outputPath, buildResumeHtml(resumeJson, options), "utf8");
}

async function resolveDesignResumeForRenderer(args: {
  renderer: PdfRenderer;
  requestOrigin?: string | null;
  variant?: DesignResumeVariant;
  resumeTargetPages?: 1 | 2;
}): Promise<{
  documentId: string;
  title: string;
  data: Record<string, unknown>;
  mode: "v5";
}> {
  const designResume = args.variant
    ? await getCurrentDesignResume(args.variant)
    : await getDesignResumeForTargetPages(args.resumeTargetPages);
  if (!designResume?.resumeJson) {
    throw notFound("Design Resume has not been imported yet.");
  }

  const localDocument = parseV5ResumeData(
    designResume.resumeJson as Record<string, unknown>,
  ) as Record<string, unknown>;

  if (
    args.renderer !== "rxresume" ||
    !designResume.sourceResumeId ||
    designResume.sourceMode !== "v5"
  ) {
    return {
      documentId: designResume.id,
      title: designResume.title,
      data: localDocument,
      mode: "v5",
    };
  }

  try {
    const upstreamResume = await getRxResume(designResume.sourceResumeId);

    if (!upstreamResume.data || typeof upstreamResume.data !== "object") {
      throw new Error("Reactive Resume base resume is empty or invalid.");
    }

    const upstreamDocument = parseV5ResumeData(
      upstreamResume.data as Record<string, unknown>,
    ) as Record<string, unknown>;

    return {
      documentId: designResume.id,
      title: designResume.title,
      data: mergeReactiveResumeV5Content(upstreamDocument, localDocument, {
        requestOrigin: args.requestOrigin ?? null,
      }) as Record<string, unknown>,
      mode: "v5",
    };
  } catch (error) {
    logger.warn(
      "Failed to refresh Reactive Resume template metadata for Design Resume rendering",
      {
        documentId: designResume.id,
        sourceResumeId: designResume.sourceResumeId,
        sourceMode: designResume.sourceMode,
        error,
      },
    );

    return {
      documentId: designResume.id,
      title: designResume.title,
      data: localDocument,
      mode: "v5",
    };
  }
}

async function loadBaseResumeSource(args: {
  renderer: PdfRenderer;
  requestOrigin?: string | null;
  resumeTargetPages?: 1 | 2;
}): Promise<{
  data: Record<string, unknown>;
  mode: "v5";
}> {
  const designResume = await getDesignResumeForTargetPages(
    args.resumeTargetPages,
  );
  if (designResume?.resumeJson) {
    if (args.renderer === "rxresume") {
      const resolved = await resolveDesignResumeForRenderer({
        renderer: args.renderer,
        requestOrigin: args.requestOrigin ?? null,
        resumeTargetPages: args.resumeTargetPages,
      });
      return {
        data: resolved.data,
        mode: "v5",
      };
    }

    return {
      data: parseV5ResumeData(
        designResume.resumeJson as Record<string, unknown>,
      ) as Record<string, unknown>,
      mode: "v5",
    };
  }

  const { resumeId: baseResumeId } = await getConfiguredRxResumeBaseResumeId();
  if (!baseResumeId) {
    throw new Error(
      "No Design Resume found, and no Reactive Resume base resume is configured. Import a Design Resume or select a base resume in Settings.",
    );
  }

  const baseResume = await getRxResume(baseResumeId);
  if (!baseResume.data || typeof baseResume.data !== "object") {
    throw new Error("Reactive Resume base resume is empty or invalid.");
  }

  return {
    data: baseResume.data as Record<string, unknown>,
    mode: "v5",
  };
}

/**
 * Generate a tailored PDF resume for a job using the configured resume source.
 *
 * Flow:
 * 1. Prepare resume data with tailored content and project selection
 * 2. Normalize the tailored resume into the renderer document model
 * 3. Render a PDF with the active renderer
 */
export async function generatePdf(
  jobId: string,
  tailoredContent: TailoredPdfContent,
  jobDescription: string,
  _baseResumePath?: string, // Deprecated: now always uses Design Resume or the configured Reactive Resume base resume
  selectedProjectIds?: string | null,
  options?: GeneratePdfOptions,
): Promise<PdfResult> {
  let renderer: PdfRenderer | null = null;

  try {
    renderer = await resolvePdfRenderer();
    logger.info("Generating PDF resume", { jobId, renderer });
    const effectiveTargetPages =
      options?.resumeDecision?.targetPages ?? options?.resumeTargetPages;

    // Ensure output directory exists
    await ensureOutputDir();

    const baseResume = await loadBaseResumeSource({
      renderer,
      requestOrigin: options?.requestOrigin ?? null,
      resumeTargetPages: effectiveTargetPages,
    });
    const freshJdKeywordProfile = buildJdKeywordProfile({
      title: options?.jobTitle,
      employer: options?.jobEmployer,
      jobDescription,
    });
    const tailoredContentWithProfile: TailoredPdfContent = {
      ...tailoredContent,
      jdKeywordProfile: freshJdKeywordProfile,
    };

    // Defense-in-depth: gate experience bullets with fresh JD profile before
    // they reach the resume clone. The per-bullet gate in applyTailoredExperience
    // and the JSON-level gate in applyDomainGateToResumeData provide additional
    // layers; this one catches anything that arrives at generatePdf un-gated.
    if (Array.isArray(tailoredContentWithProfile.experience)) {
      const experienceGate = applyDomainGateToExperience(
        tailoredContentWithProfile.experience as TailoredExperienceItem[],
        freshJdKeywordProfile,
      );
      tailoredContentWithProfile.experience = experienceGate.experience;
    }

    let preparedResume: Awaited<
      ReturnType<typeof prepareTailoredResumeForPdf>
    > | null = null;
    try {
      preparedResume = await prepareTailoredResumeForPdf({
        resumeData: baseResume.data,
        tailoredContent: tailoredContentWithProfile,
        jobDescription,
        selectedProjectIds,
        jobId,
        tracerLinks: {
          enabled: Boolean(options?.tracerLinksEnabled),
          requestOrigin: options?.requestOrigin ?? null,
          companyName: options?.tracerCompanyName ?? null,
        },
      });
    } catch (err) {
      logger.warn("Resume tailoring step failed during PDF generation", {
        jobId,
        error: err,
      });
      throw err;
    }

    const outputPath = getTenantJobPdfPath(jobId);
    await renderPreparedPdf({
      renderer,
      preparedResume,
      outputPath,
      jobId,
      requestOrigin: options?.requestOrigin ?? null,
      jdKeywordProfile: freshJdKeywordProfile,
      layout: initialLatexLayoutForTarget(effectiveTargetPages),
    });

    const warnings: string[] = [];
    if (effectiveTargetPages) {
      let pageCount = await countPdfPages(outputPath);
      if (pageCount !== null && pageCount > effectiveTargetPages) {
        const originalPageCount = pageCount;
        if (renderer === "latex") {
          let appliedLayout: LatexResumeLayout | undefined;
          for (const layout of latexFallbackLayoutsForTarget(
            effectiveTargetPages,
          )) {
            appliedLayout = layout;
            await renderPreparedPdf({
              renderer,
              preparedResume,
              outputPath,
              jobId,
              requestOrigin: options?.requestOrigin ?? null,
              jdKeywordProfile: freshJdKeywordProfile,
              layout,
            });
            pageCount = await countPdfPages(outputPath);
            if (pageCount === null || pageCount <= effectiveTargetPages) {
              break;
            }
          }
          const message =
            pageCount !== null && pageCount <= effectiveTargetPages
              ? `Generated resume used a denser LaTeX layout (${appliedLayout}) to fit ${pageCount} page(s) without shortening content.`
              : `Generated resume used the densest LaTeX layout without shortening content, but the final page count is ${pageCount ?? "unknown"}.`;
          logger.warn(
            "Generated resume exceeded document policy and used denser layout",
            {
              jobId,
              renderer,
              originalPageCount,
              pageCount,
              targetPages: effectiveTargetPages,
              layout: appliedLayout,
            },
          );
          warnings.push(message);
        } else {
          preparedResume.data = compactDesignResumeJson(
            preparedResume.data,
            effectiveTargetPages,
          ) as Record<string, unknown>;
          await renderPreparedPdf({
            renderer,
            preparedResume,
            outputPath,
            jobId,
            requestOrigin: options?.requestOrigin ?? null,
            jdKeywordProfile: freshJdKeywordProfile,
            layout: initialLatexLayoutForTarget(effectiveTargetPages),
          });
          pageCount = await countPdfPages(outputPath);
          const message =
            pageCount !== null && pageCount <= effectiveTargetPages
              ? `Generated resume applied layout-only compaction from ${originalPageCount} to ${pageCount} pages to match the ${effectiveTargetPages}-page document policy.`
              : `Generated resume applied layout-only compaction for the ${effectiveTargetPages}-page document policy, but the final page count is ${pageCount ?? "unknown"}.`;
          logger.warn(
            "Generated resume exceeded document policy and applied layout-only compaction",
            {
              jobId,
              renderer,
              originalPageCount,
              pageCount,
              targetPages: effectiveTargetPages,
            },
          );
          warnings.push(message);
        }
      }
      if (pageCount !== null) {
        warnings.push(
          `Generated resume matched the ${effectiveTargetPages}-page document policy (${pageCount} pages).`,
        );
      }
    }

    logger.info("PDF generated successfully", { jobId, outputPath, renderer });
    return {
      success: true,
      pdfPath: outputPath,
      warnings: warnings.length > 0 ? warnings : undefined,
      jdKeywordProfile: freshJdKeywordProfile,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("PDF generation failed", { jobId, renderer, error });
    return {
      success: false,
      error: message,
      errorCode: classifyPdfGenerationError(error),
      domainGateResiduals:
        error instanceof DomainGateResidualError ? error.residuals : undefined,
    };
  }
}

export async function generateDocx(
  jobId: string,
  tailoredContent: TailoredPdfContent,
  jobDescription: string,
  selectedProjectIds?: string | null,
  options?: GeneratePdfOptions,
): Promise<DocxResult> {
  try {
    await ensureOutputDir();
    const renderer = await resolvePdfRenderer();
    const outputMode = await resolveResumeOutputMode();
    const effectiveTargetPages =
      options?.resumeDecision?.targetPages ?? options?.resumeTargetPages;
    const baseResume = await loadBaseResumeSource({
      renderer,
      requestOrigin: options?.requestOrigin ?? null,
      resumeTargetPages: effectiveTargetPages,
    });
    const freshJdKeywordProfile = buildJdKeywordProfile({
      title: options?.jobTitle,
      employer: options?.jobEmployer,
      jobDescription,
    });
    const preparedResume = await prepareTailoredResumeForPdf({
      resumeData: baseResume.data,
      tailoredContent: {
        ...tailoredContent,
        jdKeywordProfile: freshJdKeywordProfile,
      },
      jobDescription,
      selectedProjectIds,
      jobId,
      tracerLinks: {
        enabled: Boolean(options?.tracerLinksEnabled),
        requestOrigin: options?.requestOrigin ?? null,
        companyName: options?.tracerCompanyName ?? null,
      },
    });
    const outputPath = getTenantJobDocxPath(jobId);
    await writeDocx(outputPath, preparedResume.data, {
      targetPages: effectiveTargetPages,
      resumeDecision: options?.resumeDecision,
      outputMode,
    });
    return {
      success: true,
      docxPath: outputPath,
      jdKeywordProfile: freshJdKeywordProfile,
    };
  } catch (error) {
    logger.error("DOCX generation failed", { jobId, error });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      errorCode: classifyPdfGenerationError(error),
    };
  }
}

export async function generateHtml(
  jobId: string,
  tailoredContent: TailoredPdfContent,
  jobDescription: string,
  selectedProjectIds?: string | null,
  options?: GeneratePdfOptions,
): Promise<HtmlResult> {
  try {
    await ensureOutputDir();
    const renderer = await resolvePdfRenderer();
    const effectiveTargetPages =
      options?.resumeDecision?.targetPages ?? options?.resumeTargetPages;
    const baseResume = await loadBaseResumeSource({
      renderer,
      requestOrigin: options?.requestOrigin ?? null,
      resumeTargetPages: effectiveTargetPages,
    });
    const freshJdKeywordProfile = buildJdKeywordProfile({
      title: options?.jobTitle,
      employer: options?.jobEmployer,
      jobDescription,
    });
    const preparedResume = await prepareTailoredResumeForPdf({
      resumeData: baseResume.data,
      tailoredContent: {
        ...tailoredContent,
        jdKeywordProfile: freshJdKeywordProfile,
      },
      jobDescription,
      selectedProjectIds,
      jobId,
      tracerLinks: {
        enabled: Boolean(options?.tracerLinksEnabled),
        requestOrigin: options?.requestOrigin ?? null,
        companyName: options?.tracerCompanyName ?? null,
      },
    });
    const outputPath = getTenantJobHtmlPath(jobId);
    await writeHtml(outputPath, preparedResume.data, {
      targetPages: effectiveTargetPages,
      resumeDecision: options?.resumeDecision,
    });
    return {
      success: true,
      htmlPath: outputPath,
      jdKeywordProfile: freshJdKeywordProfile,
    };
  } catch (error) {
    logger.error("HTML resume generation failed", { jobId, error });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      errorCode: classifyPdfGenerationError(error),
    };
  }
}

export async function generateDesignResumePdf(options?: {
  requestOrigin?: string | null;
  variant?: DesignResumeVariant;
}): Promise<DesignResumePdfResponse> {
  const renderer = await resolvePdfRenderer();
  const designResume = await resolveDesignResumeForRenderer({
    renderer,
    requestOrigin: options?.requestOrigin ?? null,
    variant: options?.variant,
  });
  const generatedAt = new Date().toISOString();
  const outputPath = getTenantDesignResumePdfPath();
  const targetPages = targetPagesForDesignResumeVariant(options?.variant);
  const preparedResume: PreparedRxResumePdfPayload = {
    mode: "v5",
    data: structuredClone(designResume.data) as Record<string, unknown>,
    projectCatalog: [],
    selectedProjectIds: [],
  };

  await ensureOutputDir();

  logger.info("Generating Design Resume PDF", {
    renderer,
    documentId: designResume.documentId,
  });

  await renderPreparedPdf({
    renderer,
    preparedResume,
    outputPath,
    jobId: "design-resume",
    name: designResume.title,
    requestOrigin: options?.requestOrigin ?? null,
    layout: initialLatexLayoutForTarget(targetPages),
  });

  let compacted = false;
  const warnings: string[] = [];
  let pageCount = await countPdfPages(outputPath);
  if (pageCount !== null && pageCount > targetPages) {
    const originalPageCount = pageCount;
    compacted = true;
    if (renderer === "latex") {
      let appliedLayout: LatexResumeLayout | undefined;
      for (const layout of latexFallbackLayoutsForTarget(targetPages)) {
        appliedLayout = layout;
        await renderPreparedPdf({
          renderer,
          preparedResume,
          outputPath,
          jobId: "design-resume",
          name: designResume.title,
          requestOrigin: options?.requestOrigin ?? null,
          layout,
        });
        pageCount = await countPdfPages(outputPath);
        if (pageCount === null || pageCount <= targetPages) {
          break;
        }
      }
      warnings.push(
        pageCount !== null && pageCount <= targetPages
          ? `The ${targetPages}-page master used a denser LaTeX layout (${appliedLayout}) to fit ${pageCount} page(s) without shortening content.`
          : `The ${targetPages}-page master used the densest LaTeX layout without shortening content, but the final page count is ${pageCount ?? "unknown"}.`,
      );
    } else {
      preparedResume.data = compactDesignResumeJson(
        preparedResume.data,
        targetPages,
      ) as Record<string, unknown>;
      await renderPreparedPdf({
        renderer,
        preparedResume,
        outputPath,
        jobId: "design-resume",
        name: designResume.title,
        requestOrigin: options?.requestOrigin ?? null,
        layout: initialLatexLayoutForTarget(targetPages),
      });
      pageCount = await countPdfPages(outputPath);
      warnings.push(
        pageCount !== null && pageCount <= targetPages
          ? `The ${targetPages}-page master applied layout-only compaction from ${originalPageCount} to ${pageCount} pages for this PDF.`
          : `The ${targetPages}-page master applied layout-only compaction for this PDF, but the final page count is ${pageCount ?? "unknown"}.`,
      );
    }
  }

  return {
    fileName: sanitizePdfFileName(designResume.title),
    pdfUrl: `/api/design-resume/pdf?v=${encodeURIComponent(generatedAt)}`,
    generatedAt,
    compacted,
    pageCount,
    targetPages,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Check if a PDF exists for a job.
 */
export async function pdfExists(jobId: string): Promise<boolean> {
  const pdfPath = getTenantJobPdfPath(jobId);
  try {
    await access(pdfPath);
    return true;
  } catch {
    try {
      await access(getLegacyJobPdfPath(jobId));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get the path to a job's PDF.
 */
export function getPdfPath(jobId: string): string {
  const pdfPath = getTenantJobPdfPath(jobId);
  if (existsSync(pdfPath)) return pdfPath;
  return getLegacyJobPdfPath(jobId);
}

export function getDocxPath(jobId: string): string {
  return getTenantJobDocxPath(jobId);
}

export function getHtmlPath(jobId: string): string {
  return getTenantJobHtmlPath(jobId);
}
