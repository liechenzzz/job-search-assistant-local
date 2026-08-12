import type { ResumeGenerationDecision } from "@shared/resume-generation-decision.js";
import type {
  ExperienceBulletBundle,
  ExperienceCapabilityDigest,
  JdKeywordProfile,
  JdNormalizedRequirement,
  JdQualificationProfile,
  ResumeContentPlan,
  ResumeContentPlanExperienceAllocation,
  ResumeContentPlanRequirement,
  ResumeExperienceAllocationKind,
  ResumeProfile,
  ResumeRequirementTier,
  SelectedResumeEvidence,
} from "@shared/types";

export type ResumeContentPlanExperienceSource = {
  id: string;
  sourceText: string;
};

type VisibleExperience = {
  id: string;
  label: string;
  company: string;
  position: string;
  text: string;
};

const CATEGORY_WEIGHTS: Record<string, number> = {
  experience: 18,
  responsibility: 18,
  tool: 16,
  domain: 14,
  skill: 14,
  education: 10,
  soft_skill: 6,
};

const FIT_WEIGHTS: Record<string, number> = {
  direct: 32,
  transferable: 18,
  weak: 2,
  unsupported: 0,
};

const CONFIDENCE_WEIGHTS: Record<string, number> = {
  high: 8,
  medium: 4,
  low: 0,
};

export function buildResumeContentPlan(args: {
  profile: ResumeProfile;
  qualificationProfile: JdQualificationProfile;
  keywordProfile: JdKeywordProfile;
  selectedEvidence: SelectedResumeEvidence[];
  sourceExperiences: ResumeContentPlanExperienceSource[];
  experienceDigests?: ExperienceCapabilityDigest[];
  generationDecision: ResumeGenerationDecision;
}): ResumeContentPlan {
  const targetPages = args.generationDecision.targetPages;
  const requirements = buildRequirementPlans(args);
  const experiences = collectVisibleExperiences(
    args.profile,
    args.sourceExperiences,
  );
  const experienceAllocations = allocateExperiences({
    experiences,
    requirements,
    selectedEvidence: args.selectedEvidence,
    experienceDigests: args.experienceDigests ?? [],
    targetPages,
    keywordProfile: args.keywordProfile,
  });
  const totalExperienceBullets = experienceAllocations.reduce(
    (sum, item) => sum + item.bulletBudget,
    0,
  );
  const bulletBundleCandidates = buildExperienceBulletBundleCandidates({
    allocations: experienceAllocations,
    requirements,
    selectedEvidence: args.selectedEvidence,
    experienceDigests: args.experienceDigests ?? [],
    targetPages,
  });
  const bulletBudgets = Object.fromEntries(
    experienceAllocations.map((item) => [item.experienceId, item.bulletBudget]),
  );
  const pageFillTarget = buildPageFillTarget({
    targetPages,
    totalExperienceBullets,
    totalBundleCandidates: bulletBundleCandidates.length,
  });
  return {
    targetPages,
    requirementTiers: requirements,
    experienceAllocations,
    sectionBudgets:
      targetPages === 1
        ? {
            summaryWords: { min: 45, max: 65 },
            skillGroups: { min: 3, max: 3 },
            experienceBullets: {
              min: totalExperienceBullets,
              max: totalExperienceBullets,
            },
          }
        : {
            summaryWords: { min: 95, max: 140 },
            skillGroups: { min: 3, max: 3 },
            experienceBullets: {
              min: totalExperienceBullets,
              max: totalExperienceBullets,
            },
          },
    pageFillTarget,
    bulletBundleCandidates,
    densityTargets: buildDensityTargets({
      targetPages,
      totalBundleCandidates: bulletBundleCandidates.length,
    }),
    coverageTargets: {
      coreRequirementIds: requirements
        .filter((item) => item.tier === "core")
        .map((item) => item.requirementId),
      majorRequirementIds: requirements
        .filter((item) => item.tier === "major")
        .map((item) => item.requirementId),
      relevantExperienceIds: experienceAllocations
        .filter((item) => item.kind === "primary" || item.kind === "supporting")
        .map((item) => item.experienceId),
    },
    bulletBudgets,
    softenedRequirements: requirements
      .filter((item) => item.fit === "transferable")
      .map((item) => item.requirement),
    omittedOrDeemphasizedItems: experienceAllocations
      .filter(
        (
          item,
        ): item is ResumeContentPlanExperienceAllocation & {
          kind: "background" | "omit";
        } => item.kind === "background" || item.kind === "omit",
      )
      .map((item) => ({
        id: item.experienceId,
        label: item.label,
        action: item.kind,
        reason: item.reason,
      })),
    blockedClaims: Array.from(
      new Set(
        requirements.flatMap((item) =>
          item.tier === "blocked"
            ? item.blockedClaims.length
              ? item.blockedClaims
              : [item.requirement]
            : item.blockedClaims,
        ),
      ),
    ).slice(0, 24),
  };
}

