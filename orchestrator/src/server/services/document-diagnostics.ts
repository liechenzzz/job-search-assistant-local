import { readFile } from "node:fs/promises";
import { resolveDocumentPolicy } from "@shared/document-policy.js";
import { buildJdQualificationProfile } from "@shared/jd-qualification-profile.js";
import { buildResumeAlignmentReport } from "@shared/resume-alignment.js";
import { buildResumeCoveragePlan } from "@shared/resume-coverage-plan.js";
import { SEMANTIC_QUALIFICATION_ENGINE_VERSION } from "@shared/qualification-semantics.js";
import type {
  Job,
  JobDocumentDiagnostics,
  ResumeAlignmentReport,
  ResumeServiceFitReport,
  ResumeProfile,
  TailoredExperienceItem,
} from "@shared/types";
import { getDesignResumeForTargetPages } from "./design-resume";
import { getPdfPath, pdfExists } from "./pdf";
import { getProfile } from "./profile";
import { findResumeReferenceEvidenceForQualifications } from "./resume-references";
import { resolveResumeGenerationDecisionForJob } from "./resume-generation-decision";
import { sanitizeResumeServiceFitReport } from "./resume-service-value";

function parseTailoredSkillGroups(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function parseAlignmentReport(raw: string | null): ResumeAlignmentReport | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ResumeAlignmentReport>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.score !== "number") return null;
    if (
      parsed.status !== "pass" &&
      parsed.status !== "warning" &&
      parsed.status !== "failed"
    ) {
      return null;
    }
    return {
      engineVersion:
        typeof parsed.engineVersion === "string"
          ? parsed.engineVersion
          : undefined,
      score: Math.max(0, Math.min(100, Math.round(parsed.score))),
      status: parsed.status,
      missingRequired: Array.isArray(parsed.missingRequired)
        ? parsed.missingRequired.filter((item): item is string => typeof item === "string").slice(0, 5)
        : [],
      partialRequired: Array.isArray(parsed.partialRequired)
        ? parsed.partialRequired.filter((item): item is string => typeof item === "string").slice(0, 5)
        : [],
      matchedSections:
        parsed.matchedSections && typeof parsed.matchedSections === "object"
          ? (parsed.matchedSections as Record<string, number>)
          : {},
      referenceUsed: Array.isArray(parsed.referenceUsed)
        ? parsed.referenceUsed.filter((item): item is string => typeof item === "string").slice(0, 5)
        : [],
      humanInputNeeded: Array.isArray(parsed.humanInputNeeded)
        ? parsed.humanInputNeeded.filter((item): item is string => typeof item === "string").slice(0, 5)
        : [],
      repairableRequired: Array.isArray(parsed.repairableRequired)
        ? parsed.repairableRequired.filter((item): item is string => typeof item === "string").slice(0, 5)
        : [],
      autoRewriteApplied:
        typeof parsed.autoRewriteApplied === "boolean"
          ? parsed.autoRewriteApplied
          : undefined,
      wordingGapsAfterAutoRewrite: Array.isArray(parsed.wordingGapsAfterAutoRewrite)
        ? parsed.wordingGapsAfterAutoRewrite.filter((item): item is string => typeof item === "string").slice(0, 5)
        : [],
      evidenceFit:
        parsed.evidenceFit && typeof parsed.evidenceFit === "object"
          ? parsed.evidenceFit
          : undefined,
      alignmentSource:
        parsed.alignmentSource === "ai_calibrated"
          ? "ai_calibrated"
          : "deterministic",
    };
  } catch {
    return null;
  }
}

function parseServiceFitReport(raw: string | null): ResumeServiceFitReport | null {
  if (!raw) return null;
  try {
    return sanitizeResumeServiceFitReport(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseTailoredExperience(raw: string | null): TailoredExperienceItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const record = asRecord(item);
        if (!record || typeof record.id !== "string") return null;
        const bullets = asArray(record.bullets)
          ?.filter((bullet): bullet is string => typeof bullet === "string")
          .slice(0, 12);
        if (!bullets || bullets.length === 0) return null;
        return { id: record.id, bullets };
      })
      .filter((item): item is TailoredExperienceItem => item !== null);
  } catch {
    return [];
  }
}

