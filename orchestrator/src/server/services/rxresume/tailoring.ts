import { createId } from "@paralleldrive/cuid2";
import { applyDomainGateToText } from "@shared/jd-domain-gate.js";
import type {
  JdKeywordProfile,
  ResumeProjectCatalogItem,
  TailoredExperienceItem,
} from "@shared/types";
import { stripHtmlTags } from "@shared/utils/string";

type RecordLike = Record<string, unknown>;

export type TailoredSkillsInput =
  | Array<{ name: string; keywords: string[] }>
  | string
  | null
  | undefined;

export type TailorChunkInput = {
  headline?: string | null;
  summary?: string | null;
  skills?: TailoredSkillsInput;
  experience?: TailoredExperienceItem[] | string | null;
  jdKeywordProfile?: JdKeywordProfile | string | null;
};

export type ResumeProjectSelectionItem = ResumeProjectCatalogItem & {
  summaryText: string;
};

export function cloneResumeData<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function parseTailoredSkills(
  skills: TailoredSkillsInput,
): Array<RecordLike> | null {
  if (!skills) return null;
  const parsed = Array.isArray(skills)
    ? skills
    : typeof skills === "string"
      ? (JSON.parse(skills) as unknown)
      : null;
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(
    (item) => item && typeof item === "object",
  ) as RecordLike[];
}

function parseTailoredExperience(
  experience: TailorChunkInput["experience"],
): TailoredExperienceItem[] {
  if (!experience) return [];
  const parsed = Array.isArray(experience)
    ? experience
    : typeof experience === "string"
      ? (JSON.parse(experience) as unknown)
      : null;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const bullets = asArray(record.bullets)
        ?.filter((bullet): bullet is string => typeof bullet === "string")
        .map((bullet) => stripHtmlTags(bullet).trim())
        .filter(Boolean);
      return id && bullets?.length ? { id, bullets } : null;
    })
    .filter((item): item is TailoredExperienceItem => Boolean(item));
}

function bulletsToHtml(bullets: string[]): string {
  const items = bullets
    .map((bullet) => stripHtmlTags(bullet).trim())
    .filter(Boolean)
    .map((bullet) => `<li>${bullet}</li>`);
  return items.length > 0 ? `<ul>${items.join("")}</ul>` : "";
}

function parseJdKeywordProfile(
  value: TailorChunkInput["jdKeywordProfile"],
): JdKeywordProfile | null {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    const record = asRecord(parsed);
    if (
      !record ||
      typeof record.roleFamily !== "string" ||
      !Array.isArray(record.blockedUnlessPresent)
    ) {
      return null;
    }
    return parsed as JdKeywordProfile;
  } catch {
    return null;
  }
}

function gateTextValue(value: unknown, profile: JdKeywordProfile): unknown {
  if (typeof value !== "string") return value;
  return applyDomainGateToText(value, profile).text;
}

function gateField(
  record: RecordLike | null,
  key: string,
  profile: JdKeywordProfile,
): void {
  if (!record || !(key in record)) return;
  record[key] = gateTextValue(record[key], profile);
}

function gateKeywordArray(record: RecordLike | null, profile: JdKeywordProfile): void {
  if (!record || !Array.isArray(record.keywords)) return;
  record.keywords = record.keywords.map((keyword) =>
    gateTextValue(keyword, profile),
  );
}

function gateCommonContentFields(
  record: RecordLike | null,
  profile: JdKeywordProfile,
): void {
  gateField(record, "name", profile);
  gateField(record, "title", profile);
  gateField(record, "description", profile);
  gateField(record, "summary", profile);
  gateField(record, "proficiency", profile);
  gateField(record, "fluency", profile);
  gateKeywordArray(record, profile);
}

function gateExperienceItem(
  item: RecordLike | null,
  profile: JdKeywordProfile,
): void {
  if (!item) return;
  // Preserve company, role title, dates, and locations exactly.
  gateField(item, "description", profile);
  gateField(item, "summary", profile);
  gateKeywordArray(item, profile);

  const roles = asArray(item.roles);
  if (!roles) return;
  for (const rawRole of roles) {
    const role = asRecord(rawRole);
    gateField(role, "description", profile);
    gateField(role, "summary", profile);
    gateKeywordArray(role, profile);
  }
}

function gateEducationItem(
  item: RecordLike | null,
  profile: JdKeywordProfile,
): void {
  if (!item) return;
  // Preserve institution, degree, dates, and locations exactly.
  gateField(item, "description", profile);
  gateField(item, "summary", profile);
  gateKeywordArray(item, profile);
}