export function formatResumeContentPlanForPrompt(
  plan: ResumeContentPlan,
): string {
  const requirements = plan.requirementTiers
    .slice(0, 12)
    .map(
      (item) =>
        `- ${item.requirementId} | ${item.tier} | score=${item.emphasisScore} | fit=${item.fit}/${item.confidence} | sections=${item.targetSections.join(", ")} | bulletBudget=${item.bulletBudget}: ${item.requirement}`,
    )
    .join("\n");
  const experiences = plan.experienceAllocations
    .map(
      (item) =>
        `- ${item.experienceId} | ${item.kind} | fit=${item.fitLevel ?? item.kind} | score=${item.experienceFitScore} | bulletBudget=${item.bulletBudget} | themes=${(item.requiredBulletThemes ?? []).slice(0, 5).join("; ") || "none"}: ${item.label}. ${item.reason}`,
    )
    .join("\n");
  const omitted = plan.omittedOrDeemphasizedItems.length
    ? plan.omittedOrDeemphasizedItems
        .map((item) => `- ${item.id} | ${item.action}: ${item.reason}`)
        .join("\n")
    : "None.";
  return [
    "RESUME CONTENT PLAN (deterministic; obey these budgets before writing style):",
    `Target pages: ${plan.targetPages}`,
    `Summary: ${plan.sectionBudgets.summaryWords.min}-${plan.sectionBudgets.summaryWords.max} words`,
    `Skills: ${plan.sectionBudgets.skillGroups.min}-${plan.sectionBudgets.skillGroups.max} groups`,
    `Experience bullets: ${plan.sectionBudgets.experienceBullets.min}-${plan.sectionBudgets.experienceBullets.max} total`,
    plan.pageFillTarget
      ? `Page fill target: ${plan.pageFillTarget.mode}; relevantBundleCandidates=${plan.bulletBundleCandidates?.length ?? 0}; totalWords=${plan.pageFillTarget.minTotalWords}-${plan.pageFillTarget.targetTotalWords}; bulletWords=${plan.pageFillTarget.bulletWordTarget.min}-${plan.pageFillTarget.bulletWordTarget.max}. ${plan.pageFillTarget.reason}`
      : "",
    plan.densityTargets
      ? `Density target: experienceWords>=${plan.densityTargets.minExperienceWords}; avgExperienceBulletWords>=${plan.densityTargets.minAverageBulletWords}; candidateOpportunities>=${plan.densityTargets.minRelevantBundleCandidates}. ${plan.densityTargets.reason}`
      : "",
    "",
    "Requirement tiers:",
    requirements || "No requirements.",
    "",
    "Experience allocations:",
    experiences || "No visible experiences.",
    "",
    "Softened transferable requirements:",
    plan.softenedRequirements.length
      ? plan.softenedRequirements.map((item) => `- ${item}`).join("\n")
      : "None.",
    "",
    "Blocked claims:",
    plan.blockedClaims.length
      ? plan.blockedClaims.map((item) => `- ${item}`).join("\n")
      : "None.",
    "",
    "Omitted/deemphasized experience:",
    omitted,
    "",
    "Rules: Treat bulletBudget as a suggested density hint, not a hard cap. Select from the bundle candidates to cover JD themes and evidence richness. For full two-page resumes, prefer reference-density bullets that combine source-backed task, method/tool/data, output, and audience/decision value. Skills should stay compact: exactly 3 specific master-style groups, not broad filler categories. Core requirements need visible coverage if evidence exists. Blocked requirements cannot become concrete claims.",
  ].join("\n");
}