function parseTailoredSkillsText(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return "";
    return parsed
      .map((group) => {
        const record = asRecord(group);
        if (!record) return "";
        const name = typeof record.name === "string" ? record.name : "Skills";
        const keywords =
          asArray(record.keywords)?.filter(
            (keyword): keyword is string => typeof keyword === "string",
          ) ?? [];
        return keywords.length ? `${name}: ${keywords.join(", ")}` : "";
      })
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  const normalized = stripHtml(text).trim();
  return normalized ? normalized.split(/\s+/).length : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

async function countPdfPages(path: string): Promise<number | null> {
  try {
    const contents = await readFile(path, "latin1");
    return contents.match(/\/Type\s*\/Page\b/g)?.length ?? null;
  } catch {
    return null;
  }
}

async function getDesignResumeSkillsState(targetPages: 1 | 2): Promise<{
  hidden: boolean | null;
  itemCount: number | null;
}> {
  const designResume = await getDesignResumeForTargetPages(targetPages);
  const resumeJson = asRecord(designResume?.resumeJson);
  const sections = asRecord(resumeJson?.sections);
  const skills = asRecord(sections?.skills);
  if (!skills) {
    return { hidden: null, itemCount: null };
  }
  return {
    hidden: typeof skills.hidden === "boolean" ? skills.hidden : null,
    itemCount: asArray(skills.items)?.length ?? null,
  };
}

async function buildFallbackAlignmentReport(
  job: Job,
): Promise<ResumeAlignmentReport | null> {
  try {
    const profile = await getProfile();
    const qualificationProfile = buildJdQualificationProfile({
      title: job.title,
      employer: job.employer,
      jobDescription: job.jobDescription,
    });
    const referenceItems = await findResumeReferenceEvidenceForQualifications({
      qualificationProfile,
    });

    const resumeSections = buildResumeSectionsForAlignment({
      job,
      profile,
      experience: parseTailoredExperience(job.tailoredExperience),
    });
    const coveragePlan = buildResumeCoveragePlan({
      qualificationProfile,
      resumeSections,
      referenceItems,
    });

    return buildResumeAlignmentReport({
      qualificationProfile,
      resumeSections,
      referenceItems,
      coveragePlan,
    });
  } catch {
    return null;
  }
}

function buildResumeSectionsForAlignment(args: {
  job: Job;
  profile: ResumeProfile;
  experience: TailoredExperienceItem[];
}): Record<string, string> {
  const experienceById = new Map(
    args.experience.map((item) => [item.id, item.bullets.join(" ")]),
  );
  const sourceExperience = args.profile.sections?.experience?.items
    ?.map((item) => {
      const record = item as typeof item & { description?: string };
      return (
        experienceById.get(item.id) ??
        [item.summary, record.description].filter(Boolean).join(" ")
      );
    })
    .join(" ");
  const sections = args.profile.sections as Record<string, unknown> | undefined;
  const tailoredSkills = parseTailoredSkillsText(args.job.tailoredSkills);

  return {
    summary: args.job.tailoredSummary || args.profile.basics?.summary || "",
    skills:
      tailoredSkills ||
      stripHtml(JSON.stringify(args.profile.sections?.skills ?? "")),
    experience: stripHtml(sourceExperience ?? ""),
    education: stripHtml(JSON.stringify(sections?.education ?? "")),
    projects: stripHtml(JSON.stringify(args.profile.sections?.projects ?? "")),
  };
}

function stripHtml(text: string): string {
  return text
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

export async function getJobDocumentDiagnostics(
  job: Job,
): Promise<JobDocumentDiagnostics> {
  const policy = resolveDocumentPolicy({
    source: job.source,
    title: job.title,
    employer: job.employer,
    jobDescription: job.jobDescription,
    jobUrl: job.jobUrl,
    applicationLink: job.applicationLink,
    location: job.location,
    resumeTargetPagesOverride: job.resumeTargetPagesOverride,
  });
  const exists = await pdfExists(job.id);
  const pageCount = exists ? await countPdfPages(getPdfPath(job.id)) : null;
  const tailoredSkillGroups = parseTailoredSkillGroups(job.tailoredSkills);
  const tailoredExperience = parseTailoredExperience(job.tailoredExperience);
  const tailoredExperienceBulletCount = tailoredExperience.reduce(
    (sum, item) => sum + item.bullets.length,
    0,
  );
  const minTwoPageExperienceBullets =
    tailoredExperience.length > 0 ? Math.max(22, tailoredExperience.length * 7) : 22;
  const estimatedResumeWords =
    countWords(job.tailoredSummary) +
    countWords(parseTailoredSkillsText(job.tailoredSkills)) +
    tailoredExperience.reduce(
      (sum, item) => sum + item.bullets.reduce((inner, bullet) => inner + countWords(bullet), 0),
      0,
    );
  const skillsState = await getDesignResumeSkillsState(
    policy.resumeTargetPages,
  );
  const resumePlan = await resolveResumeGenerationDecisionForJob(job, {
    includeEvidenceReferences: true,
  });
  const canRenderTailoredSkills = tailoredSkillGroups > 0;
  const storedAlignment = parseAlignmentReport(job.resumeAlignmentReport);
  const serviceFit = parseServiceFitReport(job.resumeServiceFitReport);
  const storedAlignmentIsCurrent =
    storedAlignment?.engineVersion === SEMANTIC_QUALIFICATION_ENGINE_VERSION;
  const alignment = storedAlignmentIsCurrent
    ? storedAlignment
    : await buildFallbackAlignmentReport(job);

  const issues: string[] = [];
  const recommendations: string[] = [];

  if (pageCount !== null && pageCount > policy.resumeTargetPages) {
    issues.push(
      `Generated PDF is ${pageCount} pages, above the ${policy.resumeTargetPages}-page policy.`,
    );
    recommendations.push("Regenerate after compacting the resume content.");
  }

  if (pageCount === 2 && policy.resumeTargetPages === 2) {
    if (
      tailoredExperienceBulletCount > 0 &&
      tailoredExperienceBulletCount < minTwoPageExperienceBullets
    ) {
      issues.push(
        `Two-page resume is sparse: ${tailoredExperienceBulletCount} experience bullets is below the ${minTwoPageExperienceBullets}-bullet two-page fill target.`,
      );
      recommendations.push(
        "Regenerate materials so the content plan can add source-backed experience depth instead of leaving a sparse second page.",
      );
    }
    if (estimatedResumeWords > 0 && estimatedResumeWords < 840) {
      issues.push(
        `Two-page resume content is short (${estimatedResumeWords} estimated words); master-style two-page resumes usually need fuller experience bullets.`,
      );
    }
  }

  if (
    pageCount === 2 &&
    policy.resumeTargetPages === 2 &&
    tailoredSkillGroups > 0
  ) {
    issues.push(
      "Resume is two pages, but the second page may be sparse if skills are not rendered.",
    );
  }

  if (
    tailoredSkillGroups > 0 &&
    skillsState.hidden === true &&
    skillsState.itemCount === 0
  ) {
    issues.push(
      "Tailored skills exist, but the current Design Resume template has a hidden empty skills section.",
    );
    recommendations.push(
      "Regenerate materials so Job Ops can create and show the skills section.",
    );
  }

  if (tailoredSkillGroups === 0) {
    recommendations.push("Run Tailoring before generating final materials.");
  }

  if (!storedAlignment && alignment) {
    recommendations.push(
      "Resume match was computed live because this job does not have a saved alignment report yet.",
    );
  }
  if (storedAlignment && !storedAlignmentIsCurrent) {
    issues.push("Alignment report stale; regenerate resume content.");
    recommendations.push(
      "Run Regenerate Materials to refresh the resume alignment score.",
    );
  }

  if (alignment?.status === "failed") {
    issues.push(
      `Resume match is weak (${alignment.score}/100); missing ${alignment.missingRequired.length} required qualifications.`,
    );
    recommendations.push("Review the missing qualifications before applying.");
  } else if (alignment?.status === "warning") {
    issues.push(`Resume match is partial (${alignment.score}/100).`);
    recommendations.push("Check partial or missing qualifications before applying.");
  }

  return {
    jobId: job.id,
    policy,
    pdf: {
      exists,
      pageCount,
      targetPages: policy.resumeTargetPages,
      exceedsTarget:
        pageCount !== null ? pageCount > policy.resumeTargetPages : false,
    },
    skills: {
      tailoredSkillGroups,
      designResumeSkillsHidden: skillsState.hidden,
      designResumeSkillItems: skillsState.itemCount,
      canRenderTailoredSkills,
    },
    alignment,
    serviceFit,
    resumePlan,
    issues,
    recommendations,
  };
}
