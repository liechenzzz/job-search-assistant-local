import * as settingsRepo from "@server/repositories/settings";
import {
  type ApplicationWritingSettings,
  buildApplicationWritingInstructions,
  type RoleDetectionInput,
  resolveApplicationWritingStrategy,
} from "@shared/application-writing.js";
import { settingsRegistry } from "@shared/settings-registry";

export async function getApplicationWritingSettings(): Promise<ApplicationWritingSettings> {
  const [
    rawHumanizerEnabled,
    rawImpactFramingEnabled,
    rawRoleFramingMode,
    rawManualRoleFamily,
    rawCustomRoleFramingInstructions,
  ] = await Promise.all([
    settingsRepo.getSetting("humanizerEnabled"),
    settingsRepo.getSetting("impactFramingEnabled"),
    settingsRepo.getSetting("roleFramingMode"),
    settingsRepo.getSetting("manualRoleFamily"),
    settingsRepo.getSetting("customRoleFramingInstructions"),
  ]);

  return {
    humanizerEnabled:
      settingsRegistry.humanizerEnabled.parse(
        rawHumanizerEnabled ?? undefined,
      ) ?? settingsRegistry.humanizerEnabled.default(),
    impactFramingEnabled:
      settingsRegistry.impactFramingEnabled.parse(
        rawImpactFramingEnabled ?? undefined,
      ) ?? settingsRegistry.impactFramingEnabled.default(),
    roleFramingMode:
      settingsRegistry.roleFramingMode.parse(rawRoleFramingMode ?? undefined) ??
      settingsRegistry.roleFramingMode.default(),
    manualRoleFamily:
      settingsRegistry.manualRoleFamily.parse(
        rawManualRoleFamily ?? undefined,
      ) ?? settingsRegistry.manualRoleFamily.default(),
    customRoleFramingInstructions:
      settingsRegistry.customRoleFramingInstructions.parse(
        rawCustomRoleFramingInstructions ?? undefined,
      ) ?? settingsRegistry.customRoleFramingInstructions.default(),
  };
}

export async function buildApplicationWritingInstructionsForJob(
  roleInput: RoleDetectionInput,
): Promise<string> {
  const settings = await getApplicationWritingSettings();
  return buildApplicationWritingInstructions(
    resolveApplicationWritingStrategy({ settings, roleInput }),
  );
}