function buildRequirementPlans(args: {
  qualificationProfile: JdQualificationProfile;
  keywordProfile: JdKeywordProfile;
  selectedEvidence: SelectedResumeEvidence[];
}): ResumeContentPlanRequirement[] {
  const normalized = getRequirements(args.qualificationProfile);
  const jdText = [
    ...args.qualificationProfile.required,
    ...args.qualificationProfile.preferred,
    ...args.qualificationProfile.keywords,
    ...args.keywordProfile.requiredKeywords,
    ...args.keywordProfile.experienceFocus,
    ...args.keywordProfile.domainKeywordsPresent,
  ].join(" ");
  const plans = normalized.map((requirement, index) => {
    const evidence = args.selectedEvidence.find(
      (item) =>
        item.requirementId === requirement.id ||
        normalize(item.requirement) === normalize(requirement.text),
    );
    const fit = evidence?.fit ?? statusFit(evidence?.status);
    const confidence = evidence?.confidence ?? "low";
    const repetition = countRequirementMentions(jdText, requirement.text);
    const emphasisScore = Math.round(
      requirement.priority * 10 +
        (requirement.mustHave ? 24 : 8) +
        (CATEGORY_WEIGHTS[requirement.category] ?? 10) +
        (FIT_WEIGHTS[fit] ?? 0) +
        (CONFIDENCE_WEIGHTS[confidence] ?? 0) +
        Math.min(20, repetition * 5) -
        index,
    );
    const tier = tierForRequirement({
      emphasisScore,
      fit,
      mustHave: requirement.mustHave,
      priority: requirement.priority,
    });
    return {
      requirementId: requirement.id,
      requirement: requirement.text,
      category: requirement.category,
      tier,
      emphasisScore,
      fit,
      confidence,
      targetSections: requirement.targetSections,
      bulletBudget: bulletBudgetForRequirement(tier, fit, emphasisScore),
      reason: reasonForRequirement(tier, fit, repetition),
      allowedClaims: evidence?.allowedClaims ?? [],
      blockedClaims: evidence?.blockedClaims ?? [],
    };
  });

  return plans.sort((a, b) => b.emphasisScore - a.emphasisScore).slice(0, 12);
}

function allocateExperiences(args: {
  experiences: VisibleExperience[];
  requirements: ResumeContentPlanRequirement[];
  selectedEvidence: SelectedResumeEvidence[];
  experienceDigests: ExperienceCapabilityDigest[];
  targetPages: 1 | 2;
  keywordProfile: JdKeywordProfile;
}): ResumeContentPlanExperienceAllocation[] {
  const directRequirements = args.requirements.filter(
    (item) => item.tier === "core" || item.tier === "major",
  );
  const digestById = new Map(
    args.experienceDigests.map((digest) => [digest.experienceId, digest]),
  );
  const allocations = args.experiences.map((experience, index) => {
    const digest = digestById.get(experience.id);
    const covered = directRequirements.filter((requirement) =>
      digest
        ? digest.matchedRequirementIds.includes(requirement.requirementId)
        : experienceMatchesRequirement({
            experience,
            requirement,
            selectedEvidence: args.selectedEvidence,
          }),
    );
    const evidenceChunkIds = Array.from(
      new Set([
        ...(digest?.sourceChunkIds ?? []),
        ...args.selectedEvidence
          .filter((item) =>
            covered.some(
              (requirement) => requirement.requirementId === item.requirementId,
            ),
          )
          .flatMap((item) => item.chunks.map((chunk) => chunk.chunkId)),
      ]),
    ).slice(0, 8);
    const roleFamilyBonus =
      args.keywordProfile.roleFamily !== "general" ? 4 : 0;
    const experienceFitScore = Math.round(
      covered.reduce((sum, item) => sum + item.emphasisScore, 0) +
        evidenceChunkIds.length * 4 +
        (digest?.recommendedBulletThemes.length ?? 0) * 2 +
        (digest?.coreClaims.length ?? 0) +
        fitLevelBonus(digest?.fitLevel) +
        roleFamilyBonus -
        index * 2,
    );
    const kind = kindForExperience({
      score: experienceFitScore,
      coveredCount: covered.length,
      index,
      targetPages: args.targetPages,
      digest,
    });
    const bulletBudget = bulletBudgetForExperience({
      kind,
      coveredCount: covered.length,
      score: experienceFitScore,
      targetPages: args.targetPages,
    });
    return {
      experienceId: experience.id,
      label: experience.label,
      kind,
      digestId: digest?.experienceId,
      fitLevel: digest?.fitLevel ?? kindToFitLevel(kind),
      experienceFitScore,
      bulletBudget,
      minBulletBudget: minBudget(kind),
      maxBulletBudget: maxBudget(kind, args.targetPages),
      requiredBulletThemes: (digest?.recommendedBulletThemes ?? []).slice(
        0,
        bulletBudget,
      ),
      coveredRequirementIds: covered.map((item) => item.requirementId),
      evidenceChunkIds,
      reason: reasonForExperience(kind, covered, digest),
    };
  });

  return allocations;
}

