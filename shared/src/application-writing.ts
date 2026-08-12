import type { ApplicationRoleFamily, RoleFramingMode } from "./types/settings";

export type ApplicationWritingSettings = {
  humanizerEnabled: boolean;
  impactFramingEnabled: boolean;
  roleFramingMode: RoleFramingMode;
  manualRoleFamily: ApplicationRoleFamily;
  customRoleFramingInstructions: string;
};

export type RoleDetectionInput = {
  title?: string | null;
  employer?: string | null;
  jobDescription?: string | null;
};

export type ApplicationWritingStrategy = {
  roleFamily: ApplicationRoleFamily;
  roleLabel: string;
  roleSource: "auto" | "manual" | "general";
  humanizerEnabled: boolean;
  impactFramingEnabled: boolean;
  metricHints: string[];
  customRoleFramingInstructions: string;
};

type RoleDefinition = {
  label: string;
  keywords: string[];
  guidance: string[];
  metricHints: string[];
};

export const APPLICATION_ROLE_FAMILY_LABELS: Record<
  ApplicationRoleFamily,
  string
> = {
  general: "General",
  public_sector_policy_economic_development:
    "Public sector / policy / economic development",
  market_insights_research: "Market / insights research",
  ai_digital_strategy: "AI / digital strategy",
  consulting_strategy: "Consulting / strategy",
  business_development_partnerships: "Business development / partnerships",
  data_analytics_operations: "Data analytics / operations",
  product_project_program: "Product / project / program",
  communications_content: "Communications / content",
  administration_coordination: "Administration / coordination",
  custom: "Custom",
};