function gateProjectItem(
  item: RecordLike | null,
  profile: JdKeywordProfile,
): void {
  if (!item) return;
  // Project names are resume content, not employer identity.
  gateField(item, "name", profile);
  gateField(item, "title", profile);
  gateField(item, "description", profile);
  gateField(item, "summary", profile);
  gateKeywordArray(item, profile);
}

function gateSkillItem(
  item: RecordLike | null,
  profile: JdKeywordProfile,
): void {
  if (!item) return;
  gateField(item, "name", profile);
  gateField(item, "description", profile);
  gateField(item, "proficiency", profile);
  gateKeywordArray(item, profile);
}

function gateSectionItems(
  section: RecordLike | null,
  sectionKey: string,
  profile: JdKeywordProfile,
): void {
  const items = asArray(section?.items);
  if (!items) return;

  for (const raw of items) {
    const item = asRecord(raw);
    if (sectionKey === "experience") {
      gateExperienceItem(item, profile);
    } else if (sectionKey === "education") {
      gateEducationItem(item, profile);
    } else if (sectionKey === "projects") {
      gateProjectItem(item, profile);
    } else if (sectionKey === "skills") {
      gateSkillItem(item, profile);
    } else if (sectionKey === "profiles") {
      // Profile links/contact handles are identity fields and are not rendered
      // as resume evidence in the local LaTeX template.
      continue;
    } else {
      gateCommonContentFields(item, profile);
    }
  }
}

export function applyTailoredHeadline(
  resumeData: RecordLike,
  headline?: string | null,
): void {
  if (!headline) return;
  const basics = asRecord(resumeData.basics);
  if (!basics) return;
  basics.headline = headline;
  // Preserve current behavior for legacy consumers/templates that use label.
  basics.label = headline;
}

export function applyTailoredSummary(
  resumeData: RecordLike,
  summary?: string | null,
): void {
  if (!summary) return;
  const topSummary = asRecord(resumeData.summary);
  if (topSummary) {
    if (
      typeof topSummary.content === "string" ||
      topSummary.content === undefined
    ) {
      topSummary.content = summary;
      return;
    }
    if (
      typeof topSummary.value === "string" ||
      topSummary.value === undefined
    ) {
      topSummary.value = summary;
      return;
    }
  }

  const sections = asRecord(resumeData.sections);
  const summarySection = asRecord(sections?.summary);
  if (summarySection) {
    summarySection.content = summary;
    return;
  }
}

export function applyTailoredSkills(
  resumeData: RecordLike,
  tailoredSkills?: TailoredSkillsInput,
): void {
  const skills = parseTailoredSkills(tailoredSkills);
  if (!skills) return;

  const sections = asRecord(resumeData.sections);
  if (!sections) return;
  let skillsSection = asRecord(sections.skills);
  if (!skillsSection) {
    skillsSection = {
      title: "Skills",
      columns: 1,
      hidden: false,
      items: [],
    };
    sections.skills = skillsSection;
  }
  const existingItems = asArray(skillsSection.items) ?? [];
  const existing = existingItems
    .map((item) => asRecord(item))
    .filter((item): item is RecordLike => Boolean(item));

  const hasExistingTemplate = existing.length > 0;
  const template = existing[0] ?? {
    id: "",
    hidden: false,
    icon: "",
    name: "Skills",
    proficiency: "",
    level: 0,
    keywords: [],
  };
  skillsSection.hidden = false;

  skillsSection.items = skills.map((newSkill) => {
    const match =
      existing.find((item) => item.name === newSkill.name) ?? template;
    const next: RecordLike = { ...match };

    if ("id" in next) {
      const reusableMatchId =
        hasExistingTemplate && typeof match.id === "string" ? match.id : "";
      next.id =
        (typeof newSkill.id === "string" && newSkill.id) ||
        reusableMatchId ||
        createId();
    }
    if ("name" in next) {
      next.name =
        (typeof newSkill.name === "string" ? newSkill.name : "") ||
        (typeof match.name === "string" ? match.name : "");
    }
    if ("keywords" in next) {
      next.keywords = Array.isArray(newSkill.keywords)
        ? newSkill.keywords.filter((k) => typeof k === "string")
        : Array.isArray(match.keywords)
          ? match.keywords.filter((k) => typeof k === "string")
          : [];
    }

    if ("description" in next) {
      next.description =
        typeof newSkill.description === "string"
          ? newSkill.description
          : typeof match.description === "string"
            ? match.description
            : "";
    }
    if ("proficiency" in next) {
      next.proficiency =
        typeof newSkill.proficiency === "string"
          ? newSkill.proficiency
          : typeof newSkill.description === "string"
            ? newSkill.description
            : typeof match.proficiency === "string"
              ? match.proficiency
              : "";
    }
    if ("level" in next) {
      next.level =
        typeof newSkill.level === "number"
          ? newSkill.level
          : typeof match.level === "number"
            ? match.level
            : next.level;
    }
    if ("hidden" in next) {
      next.hidden =
        typeof newSkill.hidden === "boolean"
          ? newSkill.hidden
          : typeof match.hidden === "boolean"
            ? match.hidden
            : false;
    }

    return next;
  });
}