function buildPageFillTarget(args: {
  targetPages: 1 | 2;
  totalExperienceBullets: number;
  totalBundleCandidates: number;
}): ResumeContentPlan["pageFillTarget"] {
  if (args.targetPages === 1) {
    return {
      mode: "compact_one_page",
      minExperienceBullets: args.totalExperienceBullets,
      targetExperienceBullets: args.totalExperienceBullets,
      minTotalWords: 520,
      targetTotalWords: 680,
      bulletWordTarget: { min: 18, max: 28 },
      reason: "One-page resumes prioritize compact ATS readability.",
    };
  }
  const minExperienceBullets = Math.min(
    15,
    Math.max(args.totalExperienceBullets, args.totalBundleCandidates),
  );
  const targetExperienceBullets = Math.max(
    args.totalExperienceBullets,
    Math.min(Math.max(args.totalBundleCandidates, 15), 24),
  );
  return {
    mode: "full_two_page",
    minExperienceBullets,
    targetExperienceBullets,
    minTotalWords: 860,
    targetTotalWords: 1030,
    bulletWordTarget: { min: 26, max: 42 },
    reason:
      "Two-page resumes should resemble the master/reference density: fuller experience bullets, compact skills, and no sparse second page.",
  };
}

function buildDensityTargets(args: {
  targetPages: 1 | 2;
  totalBundleCandidates: number;
}): NonNullable<ResumeContentPlan["densityTargets"]> {
  if (args.targetPages === 1) {
    return {
      minExperienceWords: 360,
      targetExperienceWords: 480,
      minAverageBulletWords: 18,
      targetAverageBulletWords: 24,
      minRelevantBundleCandidates: Math.min(
        10,
        Math.max(0, args.totalBundleCandidates),
      ),
      reason:
        "One-page resumes should stay compact while still using evidence-rich bullets.",
    };
  }
  return {
    minExperienceWords: 620,
    targetExperienceWords: 700,
    minAverageBulletWords: 26,
    targetAverageBulletWords: 32,
    minRelevantBundleCandidates: 15,
    reason:
      "Two-page resumes should be filled by evidence-rich experience content, not by broad skills or filler bullets.",
  };
}

