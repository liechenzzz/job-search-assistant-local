import type {
  JdKeywordProfile,
  TailoredExperienceItem,
} from "./types/jobs";

export type DomainGateResult = {
  text: string;
  changed: boolean;
};

export type DomainGateScanResult = {
  blockedTerms: string[];
  pattern: RegExp | null;
};

export type DomainGateResidualSeverity = "repairable" | "strict";

export type DomainGateResidual = {
  term: string;
  section: string;
  path: string;
  severity: DomainGateResidualSeverity;
  suggestedAction: string;
};

type DomainReplacementRule = {
  term: string;
  pattern: RegExp;
  replacement: string;
  severity: DomainGateResidualSeverity;
};

const DOMAIN_REPLACEMENT_RULES: DomainReplacementRule[] = [
  {
    term: "NOC",
    pattern: /\b(?:NOC|National Occupational Classification)\b/gi,
    replacement: "occupational classification",
    severity: "strict",
  },
  {
    term: "NAICS",
    pattern:
      /\b(?:NAICS|North American Industry Classification(?: System)?)\b/gi,
    replacement: "industry classification",
    severity: "strict",
  },
  {
    term: "RTRA",
    pattern: /\b(?:RTRA|Real Time Remote Access)\b/gi,
    replacement: "large-scale source data",
    severity: "strict",
  },
  {
    term: "municipal stakeholder",
    pattern: /\bmunicipal stakeholders?\b/gi,
    replacement: "stakeholders",
    severity: "repairable",
  },
  {
    term: "municipal",
    pattern: /\bmunicipal\b/gi,
    replacement: "regional",
    severity: "repairable",
  },
  {
    term: "public sector",
    pattern: /\bpublic sector\b/gi,
    replacement: "organizational",
    severity: "repairable",
  },
  {
    term: "economic development",
    pattern: /\beconomic development\b/gi,
    replacement: "regional strategy",
    severity: "repairable",
  },
  {
    term: "jurisdictional scan",
    pattern: /\bjurisdictional (?:scan|review)s?\b/gi,
    replacement: "comparative review",
    severity: "repairable",
  },
];

function blockedSet(profile: JdKeywordProfile): Set<string> {
  return new Set(profile.blockedUnlessPresent.map((term) => term.toLowerCase()));
}

function shouldApplyRule(
  rule: DomainReplacementRule,
  blockedTerms: Set<string>,
): boolean {
  const normalized = rule.term.toLowerCase();
  return (
    blockedTerms.has(normalized) ||
    Array.from(blockedTerms).some(
      (term) => normalized.includes(term) || term.includes(normalized),
    )
  );
}

function activeRules(profile: JdKeywordProfile): DomainReplacementRule[] {
  const blockedTerms = blockedSet(profile);
  return DOMAIN_REPLACEMENT_RULES.filter((rule) =>
    shouldApplyRule(rule, blockedTerms),
  );
}

export function applyDomainGateToText(
  text: string,
  profile: JdKeywordProfile,
): DomainGateResult {
  let next = text;

  for (const rule of activeRules(profile)) {
    next = next.replace(rule.pattern, rule.replacement);
  }

  next = next.replace(/\s+/g, " ").trim();
  return { text: next, changed: next !== text };
}

export function scanDomainGateResiduals(
  text: string,
  profile: JdKeywordProfile,
): DomainGateScanResult {
  const blockedTerms: string[] = [];
  let combinedPattern = "";

  for (const rule of activeRules(profile)) {
    const pattern = new RegExp(rule.pattern.source, "i");
    if (!pattern.test(text)) continue;
    blockedTerms.push(rule.term);
    combinedPattern = combinedPattern
      ? `${combinedPattern}|${rule.pattern.source}`
      : rule.pattern.source;
  }

  return {
    blockedTerms: Array.from(new Set(blockedTerms)),
    pattern: combinedPattern ? new RegExp(combinedPattern, "i") : null,
  };
}

export function scanDomainGateResidualFields(
  fields: Array<{ section: string; path: string; text: string }>,
  profile: JdKeywordProfile,
): DomainGateResidual[] {
  const residuals: DomainGateResidual[] = [];

  for (const field of fields) {
    for (const rule of activeRules(profile)) {
      const pattern = new RegExp(rule.pattern.source, "i");
      if (!pattern.test(field.text)) continue;
      residuals.push({
        term: rule.term,
        section: field.section,
        path: field.path,
        severity: rule.severity,
        suggestedAction:
          rule.severity === "strict"
            ? `Rewrite ${field.path} with JD-supported evidence; block PDF if this term remains.`
            : `Repair ${field.path} from JD qualifications and reference evidence.`,
      });
    }
  }

  return Array.from(
    new Map(
      residuals.map((item) => [
        `${item.term}|${item.section}|${item.path}`,
        item,
      ]),
    ).values(),
  );
}

export function applyDomainGateToSkills<
  T extends { name: string; keywords: string[] },
>(skills: T[], profile: JdKeywordProfile): { skills: T[]; changed: boolean } {
  let changed = false;
  const gated = skills.map((skill) => {
    const keywords = skill.keywords.map((keyword) => {
      const result = applyDomainGateToText(keyword, profile);
      changed = changed || result.changed;
      return result.text;
    });
    return { ...skill, keywords };
  });
  return { skills: gated, changed };
}

export function applyDomainGateToExperience(
  experience: TailoredExperienceItem[],
  profile: JdKeywordProfile,
): { experience: TailoredExperienceItem[]; changed: boolean } {
  let changed = false;
  const gated = experience.map((item) => {
    const bullets = item.bullets.map((bullet) => {
      const result = applyDomainGateToText(bullet, profile);
      changed = changed || result.changed;
      return result.text;
    });
    return { ...item, bullets };
  });
  return { experience: gated, changed };
}
