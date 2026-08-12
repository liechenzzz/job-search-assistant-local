import {
  type ApplicationWritingSettings,
  buildApplicationWritingInstructions,
  detectApplicationRoleFamily,
  resolveApplicationWritingStrategy,
} from "@shared/application-writing.js";
import { describe, expect, it } from "vitest";

const baseSettings: ApplicationWritingSettings = {
  humanizerEnabled: true,
  impactFramingEnabled: true,
  roleFramingMode: "auto",
  manualRoleFamily: "public_sector_policy_economic_development",
  customRoleFramingInstructions: "",
};

describe("application writing strategy", () => {
  it("detects representative role families from job context", () => {
    expect(
      detectApplicationRoleFamily({
        title: "Economic Development Policy Analyst",
        employer: "City of Toronto",
        jobDescription:
          "Prepare municipal briefing notes, labour market analysis, regional workforce KPIs, and jurisdictional scans.",
      }),
    ).toBe("public_sector_policy_economic_development");

    expect(
      detectApplicationRoleFamily({
        title: "Market Research Analyst",
        jobDescription:
          "Manage consumer surveys, questionnaire quality, audience segmentation, insights reporting, and client presentations.",
      }),
    ).toBe("market_insights_research");

    expect(
      detectApplicationRoleFamily({
        title: "AI Workflow Strategist",
        jobDescription:
          "Prototype generative AI automation, RAG knowledge base workflows, chatbot tools, and validation checkpoints.",
      }),
    ).toBe("ai_digital_strategy");
  });

  it("falls back to general when detection confidence is low", () => {
    expect(
      detectApplicationRoleFamily({
        title: "Associate",
        employer: "Example Company",
        jobDescription: "Support team priorities and complete assigned work.",
      }),
    ).toBe("general");
  });

  it("uses manual and custom role framing when selected", () => {
    const strategy = resolveApplicationWritingStrategy({
      settings: {
        ...baseSettings,
        roleFramingMode: "manual",
        manualRoleFamily: "custom",
        customRoleFramingInstructions:
          "Prioritize investor relations writing and board-ready analysis.",
      },
      roleInput: {
        title: "Investor Relations Associate",
      },
    });

    expect(strategy.roleFamily).toBe("custom");
    expect(strategy.roleSource).toBe("manual");
    expect(strategy.customRoleFramingInstructions).toContain(
      "investor relations",
    );

    const instructions = buildApplicationWritingInstructions(strategy);
    expect(instructions).toContain("Role framing: Custom (manual).");
    expect(instructions).toContain(
      "Custom role framing instructions: Prioritize investor relations writing",
    );
  });

  it("includes humanizer and impact instructions only when enabled", () => {
    const enabled = buildApplicationWritingInstructions(
      resolveApplicationWritingStrategy({
        settings: baseSettings,
        roleInput: {
          title: "Policy Analyst",
          jobDescription: "policy municipal workforce briefing stakeholder",
        },
      }),
    );

    expect(enabled).toContain("Impact and quantification rules:");
    expect(enabled).toContain("Humanizer revision rules:");

    const disabled = buildApplicationWritingInstructions(
      resolveApplicationWritingStrategy({
        settings: {
          ...baseSettings,
          humanizerEnabled: false,
          impactFramingEnabled: false,
        },
        roleInput: {
          title: "Policy Analyst",
          jobDescription: "policy municipal workforce briefing stakeholder",
        },
      }),
    );

    expect(disabled).not.toContain("Impact and quantification rules:");
    expect(disabled).not.toContain("Humanizer rules adapted");
  });
});