function buildExperienceBulletBundleCandidates(args: {
  allocations: ResumeContentPlanExperienceAllocation[];
  requirements: ResumeContentPlanRequirement[];
  selectedEvidence: SelectedResumeEvidence[];
  experienceDigests: ExperienceCapabilityDigest[];
  targetPages: 1 | 2;
}): ExperienceBulletBundle[] {
  const requirementsById = new Map(
    args.requirements.map((item) => [item.requirementId, item]),
  );
  const evidenceByRequirement = new Map<string, SelectedResumeEvidence[]>();
  for (const item of args.selectedEvidence) {
    if (item.status !== "selected" && item.status !== "transferable_only")
      continue;
    for (const key of uniqueStrings([
      item.requirementId,
      normalize(item.requirement),
    ])) {
      evidenceByRequirement.set(key, [
        ...(evidenceByRequirement.get(key) ?? []),
        item,
      ]);
    }
  }
  const digestByComparableId = new Map(
    args.experienceDigests.map((digest) => [
      comparableExperienceId(digest.experienceId),
      digest,
    ]),
  );
  const bundles: ExperienceBulletBundle[] = [];
  for (const allocation of args.allocations) {
    if (allocation.kind === "omit" || allocation.bulletBudget <= 0) continue;
    const digest = digestByComparableId.get(
      comparableExperienceId(allocation.experienceId),
    );
    const requirementIds = uniqueStrings([
      ...allocation.coveredRequirementIds,
      ...(digest?.matchedRequirementIds ?? []),
    ]);
    const evidenceItems = uniqueEvidence(
      requirementIds.flatMap((id) => [
        ...(evidenceByRequirement.get(id) ?? []),
        ...(evidenceByRequirement.get(
          normalize(requirementsById.get(id)?.requirement ?? ""),
        ) ?? []),
      ]),
    );
    const baseChunkIds = uniqueStrings([
      ...allocation.evidenceChunkIds,
      ...(digest?.sourceChunkIds ?? []),
      ...evidenceItems.flatMap((item) =>
        item.chunks.map((chunk) => chunk.chunkId),
      ),
    ]);
    const blockedClaims = uniqueStrings([
      ...(digest?.blockedClaims ?? []),
      ...evidenceItems.flatMap((item) => item.blockedClaims ?? []),
      ...requirementIds.flatMap(
        (id) => requirementsById.get(id)?.blockedClaims ?? [],
      ),
    ]).slice(0, 6);
    const claimEntries = uniqueStrings([
      ...(digest?.recommendedBulletThemes ?? []),
      ...(digest?.coreClaims ?? []),
      ...(digest?.transferableClaims ?? []),
      ...evidenceItems.flatMap((item) => item.allowedClaims ?? []),
      ...evidenceItems.flatMap((item) =>
        item.chunks.map((chunk) => truncate(chunk.rawText, 190)),
      ),
    ]).filter((claim) => !isBlockedClaim(claim, blockedClaims));

    const claimsByTheme = new Map<string, string[]>();
    for (const claim of claimEntries) {
      const theme = claimTheme(claim, requirementIds, requirementsById);
      claimsByTheme.set(
        theme,
        uniqueStrings([...(claimsByTheme.get(theme) ?? []), claim]).slice(0, 3),
      );
    }

    for (const [theme, claims] of claimsByTheme) {
      const matchedRequirementIds = matchedRequirementsForClaim(
        claims.join(" "),
        requirementIds,
        requirementsById,
      );
      const selectedRequirementIds = matchedRequirementIds.length
        ? matchedRequirementIds
        : requirementIds.slice(0, 3);
      const relevantEvidence = uniqueEvidence(
        selectedRequirementIds.flatMap((id) => [
          ...(evidenceByRequirement.get(id) ?? []),
          ...(evidenceByRequirement.get(
            normalize(requirementsById.get(id)?.requirement ?? ""),
          ) ?? []),
        ]),
      );
      const fit = fitForBundle(relevantEvidence, allocation, digest);
      if (fit === "weak" || fit === "unsupported") continue;
      const sourceChunkIds = uniqueStrings([
        ...baseChunkIds,
        ...relevantEvidence.flatMap((item) =>
          item.chunks.map((chunk) => chunk.chunkId),
        ),
      ]).slice(0, 6);
      if (sourceChunkIds.length === 0) continue;
      bundles.push({
        bundleId: `${allocation.experienceId}:bundle:${bundles.length + 1}`,
        experienceId: allocation.experienceId,
        theme,
        requiredClaims: claims.slice(
          0,
          recommendedClaimCount(args.targetPages, allocation.kind),
        ),
        sourceChunkIds,
        anchorId: relevantEvidence
          .flatMap((item) =>
            item.chunks.map((chunk) => chunk.experienceAnchorId),
          )
          .find((id): id is string => Boolean(id)),
        matchedRequirementIds: selectedRequirementIds,
        fit,
        confidence: confidenceForBundle(relevantEvidence, digest),
        blockedClaims,
        recommendedDepth: recommendedDepthForBundle({
          fit,
          allocation,
          targetPages: args.targetPages,
        }),
        reason: `${allocation.label} can support ${theme} through ${fit} evidence.`,
      });
    }
  }
  return uniqueBundles(bundles)
    .sort(
      (a, b) =>
        bundlePriority(b, requirementsById) -
        bundlePriority(a, requirementsById),
    )
    .slice(0, 48);
}

