import type {
  ExtractorManifest,
  ExtractorProgressEvent,
} from "@shared/types/extractors";
import { runOntarioPublicSector } from "./run";

function toPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

function toProgress(event: {
  type: "source_start" | "source_complete";
  sourceIndex: number;
  sourceTotal: number;
  sourceName: string;
  jobsFoundSource?: number;
}): ExtractorProgressEvent {
  if (event.type === "source_start") {
    return {
      phase: "list",
      termsProcessed: Math.max(event.sourceIndex - 1, 0),
      termsTotal: event.sourceTotal,
      currentUrl: event.sourceName,
      detail: `Ontario public sector: source ${event.sourceIndex}/${event.sourceTotal} (${event.sourceName})`,
    };
  }

  return {
    phase: "list",
    termsProcessed: event.sourceIndex,
    termsTotal: event.sourceTotal,
    currentUrl: event.sourceName,
    jobPagesProcessed: event.jobsFoundSource ?? 0,
    jobPagesEnqueued: event.jobsFoundSource ?? 0,
    detail: `Ontario public sector: completed ${event.sourceIndex}/${event.sourceTotal} (${event.sourceName}) with ${event.jobsFoundSource ?? 0} jobs`,
  };
}

export const manifest: ExtractorManifest = {
  id: "ontario-public-sector",
  displayName: "Ontario Public Sector",
  providesSources: ["ontario-public-sector", "policyjobs-ottawa"],
  capabilities: { locationEvidence: true },
  async run(context) {
    if (context.shouldCancel?.()) {
      return { success: true, jobs: [] };
    }

    const result = await runOntarioPublicSector({
      searchTerms: context.searchTerms,
      maxJobs: toPositiveInt(context.settings.ontarioPublicSectorMaxJobs, 150),
      selectedSources: context.selectedSources,
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (context.shouldCancel?.()) return;
        context.onProgress?.(toProgress(event));
      },
    });

    if (!result.success) {
      return {
        success: false,
        jobs: [],
        error: result.error,
      };
    }

    return {
      success: true,
      jobs: result.jobs,
    };
  },
};

export default manifest;
