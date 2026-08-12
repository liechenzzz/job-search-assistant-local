import {
  applyDomainGateToText,
  type DomainGateResidual,
  scanDomainGateResidualFields,
  scanDomainGateResiduals,
} from "@shared/jd-domain-gate.js";
import type { JdKeywordProfile } from "@shared/types";
import { normalizeResumeJsonToLatexDocument } from "./document";
import { renderLatexPdf } from "./latex";
import type {
  LatexResumeDocument,
  LatexResumeEntry,
  LatexResumeLayout,
  NormalizeResumeJsonToLatexDocumentOptions,
} from "./types";

export { normalizeResumeJsonToLatexDocument } from "./document";
export {
  getLatexTemplatePath,
  getTectonicBinary,
  readLatexTemplate,
} from "./latex";
export type * from "./types";

export class DomainGateResidualError extends Error {
  readonly residuals: DomainGateResidual[];

  constructor(residuals: DomainGateResidual[]) {
    const terms = Array.from(new Set(residuals.map((item) => item.term)));
    const locations = residuals
      .slice(0, 5)
      .map((item) => `${item.path} (${item.term})`)
      .join("; ");
    super(
      `PDF domain gate blocked residual terms: ${terms.join(", ")}. Residual locations: ${locations}.`,
    );
    this.name = "DomainGateResidualError";
    this.residuals = residuals;
  }
}

function gateNullableText(
  value: string | null | undefined,
  profile: JdKeywordProfile,
): string | null | undefined {
  if (!value) return value;
  return applyDomainGateToText(value, profile).text;
}

function gateKeywords(values: string[], profile: JdKeywordProfile): string[] {
  return values.map((value) => applyDomainGateToText(value, profile).text);
}

function gateEvidenceEntry(
  entry: LatexResumeEntry,
  profile: JdKeywordProfile,
): LatexResumeEntry {
  return {
    ...entry,
    bullets: gateKeywords(entry.bullets, profile),
  };
}

function gateProjectEntry(
  entry: LatexResumeEntry,
  profile: JdKeywordProfile,
): LatexResumeEntry {
  return {
    ...entry,
    title: applyDomainGateToText(entry.title, profile).text,
    subtitle: gateNullableText(entry.subtitle, profile) ?? null,
    secondaryTitle: gateNullableText(entry.secondaryTitle, profile) ?? null,
    secondarySubtitle:
      gateNullableText(entry.secondarySubtitle, profile) ?? null,
    bullets: gateKeywords(entry.bullets, profile),
  };
}

export function sanitizeLatexDocumentForDomainGate(
  document: LatexResumeDocument,
  profile: JdKeywordProfile,
): LatexResumeDocument {
  return {
    ...document,
    headline: gateNullableText(document.headline, profile) ?? null,
    summary: gateNullableText(document.summary, profile) ?? null,
    experience: document.experience.map((entry) =>
      gateEvidenceEntry(entry, profile),
    ),
    education: document.education.map((entry) =>
      gateEvidenceEntry(entry, profile),
    ),
    projects: document.projects.map((entry) =>
      gateProjectEntry(entry, profile),
    ),
    skillGroups: document.skillGroups.map((group) => ({
      ...group,
      name: applyDomainGateToText(group.name, profile).text,
      keywords: gateKeywords(group.keywords, profile),
    })),
  };
}

function collectRenderedText(document: LatexResumeDocument): string {
  const chunks: string[] = [document.headline ?? "", document.summary ?? ""];

  for (const entry of [...document.experience, ...document.education]) {
    chunks.push(...entry.bullets);
  }

  for (const entry of document.projects) {
    chunks.push(
      entry.title,
      entry.subtitle ?? "",
      entry.secondaryTitle ?? "",
      entry.secondarySubtitle ?? "",
      ...entry.bullets,
    );
  }

  for (const group of document.skillGroups) {
    chunks.push(group.name, ...group.keywords);
  }

  return chunks.join("\n");
}

function collectRenderedFields(
  document: LatexResumeDocument,
): Array<{ section: string; path: string; text: string }> {
  const fields: Array<{ section: string; path: string; text: string }> = [
    { section: "Headline", path: "Headline", text: document.headline ?? "" },
    { section: "Summary", path: "Summary", text: document.summary ?? "" },
  ];

  document.experience.forEach((entry, entryIndex) => {
    entry.bullets.forEach((bullet, bulletIndex) => {
      fields.push({
        section: "Experience",
        path: `Experience > ${entry.title || `item ${entryIndex + 1}`} > bullet ${bulletIndex + 1}`,
        text: bullet,
      });
    });
  });

  document.education.forEach((entry, entryIndex) => {
    entry.bullets.forEach((bullet, bulletIndex) => {
      fields.push({
        section: "Education",
        path: `Education > ${entry.title || `item ${entryIndex + 1}`} > bullet ${bulletIndex + 1}`,
        text: bullet,
      });
    });
  });

  document.projects.forEach((entry, entryIndex) => {
    const label = entry.title || `item ${entryIndex + 1}`;
    fields.push({
      section: "Projects",
      path: `Projects > ${label} > title`,
      text: entry.title,
    });
    if (entry.subtitle) {
      fields.push({
        section: "Projects",
        path: `Projects > ${label} > subtitle`,
        text: entry.subtitle,
      });
    }
    if (entry.secondaryTitle) {
      fields.push({
        section: "Projects",
        path: `Projects > ${label} > secondary title`,
        text: entry.secondaryTitle,
      });
    }
    if (entry.secondarySubtitle) {
      fields.push({
        section: "Projects",
        path: `Projects > ${label} > secondary subtitle`,
        text: entry.secondarySubtitle,
      });
    }
    entry.bullets.forEach((bullet, bulletIndex) => {
      fields.push({
        section: "Projects",
        path: `Projects > ${label} > bullet ${bulletIndex + 1}`,
        text: bullet,
      });
    });
  });

  document.skillGroups.forEach((group, groupIndex) => {
    const label = group.name || `group ${groupIndex + 1}`;
    fields.push({
      section: "Skills",
      path: `Skills > ${label} > group name`,
      text: group.name,
    });
    group.keywords.forEach((keyword, keywordIndex) => {
      fields.push({
        section: "Skills",
        path: `Skills > ${label} > keyword ${keywordIndex + 1}`,
        text: keyword,
      });
    });
  });

  return fields;
}

export function assertNoDomainGateResiduals(
  document: LatexResumeDocument,
  profile: JdKeywordProfile,
): void {
  const scan = scanDomainGateResiduals(collectRenderedText(document), profile);
  if (scan.blockedTerms.length === 0) return;

  const residuals = scanDomainGateResidualFields(
    collectRenderedFields(document),
    profile,
  );
  throw new DomainGateResidualError(residuals);
}

export async function renderResumePdf(args: {
  resumeJson: Record<string, unknown>;
  outputPath: string;
  jobId: string;
  language?: NormalizeResumeJsonToLatexDocumentOptions["language"];
  jdKeywordProfile?: JdKeywordProfile | null;
  layout?: LatexResumeLayout;
}): Promise<void> {
  let document = normalizeResumeJsonToLatexDocument(args.resumeJson, {
    language: args.language,
  });

  if (args.jdKeywordProfile) {
    document = sanitizeLatexDocumentForDomainGate(
      document,
      args.jdKeywordProfile,
    );
    assertNoDomainGateResiduals(document, args.jdKeywordProfile);
  }

  await renderLatexPdf({
    document,
    outputPath: args.outputPath,
    jobId: args.jobId,
    layout: args.layout,
  });
}