const ROLE_DEFINITIONS: Record<ApplicationRoleFamily, RoleDefinition> = {
  general: {
    label: APPLICATION_ROLE_FAMILY_LABELS.general,
    keywords: [],
    guidance: [
      "Match the job description's language without copying it mechanically.",
      "Use concrete evidence from the profile and avoid unsupported claims.",
      "Prefer clear action, scope, output, audience, and outcome over generic strengths.",
    ],
    metricHints: [
      "data or workload volume",
      "number of sources or stakeholders",
      "deliverables created",
      "decisions or workflows supported",
    ],
  },
  public_sector_policy_economic_development: {
    label:
      APPLICATION_ROLE_FAMILY_LABELS.public_sector_policy_economic_development,
    keywords: [
      "policy",
      "public sector",
      "government",
      "municipal",
      "economic development",
      "labour market",
      "labor market",
      "workforce",
      "program evaluation",
      "briefing",
      "jurisdictional",
      "stakeholder",
      "kpi",
      "implementation",
      "regional",
      "naics",
      "noc",
    ],
    guidance: [
      "Frame evidence as decision support for public-sector, municipal, regional, policy, or program audiences.",
      "Prioritize briefing materials, implementation risk, regional comparison, KPIs, stakeholder synthesis, and evidence-based recommendations.",
      "Use domain terms such as NOC, NAICS, RTRA, Job Bank, jurisdictional scans, and economic development only when present in the profile or job context.",
    ],
    metricHints: [
      "regions or municipalities covered",
      "records, sectors, occupations, or policy documents reviewed",
      "briefing memos, evidence packs, maps, dashboards, or KPI frameworks",
      "decisions, trade-offs, or implementation risks clarified",
    ],
  },
  market_insights_research: {
    label: APPLICATION_ROLE_FAMILY_LABELS.market_insights_research,
    keywords: [
      "market research",
      "insights",
      "consumer",
      "customer experience",
      "survey",
      "questionnaire",
      "panel",
      "brand",
      "audience",
      "research operations",
      "data quality",
      "client reporting",
    ],
    guidance: [
      "Emphasize research delivery, data quality, study setup, client reporting, audience behavior, and clear so-what recommendations.",
      "Reduce government-heavy language unless the job asks for it.",
      "Show comfort with detail, validation, coordination, and turning mixed evidence into usable insights.",
    ],
    metricHints: [
      "studies, datasets, audiences, or segments handled",
      "questionnaires, reports, decks, or dashboards produced",
      "quality checks or validation steps completed",
      "client teams or decisions supported",
    ],
  },
  ai_digital_strategy: {
    label: APPLICATION_ROLE_FAMILY_LABELS.ai_digital_strategy,
    keywords: [
      "ai",
      "artificial intelligence",
      "generative",
      "automation",
      "digital strategy",
      "transformation",
      "workflow",
      "prototype",
      "chatbot",
      "knowledge base",
      "rag",
      "agent",
      "n8n",
      "python",
      "react",
    ],
    guidance: [
      "Emphasize reusable workflows, internal tools, knowledge retrieval, validation checkpoints, automation, and prototype-enabled decision support.",
      "Keep AI claims operational and specific; avoid broad transformation language unless backed by evidence.",
      "Tie technical work to adoption, repeatability, quality control, or stakeholder usability.",
    ],
    metricHints: [
      "workflows automated",
      "sources or project logic centralized",
      "tools, prototypes, or validation steps built",
      "manual handoffs or repeated explanations reduced",
    ],
  },
  consulting_strategy: {
    label: APPLICATION_ROLE_FAMILY_LABELS.consulting_strategy,
    keywords: [
      "consultant",
      "consulting",
      "strategy",
      "advisory",
      "business case",
      "operating model",
      "client",
      "recommendation",
      "deck",
      "workshop",
    ],
    guidance: [
      "Frame work around ambiguous problem structuring, analysis, client-ready recommendations, and executive communication.",
      "Show how evidence became options, trade-offs, implementation materials, or decisions.",
    ],
    metricHints: [
      "engagements, workstreams, or clients supported",
      "decks, memos, workshops, or evidence packs delivered",
      "strategic options or recommendations developed",
      "stakeholders or decision forums supported",
    ],
  },
  business_development_partnerships: {
    label: APPLICATION_ROLE_FAMILY_LABELS.business_development_partnerships,
    keywords: [
      "business development",
      "partnership",
      "sales",
      "pipeline",
      "crm",
      "lead",
      "prospect",
      "account",
      "market intelligence",
      "proposal",
      "go-to-market",
    ],
    guidance: [
      "Emphasize market intelligence, lead or partner research, value propositions, CRM discipline, proposals, and relationship support.",
      "Connect research outputs to targeting, positioning, pipeline, or partnership decisions.",
    ],
    metricHints: [
      "companies, accounts, regions, or leads researched",
      "strategies, proposals, or value propositions supported",
      "CRM records or contact lists maintained",
      "pipeline or partnership decisions informed",
    ],
  },
  data_analytics_operations: {
    label: APPLICATION_ROLE_FAMILY_LABELS.data_analytics_operations,
    keywords: [
      "data analyst",
      "analytics",
      "operations",
      "reporting",
      "dashboard",
      "sql",
      "python",
      "excel",
      "power bi",
      "tableau",
      "process improvement",
      "quality assurance",
      "kpi",
    ],
    guidance: [
      "Emphasize clean data pipelines, QA, reporting cadence, dashboards, operational decisions, and measurable process improvement.",
      "Tie tools to business questions, not tool lists.",
    ],
    metricHints: [
      "rows, files, dashboards, or KPIs handled",
      "reports automated or recurring processes improved",
      "quality checks completed",
      "teams or operational decisions supported",
    ],
  },
  product_project_program: {
    label: APPLICATION_ROLE_FAMILY_LABELS.product_project_program,
    keywords: [
      "product",
      "project manager",
      "program",
      "roadmap",
      "delivery",
      "agile",
      "scrum",
      "requirements",
      "implementation",
      "stakeholder management",
      "user needs",
    ],
    guidance: [
      "Emphasize requirements, stakeholder coordination, delivery discipline, user needs, implementation planning, and trade-off management.",
      "Show how research or analysis turned into shipped work, clearer scope, or better execution.",
    ],
    metricHints: [
      "projects, milestones, stakeholders, or workstreams coordinated",
      "requirements, plans, or implementation materials produced",
      "risks, dependencies, or user needs clarified",
      "delivery timelines or decisions supported",
    ],
  },
  communications_content: {
    label: APPLICATION_ROLE_FAMILY_LABELS.communications_content,
    keywords: [
      "communications",
      "content",
      "copywriting",
      "social media",
      "campaign",
      "marketing",
      "editorial",
      "public engagement",
      "storytelling",
      "presentation",
    ],
    guidance: [
      "Emphasize audience understanding, message clarity, content production, campaign support, and translating complex ideas for specific readers.",
      "Keep voice natural and specific without promotional padding.",
    ],
    metricHints: [
      "audiences, channels, or campaigns supported",
      "content pieces, decks, briefs, or assets produced",
      "engagement or communication goals supported",
      "message testing or stakeholder review handled",
    ],
  },
  administration_coordination: {
    label: APPLICATION_ROLE_FAMILY_LABELS.administration_coordination,
    keywords: [
      "administrator",
      "administrative",
      "coordinator",
      "coordination",
      "operations assistant",
      "scheduler",
      "records",
      "documentation",
      "office",
      "support",
      "intake",
    ],
    guidance: [
      "Emphasize organization, follow-through, records, scheduling, documentation, intake, and reliable support for teams or clients.",
      "Use concise evidence of volume, accuracy, responsiveness, and coordination.",
    ],
    metricHints: [
      "records, requests, schedules, or documents handled",
      "teams, clients, or stakeholders supported",
      "processes organized or documentation improved",
      "deadlines, accuracy, or service continuity maintained",
    ],
  },
  custom: {
    label: APPLICATION_ROLE_FAMILY_LABELS.custom,
    keywords: [],
    guidance: [
      "Follow the user's custom role framing instructions when provided.",
      "Fall back to general application-writing guidance for anything not specified.",
    ],
    metricHints: [
      "role-specific workload scale",
      "outputs produced",
      "audience or team served",
      "decision or workflow value",
    ],
  },
};

