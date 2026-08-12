import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = resolve(here, "..");

function readClientFile(path: string): string {
  return readFileSync(resolve(clientSrc, path), "utf8");
}

describe("DesignResumePage template preview wiring", () => {
  it("keeps the Design Resume page detached from PDF renderer template controls", () => {
    const pageSources = [readClientFile("pages/DesignResumePage.tsx")];

    for (const source of pageSources) {
      expect(source).not.toContain("useSettings");
      expect(source).not.toContain("pdfRenderer");
      expect(source).not.toContain("handlePdfRendererChange");
      expect(source).not.toContain("Jake's template");
      expect(source).not.toContain("React Resume Renderer");
      expect(source).not.toContain("Failed to update the resume template");
    }
  });

  it("keeps the live preview panel on the HTML preview component", () => {
    const panelSources = [
      readClientFile("components/design-resume/DesignResumePreviewPanel.tsx"),
    ];

    for (const source of panelSources) {
      expect(source).toContain("DesignResumeHtmlPreview");
      expect(source).not.toContain("DesignResumePdfPreview");
      expect(source).toContain(
        "HTML preview matching the generated Word and HTML resume output.",
      );
    }
  });
});