function comparableExperienceId(id: string | undefined): string {
  return normalize(id ?? "").replace(/^(?:experience|exp)[-_]/, "");
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = normalize(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function isBlockedClaim(claim: string, blockedClaims: string[]): boolean {
  const normalizedClaim = normalize(claim);
  return blockedClaims.some((blocked) => {
    const normalizedBlocked = normalize(blocked);
    return (
      normalizedBlocked.length > 0 &&
      normalizedClaim.includes(normalizedBlocked)
    );
  });
}

function claimTheme(
  claim: string,
  requirementIds: string[],
  requirementsById: Map<string, ResumeContentPlanRequirement>,
): string {
  const claimText = normalize(claim);
  const matchedRequirement = requirementIds
    .map((id) => requirementsById.get(id))
    .filter((item): item is ResumeContentPlanRequirement => Boolean(item))
    .find((requirement) =>
      tokenize(requirement.requirement).some((term) =>
        claimText.includes(term),
      ),
    );
  if (matchedRequirement) return truncate(matchedRequirement.requirement, 80);
  const terms = tokenize(claim).slice(0, 5);
  return terms.length ? terms.join(" ") : truncate(claim, 80);
}

function matchedRequirementsForClaim(
  claim: string,
  requirementIds: string[],
  requirementsById: Map<string, ResumeContentPlanRequirement>,
): string[] {
  const claimText = normalize(claim);
  return requirementIds.filter((id) => {
    const requirement = requirementsById.get(id);
    if (!requirement) return false;
    const terms = tokenize(requirement.requirement).slice(0, 8);
    if (terms.length === 0) return false;
    return (
      terms.filter((term) => claimText.includes(term)).length >=
      Math.min(2, terms.length)
    );
  });
}

function fitForBundle(
  evidence: SelectedResumeEvidence[],
  allocation: ResumeContentPlanExperienceAllocation,
  digest?: ExperienceCapabilityDigest,
): ExperienceBulletBundle["fit"] {
  if (
    evidence.some((item) => (item.fit ?? statusFit(item.status)) === "direct")
  )
    return "direct";
  if (
    evidence.some(
      (item) => (item.fit ?? statusFit(item.status)) === "transferable",
    )
  ) {
    return "transferable";
  }
  if (digest?.confidence && digest.sourceChunkIds.length > 0) {
    return allocation.kind === "background" ? "transferable" : "direct";
  }
  return "unsupported";
}

function confidenceForBundle(
  evidence: SelectedResumeEvidence[],
  digest?: ExperienceCapabilityDigest,
): ExperienceBulletBundle["confidence"] {
  if (evidence.some((item) => item.confidence === "high")) return "high";
  if (evidence.some((item) => item.confidence === "medium")) return "medium";
  return digest?.confidence ?? "low";
}

function recommendedDepthForBundle(args: {
  fit: ExperienceBulletBundle["fit"];
  allocation: ResumeContentPlanExperienceAllocation;
  targetPages: 1 | 2;
}): ExperienceBulletBundle["recommendedDepth"] {
  if (args.targetPages === 1)
    return args.fit === "direct" ? "standard" : "concise";
  if (args.fit === "direct" && args.allocation.kind === "primary")
    return "deep";
  if (args.fit === "direct" || args.allocation.kind === "supporting")
    return "standard";
  return "concise";
}

function recommendedClaimCount(
  targetPages: 1 | 2,
  kind: ResumeExperienceAllocationKind,
): number {
  if (targetPages === 2 && kind === "primary") return 3;
  if (targetPages === 2) return 2;
  return 2;
}

function uniqueBundles(
  bundles: ExperienceBulletBundle[],
): ExperienceBulletBundle[] {
  const seen = new Set<string>();
  const out: ExperienceBulletBundle[] = [];
  for (const bundle of bundles) {
    const key = [
      comparableExperienceId(bundle.experienceId),
      normalize(bundle.theme),
      bundle.sourceChunkIds.slice(0, 3).sort().join("|"),
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bundle);
  }
  return out.map((bundle, index) => ({
    ...bundle,
    bundleId: `${bundle.experienceId}:bundle:${index + 1}`,
  }));
}

function uniqueEvidence(
  items: SelectedResumeEvidence[],
): SelectedResumeEvidence[] {
  const seen = new Set<string>();
  const out: SelectedResumeEvidence[] = [];
  for (const item of items) {
    const key = item.requirementId ?? normalize(item.requirement);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function bundlePriority(
  bundle: ExperienceBulletBundle,
  requirementsById: Map<string, ResumeContentPlanRequirement>,
): number {
  const fitScore =
    bundle.fit === "direct" ? 40 : bundle.fit === "transferable" ? 22 : 0;
  const confidenceScore =
    bundle.confidence === "high" ? 12 : bundle.confidence === "medium" ? 6 : 0;
  const requirementScore = bundle.matchedRequirementIds.reduce(
    (sum, id) => sum + (requirementsById.get(id)?.emphasisScore ?? 0),
    0,
  );
  const depthScore =
    bundle.recommendedDepth === "deep"
      ? 8
      : bundle.recommendedDepth === "standard"
        ? 4
        : 0;
  return (
    fitScore +
    confidenceScore +
    requirementScore +
    depthScore +
    bundle.sourceChunkIds.length
  );
}

function getRequirements(
  profile: JdQualificationProfile,
): JdNormalizedRequirement[] {
  if (profile.requirements?.length) return profile.requirements.slice(0, 12);
  return [
    ...profile.required.slice(0, 8).map((text, index) => ({
      id: `req-${index + 1}`,
      text,
      category: "experience" as const,
      priority: 3,
      targetSections: ["summary", "experience", "skills"],
      mustHave: true,
      evidenceNeeded: "direct" as const,
    })),
    ...profile.preferred.slice(0, 4).map((text, index) => ({
      id: `pref-${index + 1}`,
      text,
      category: "skill" as const,
      priority: 2,
      targetSections: ["experience", "skills"],
      mustHave: false,
      evidenceNeeded: "transferable" as const,
    })),
  ].slice(0, 12);
}

function collectVisibleExperiences(
  profile: ResumeProfile,
  sourceExperiences: ResumeContentPlanExperienceSource[],
): VisibleExperience[] {
  return (
    profile.sections?.experience?.items
      ?.filter((item) => {
        const record = item as typeof item & { hidden?: boolean };
        return item.visible !== false && record.hidden !== true;
      })
      .map((item, index) => {
        const record = item as typeof item & {
          description?: string;
          period?: string;
        };
        const sourceText =
          sourceExperiences.find((source) => source.id === item.id)
            ?.sourceText ??
          stripHtml(
            [item.summary, record.description].filter(Boolean).join(" "),
          );
        const id = item.id || `experience-${index}`;
        const label = [item.position, item.company]
          .filter(Boolean)
          .join(" at ");
        return {
          id,
          label: label || id,
          company: item.company ?? "",
          position: item.position ?? "",
          text: [item.company, item.position, sourceText]
            .filter(Boolean)
            .join(" "),
        };
      }) ?? []
  );
}

function experienceMatchesRequirement(args: {
  experience: VisibleExperience;
  requirement: ResumeContentPlanRequirement;
  selectedEvidence: SelectedResumeEvidence[];
}): boolean {
  const experienceText = normalize(args.experience.text);
  const requirementTerms = tokenize(args.requirement.requirement);
  const lexicalOverlap = requirementTerms.filter((term) =>
    experienceText.includes(term),
  ).length;
  if (lexicalOverlap >= 2) return true;
  return args.selectedEvidence.some((item) => {
    if (item.requirementId !== args.requirement.requirementId) return false;
    return item.chunks.some((chunk) => {
      const chunkText = normalize(chunk.rawText);
      return (
        (args.experience.company &&
          chunkText.includes(normalize(args.experience.company))) ||
        (args.experience.position &&
          chunkText.includes(normalize(args.experience.position))) ||
        tokenize(args.experience.text)
          .slice(0, 12)
          .some((term) => chunkText.includes(term))
      );
    });
  });
}

function tierForRequirement(args: {
  emphasisScore: number;
  fit: string;
  mustHave: boolean;
  priority: number;
}): ResumeRequirementTier {
  if (args.fit === "weak" || args.fit === "unsupported") return "blocked";
  if (args.fit === "direct" && (args.mustHave || args.emphasisScore >= 82)) {
    return "core";
  }
  if (
    args.fit === "direct" ||
    args.fit === "transferable" ||
    args.priority >= 2
  ) {
    return "major";
  }
  return "minor";
}

function kindForExperience(args: {
  score: number;
  coveredCount: number;
  index: number;
  targetPages: 1 | 2;
  digest?: ExperienceCapabilityDigest;
}): ResumeExperienceAllocationKind {
  if (args.digest?.fitLevel === "primary") return "primary";
  if (args.digest?.fitLevel === "relevant") return "supporting";
  if (args.digest?.fitLevel === "background") return "background";
  if (args.score >= 95 || args.coveredCount >= 2) return "primary";
  if (args.score >= 35 || args.coveredCount === 1) return "supporting";
  const supportingContinuityLimit = args.targetPages === 1 ? 2 : 3;
  if (args.index < supportingContinuityLimit) return "supporting";
  return "background";
}

function bulletBudgetForRequirement(
  tier: ResumeRequirementTier,
  fit: string,
  score: number,
): number {
  if (tier === "blocked") return 0;
  if (fit === "transferable") return 1;
  if (tier === "core" && score >= 95) return 2;
  if (tier === "core") return 1;
  return tier === "major" ? 1 : 0;
}

function bulletBudgetForExperience(args: {
  kind: ResumeExperienceAllocationKind;
  coveredCount: number;
  score: number;
  targetPages: 1 | 2;
}): number {
  if (args.targetPages === 2) {
    if (args.kind === "primary") {
      if (args.coveredCount >= 3 || args.score >= 180) return 10;
      if (args.coveredCount >= 2 || args.score >= 130) return 9;
      return 8;
    }
    if (args.kind === "supporting") return 7;
    if (args.kind === "background") return 5;
    return 0;
  }
  if (args.kind === "primary") {
    if (args.coveredCount >= 3 || args.score >= 180) return 8;
    if (args.coveredCount >= 2 || args.score >= 130) return 7;
    return 6;
  }
  if (args.kind === "supporting") return 5;
  if (args.kind === "background") return 4;
  return 0;
}

function minBudget(kind: ResumeExperienceAllocationKind): number {
  if (kind === "primary") return 6;
  if (kind === "supporting") return 5;
  if (kind === "background") return 4;
  return 0;
}

function maxBudget(
  kind: ResumeExperienceAllocationKind,
  targetPages: 1 | 2 = 1,
): number {
  if (targetPages === 2) {
    if (kind === "primary") return 10;
    if (kind === "supporting") return 8;
    if (kind === "background") return 6;
    return 0;
  }
  if (kind === "primary") return 8;
  if (kind === "supporting") return 5;
  if (kind === "background") return 4;
  return 0;
}

function fitLevelBonus(
  fitLevel: ExperienceCapabilityDigest["fitLevel"] | undefined,
): number {
  if (fitLevel === "primary") return 36;
  if (fitLevel === "relevant") return 18;
  return 0;
}

function kindToFitLevel(
  kind: ResumeExperienceAllocationKind,
): ExperienceCapabilityDigest["fitLevel"] {
  if (kind === "primary") return "primary";
  if (kind === "supporting") return "relevant";
  return "background";
}

function reasonForRequirement(
  tier: ResumeRequirementTier,
  fit: string,
  mentions: number,
): string {
  if (tier === "blocked") return `Blocked because evidence fit is ${fit}.`;
  if (tier === "core")
    return `Core because JD emphasis is high and evidence fit is ${fit}; mentions=${mentions}.`;
  if (tier === "major")
    return `Relevant enough to cover with ${fit} evidence; mentions=${mentions}.`;
  return `Minor requirement; include only if space remains; mentions=${mentions}.`;
}

function reasonForExperience(
  kind: ResumeExperienceAllocationKind,
  covered: ResumeContentPlanRequirement[],
  digest?: ExperienceCapabilityDigest,
): string {
  if (kind === "omit")
    return "Low JD overlap and not needed for compact resume evidence.";
  if (digest?.capabilitySummary) return digest.capabilitySummary;
  if (kind === "background")
    return "Kept for continuity with four concise evidence-grounded bullets.";
  if (covered.length === 0) {
    return "Kept with multiple bullets for recent/core experience continuity; exact JD overlap is uncertain.";
  }
  return `Covers ${covered
    .slice(0, 3)
    .map((item) => item.requirement)
    .join("; ")}`;
}

function statusFit(
  status: SelectedResumeEvidence["status"] | undefined,
): "direct" | "transferable" | "weak" | "unsupported" {
  if (status === "selected") return "direct";
  if (status === "transferable_only") return "transferable";
  if (status === "weak_evidence") return "weak";
  return "unsupported";
}

function countRequirementMentions(text: string, requirement: string): number {
  const haystack = normalize(text);
  const terms = tokenize(requirement).slice(0, 8);
  if (terms.length === 0) return 0;
  return terms.reduce((sum, term) => {
    const matches = haystack.match(
      new RegExp(`\\b${escapeRegExp(term)}\\b`, "g"),
    );
    return sum + (matches?.length ?? 0);
  }, 0);
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      normalize(text)
        .split(/[^a-z0-9+#.-]+/)
        .filter((term) => term.length >= 4)
        .filter((term) => !STOPWORDS.has(term)),
    ),
  );
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripHtml(text: string): string {
  return text
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOPWORDS = new Set([
  "with",
  "from",
  "that",
  "this",
  "will",
  "your",
  "have",
  "must",
  "able",
  "such",
  "work",
  "role",
  "team",
  "skills",
  "experience",
  "knowledge",
]);