const DETECTION_FAMILIES = Object.keys(ROLE_DEFINITIONS).filter(
  (value) => value !== "general" && value !== "custom",
) as ApplicationRoleFamily[];

function normalizeText(input: RoleDetectionInput): string {
  return [input.title, input.employer, input.jobDescription]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function keywordScore(text: string, keyword: string): number {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text) ? 1 : 0;
}

export function detectApplicationRoleFamily(
  input: RoleDetectionInput,
): ApplicationRoleFamily {
  const text = normalizeText(input);
  if (!text.trim()) return "general";

  const scores = DETECTION_FAMILIES.map((family) => ({
    family,
    score: ROLE_DEFINITIONS[family].keywords.reduce(
      (total, keyword) => total + keywordScore(text, keyword),
      0,
    ),
  })).sort((left, right) => right.score - left.score);

  const best = scores[0];
  const second = scores[1];
  if (!best || best.score < 2) return "general";
  if (second && best.score === second.score && best.score < 4) return "general";
  return best.family;
}

export function resolveApplicationWritingStrategy(args: {
  settings: ApplicationWritingSettings;
  roleInput: RoleDetectionInput;
}): ApplicationWritingStrategy {
  const mode = args.settings.roleFramingMode;
  const roleFamily =
    mode === "general"
      ? "general"
      : mode === "manual"
        ? args.settings.manualRoleFamily
        : detectApplicationRoleFamily(args.roleInput);

  return {
    roleFamily,
    roleLabel: ROLE_DEFINITIONS[roleFamily].label,
    roleSource:
      mode === "manual" ? "manual" : mode === "general" ? "general" : "auto",
    humanizerEnabled: args.settings.humanizerEnabled,
    impactFramingEnabled: args.settings.impactFramingEnabled,
    metricHints: ROLE_DEFINITIONS[roleFamily].metricHints,
    customRoleFramingInstructions:
      roleFamily === "custom"
        ? args.settings.customRoleFramingInstructions.trim()
        : "",
  };
}

export function buildApplicationWritingInstructions(
  strategy: ApplicationWritingStrategy,
): string {
  const role = ROLE_DEFINITIONS[strategy.roleFamily];
  const sections = [
    `Role framing: ${role.label} (${strategy.roleSource}).`,
    ...role.guidance.map((line) => `- ${line}`),
  ];

  if (strategy.customRoleFramingInstructions) {
    sections.push(
      `Custom role framing instructions: ${strategy.customRoleFramingInstructions}`,
    );
  }

  if (strategy.impactFramingEnabled) {
    sections.push(
      "Impact and quantification rules:",
      "- Use this structure where natural: action + scale/evidence + output + audience/use + decision value.",
      "- Look for truthful numbers in data volume, sources, regions, jurisdictions, stakeholders, deliverables, workflows improved, and decisions supported.",
      "- Do not invent percentages, savings, adoption, rankings, policy influence, or user counts.",
      "- If exact numbers are missing, use conservative wording or identify the missing metric instead of fabricating it.",
    );
  }

  if (strategy.humanizerEnabled) {
    sections.push(
      "Humanizer revision rules:",
      "- Remove AI tells: inflated significance, vague attributions, promotional language, superficial -ing phrases, formulaic not-X-but-Y structures, rule-of-three padding, passive or subjectless fragments, filler phrases, em dash overuse, and chatbot artifacts.",
      "- Preserve meaning, tone, and evidence. Make the writing sound specific and human without becoming casual.",
      "- Keep job-application writing professional and confident. Do not add jokes, tangents, swagger, or fake personal warmth.",
      "- Avoid phrases such as I am excited to leverage, dynamic landscape, pivotal role, strong passion, unique blend, serves as, underscores, showcases, and in order to.",
      "- Before finalizing, silently check what still sounds AI-generated and revise once.",
    );
  }

  return sections.join("\n");
}
