import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runOntarioPublicSector: vi.fn(),
}));

describe("ontario-public-sector manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers ontarioPublicSectorMaxJobs when provided", async () => {
    const { manifest } = await import("../src/manifest");
    const { runOntarioPublicSector } = await import("../src/run");
    const runOntarioPublicSectorMock = vi.mocked(runOntarioPublicSector);
    runOntarioPublicSectorMock.mockResolvedValue({
      success: true,
      jobs: [],
    });

    await manifest.run({
      source: "policyjobs-ottawa",
      selectedSources: ["policyjobs-ottawa"],
      settings: {
        ontarioPublicSectorMaxJobs: "80",
      },
      searchTerms: ["policy analyst"],
      selectedCountry: "canada",
    });

    expect(runOntarioPublicSectorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobs: 80,
        selectedSources: ["policyjobs-ottawa"],
      }),
    );
  });

  it("exposes both official Ontario and PolicyJobsOTT sources", async () => {
    const { manifest } = await import("../src/manifest");

    expect(manifest.providesSources).toEqual([
      "ontario-public-sector",
      "policyjobs-ottawa",
    ]);
  });
});
