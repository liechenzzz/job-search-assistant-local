import type { DesignResumeDocument } from "@shared/types";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesignResumeHtmlPreview } from "./DesignResumeHtmlPreview";

const apiMocks = vi.hoisted(() => ({
  getDesignResumeHtmlPreview: vi.fn(),
}));

vi.mock("@client/api", () => ({
  getDesignResumeHtmlPreview: apiMocks.getDesignResumeHtmlPreview,
}));

function makeDraft(revision = 7): DesignResumeDocument {
  return {
    id: "design-resume-two-page",
    title: "Design Resume",
    resumeJson: {} as DesignResumeDocument["resumeJson"],
    revision,
    sourceResumeId: null,
    sourceMode: "v5",
    importedAt: null,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    assets: [],
  };
}

describe("DesignResumeHtmlPreview", () => {
  beforeEach(() => {
    apiMocks.getDesignResumeHtmlPreview.mockReset();
    apiMocks.getDesignResumeHtmlPreview.mockResolvedValue(
      "<!doctype html><html><body><h1>Resume preview</h1></body></html>",
    );
  });

  it("loads the saved variant and revision through the authenticated HTML preview API", async () => {
    const { container } = render(
      <DesignResumeHtmlPreview
        draft={makeDraft(3)}
        isDirty={false}
        saveState="saved"
        variant="one_page"
      />,
    );

    await waitFor(() => {
      expect(apiMocks.getDesignResumeHtmlPreview).toHaveBeenCalledWith(
        "one_page",
        3,
      );
      const iframe = container.querySelector("iframe");
      expect(iframe?.getAttribute("srcdoc")).toContain("Resume preview");
      expect(iframe?.getAttribute("src")).toBeNull();
    });
  });

  it("waits for unsaved edits before refreshing the iframe", async () => {
    const { container, rerender } = render(
      <DesignResumeHtmlPreview
        draft={makeDraft(8)}
        isDirty
        saveState="idle"
        variant="two_page"
      />,
    );

    expect(
      screen.getByText("Saving changes before updating the preview"),
    ).toBeInTheDocument();
    expect(apiMocks.getDesignResumeHtmlPreview).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();

    rerender(
      <DesignResumeHtmlPreview
        draft={makeDraft(9)}
        isDirty={false}
        saveState="saved"
        variant="two_page"
      />,
    );

    await waitFor(() => {
      expect(apiMocks.getDesignResumeHtmlPreview).toHaveBeenCalledWith(
        "two_page",
        9,
      );
      const iframe = container.querySelector("iframe");
      expect(iframe?.getAttribute("srcdoc")).toContain("Resume preview");
    });
  });
});