export function applyTailoredExperience(
  resumeData: RecordLike,
  tailoredExperience?: TailorChunkInput["experience"],
  profile?: JdKeywordProfile | null,
): void {
  const experience = parseTailoredExperience(tailoredExperience);
  if (experience.length === 0) return;
  const byId = new Map(experience.map((item) => [item.id, item.bullets]));
  const sections = asRecord(resumeData.sections);
  const experienceSection = asRecord(sections?.experience);
  const items = asArray(experienceSection?.items);
  if (!items) return;

  for (const [index, raw] of items.entries()) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id : "";
    let bullets = byId.get(id);
    if (!bullets || bullets.length === 0) {
      bullets = byId.get(String(index)) ?? [];
    }
    if (bullets.length === 0) continue;
    if (profile) {
      bullets = bullets.map((bullet) =>
        applyDomainGateToText(bullet, profile).text,
      );
    }
    item.description = bulletsToHtml(bullets);
    item.hidden = false;
  }

  if (experienceSection && "hidden" in experienceSection) {
    experienceSection.hidden = false;
  }
}

export function applyDomainGateToResumeData(
  resumeData: RecordLike,
  profile?: JdKeywordProfile | null,
): void {
  if (!profile) return;

  const basics = asRecord(resumeData.basics);
  gateField(basics, "headline", profile);
  gateField(basics, "label", profile);

  const topSummary = asRecord(resumeData.summary);
  if (topSummary) {
    gateField(topSummary, "content", profile);
    gateField(topSummary, "value", profile);
  }

  const sections = asRecord(resumeData.sections);
  const summarySection = asRecord(sections?.summary);
  if (summarySection) {
    gateField(summarySection, "content", profile);
    gateField(summarySection, "value", profile);
  }

  if (!sections) return;
  for (const [sectionKey, rawSection] of Object.entries(sections)) {
    gateSectionItems(asRecord(rawSection), sectionKey, profile);
  }
}

export function extractProjectsFromResume(resumeData: RecordLike): {
  catalog: ResumeProjectCatalogItem[];
  selectionItems: ResumeProjectSelectionItem[];
} {
  const sections = asRecord(resumeData.sections);
  const projectsSection = asRecord(sections?.projects);
  const items = asArray(projectsSection?.items);
  if (!items) return { catalog: [], selectionItems: [] };

  const catalog: ResumeProjectCatalogItem[] = [];
  const selectionItems: ResumeProjectSelectionItem[] = [];

  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;

    const name = typeof item.name === "string" ? item.name : id;
    const description =
      typeof item.description === "string" ? item.description : "";
    const date = typeof item.period === "string" ? item.period : "";

    const isVisibleInBase = !(typeof item.hidden === "boolean"
      ? item.hidden
      : false);

    const summaryRaw = description;

    const base: ResumeProjectCatalogItem = {
      id,
      name,
      description,
      date,
      isVisibleInBase,
    };
    catalog.push(base);
    selectionItems.push({
      ...base,
      summaryText: stripHtmlTags(summaryRaw),
    });
  }

  return { catalog, selectionItems };
}

export function applyProjectVisibility(args: {
  resumeData: RecordLike;
  selectedProjectIds: ReadonlySet<string>;
  forceVisibleProjectsSection?: boolean;
}): void {
  const sections = asRecord(args.resumeData.sections);
  const projectsSection = asRecord(sections?.projects);
  const items = asArray(projectsSection?.items);
  if (!projectsSection || !items) return;

  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;

    if ("hidden" in item) {
      item.hidden = !args.selectedProjectIds.has(id);
    }
  }

  if (args.forceVisibleProjectsSection !== false) {
    if ("hidden" in projectsSection) {
      projectsSection.hidden = false;
    }
  }
}

export function applyTailoredChunks(args: {
  resumeData: RecordLike;
  tailoredContent: TailorChunkInput;
}): void {
  const profile = parseJdKeywordProfile(args.tailoredContent.jdKeywordProfile);
  applyTailoredSkills(args.resumeData, args.tailoredContent.skills);
  applyTailoredSummary(args.resumeData, args.tailoredContent.summary);
  applyTailoredHeadline(args.resumeData, args.tailoredContent.headline);
  applyTailoredExperience(
    args.resumeData,
    args.tailoredContent.experience,
    profile,
  );
  applyDomainGateToResumeData(args.resumeData, profile);
}
