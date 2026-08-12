import { describe, expect, it } from "vitest";
import { updateSettingsSchema } from "./settings-schema";

describe("updateSettingsSchema", () => {
  it("accepts supported PDF renderer values and rejects unsupported ones", () => {
    expect(
      updateSettingsSchema.parse({
        pdfRenderer: "latex",
      }),
    ).toEqual({
      pdfRenderer: "latex",
    });

    expect(
      updateSettingsSchema.parse({
        pdfRenderer: null,
      }),
    ).toEqual({
      pdfRenderer: null,
    });

    const result = updateSettingsSchema.safeParse({
      pdfRenderer: "custom",
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.flatten().fieldErrors.pdfRenderer).toBeDefined();
  });

  it("accepts supported language mode and manual language values", () => {
    expect(
      updateSettingsSchema.parse({
        chatStyleLanguageMode: "manual",
        chatStyleManualLanguage: "german",
      }),
    ).toEqual({
      chatStyleLanguageMode: "manual",
      chatStyleManualLanguage: "german",
    });

    expect(
      updateSettingsSchema.parse({
        chatStyleLanguageMode: null,
        chatStyleManualLanguage: null,
      }),
    ).toEqual({
      chatStyleLanguageMode: null,
      chatStyleManualLanguage: null,
    });
  });

  it("rejects unsupported language mode and manual language values", () => {
    const result = updateSettingsSchema.safeParse({
      chatStyleLanguageMode: "auto",
      chatStyleManualLanguage: "italian",
    });

    expect(result.success).toBe(false);

    if (result.success) {
      return;
    }

    expect(
      result.error.flatten().fieldErrors.chatStyleLanguageMode,
    ).toBeDefined();
    expect(
      result.error.flatten().fieldErrors.chatStyleManualLanguage,
    ).toBeDefined();
  });

  it("accepts a nullable rxresumeUrl and rejects invalid URLs", () => {
    expect(
      updateSettingsSchema.parse({
        rxresumeUrl: "https://resume.example.com",
      }),
    ).toEqual({
      rxresumeUrl: "https://resume.example.com",
    });

    expect(
      updateSettingsSchema.parse({
        rxresumeUrl: null,
      }),
    ).toEqual({
      rxresumeUrl: null,
    });

    const result = updateSettingsSchema.safeParse({
      rxresumeUrl: "not-a-url",
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.flatten().fieldErrors.rxresumeUrl).toBeDefined();
  });

  it("accepts prompt template overrides up to 12000 characters", () => {
    const prompt = "A".repeat(12000);

    expect(
      updateSettingsSchema.parse({
        ghostwriterSystemPromptTemplate: prompt,
        tailoringPromptTemplate: prompt,
        scoringPromptTemplate: prompt,
      }),
    ).toEqual({
      ghostwriterSystemPromptTemplate: prompt,
      tailoringPromptTemplate: prompt,
      scoringPromptTemplate: prompt,
    });
  });

  it("accepts the Ghostwriter Stop Slop toggle", () => {
    expect(
      updateSettingsSchema.parse({
        ghostwriterStopSlopEnabled: true,
      }),
    ).toEqual({
      ghostwriterStopSlopEnabled: true,
    });

    expect(
      updateSettingsSchema.parse({
        ghostwriterStopSlopEnabled: null,
      }),
    ).toEqual({
      ghostwriterStopSlopEnabled: null,
    });
  });

  it("accepts application writing strategy settings", () => {
    expect(
      updateSettingsSchema.parse({
        humanizerEnabled: false,
        impactFramingEnabled: true,
        roleFramingMode: "manual",
        manualRoleFamily: "ai_digital_strategy",
        customRoleFramingInstructions:
          "Prioritize domain-specific evidence and stakeholder outcomes.",
      }),
    ).toEqual({
      humanizerEnabled: false,
      impactFramingEnabled: true,
      roleFramingMode: "manual",
      manualRoleFamily: "ai_digital_strategy",
      customRoleFramingInstructions:
        "Prioritize domain-specific evidence and stakeholder outcomes.",
    });

    expect(
      updateSettingsSchema.parse({
        humanizerEnabled: null,
        impactFramingEnabled: null,
        roleFramingMode: null,
        manualRoleFamily: null,
        customRoleFramingInstructions: null,
      }),
    ).toEqual({
      humanizerEnabled: null,
      impactFramingEnabled: null,
      roleFramingMode: null,
      manualRoleFamily: null,
      customRoleFramingInstructions: null,
    });
  });

  it("rejects unsupported application role framing values", () => {
    const result = updateSettingsSchema.safeParse({
      roleFramingMode: "forced",
      manualRoleFamily: "policy_only",
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.flatten().fieldErrors.roleFramingMode).toBeDefined();
    expect(result.error.flatten().fieldErrors.manualRoleFamily).toBeDefined();
  });

  it("rejects prompt template overrides above 12000 characters", () => {
    const result = updateSettingsSchema.safeParse({
      ghostwriterSystemPromptTemplate: "A".repeat(12001),
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(
      result.error.flatten().fieldErrors.ghostwriterSystemPromptTemplate,
    ).toBeDefined();
  });
});
