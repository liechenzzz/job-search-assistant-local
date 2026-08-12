import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  buildResumeHtml: vi.fn(),
  getCurrentDesignResume: vi.fn(),
  normalizeDesignResumeVariant: vi.fn((value: unknown) =>
    value === "one_page" || value === "two_page" ? value : "two_page",
  ),
}));

vi.mock("@server/services/design-resume", () => ({
  deleteDesignResumePicture: vi.fn(),
  exportDesignResume: vi.fn(),
  getCurrentDesignResume: routeMocks.getCurrentDesignResume,
  getDesignResumeStatus: vi.fn(),
  importDesignResumeFromReactiveResume: vi.fn(),
  normalizeDesignResumeVariant: routeMocks.normalizeDesignResumeVariant,
  readDesignResumeAssetContent: vi.fn(),
  updateCurrentDesignResume: vi.fn(),
  uploadDesignResumePicture: vi.fn(),
}));

vi.mock("@server/services/design-resume/compact", () => ({
  generateCompactDesignResumeMaster: vi.fn(),
}));

vi.mock("@server/services/design-resume/import-file", () => ({
  importDesignResumeFromFile: vi.fn(),
}));

vi.mock("@server/services/pdf", () => ({
  buildResumeHtml: routeMocks.buildResumeHtml,
  generateDesignResumePdf: vi.fn(),
}));

vi.mock("@server/services/pdf-storage", () => ({
  getTenantDesignResumePdfPath: vi.fn(() => "design_resume_current.pdf"),
}));

vi.mock("@server/services/profile", () => ({
  clearProfileCache: vi.fn(),
}));

import { designResumePatchSchema, designResumeRouter } from "./design-resume";

describe("designResumePatchSchema", () => {
  it("rejects patch paths that are not valid JSON pointers", () => {
    const result = designResumePatchSchema.safeParse({
      baseRevision: 1,
      operations: [
        {
          op: "replace",
          path: "basics/name",
          value: "Taylor",
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "Patch paths must be valid JSON Pointers.",
    );
  });

  it("requires a value for test operations", () => {
    const result = designResumePatchSchema.safeParse({
      baseRevision: 1,
      operations: [
        {
          op: "test",
          path: "/basics/name",
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe.sequential("Design Resume API routes", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    routeMocks.buildResumeHtml.mockImplementation(
      (
        resumeJson: Record<string, unknown>,
        options?: { targetPages?: 1 | 2 },
      ) => {
        const basics = resumeJson.basics as Record<string, unknown> | undefined;
        const targetPages = options?.targetPages ?? 2;
        return `<!doctype html><article class="resume target-${targetPages === 1 ? "one" : "two"}" data-policy="targetPages=${targetPages}">${String(
          basics?.name ?? "",
        )}</article>`;
      },
    );

    const app = express();
    app.use("/api/design-resume", designResumeRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) =>
      server.once("listening", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function seedDesignResume(variant: "one_page" | "two_page", name: string) {
    routeMocks.getCurrentDesignResume.mockImplementation(
      async (requestedVariant: "one_page" | "two_page") =>
        requestedVariant === variant
          ? {
              id: `${variant}-document`,
              resumeJson: { basics: { name } },
            }
          : null,
    );
  }

  it("returns one-page HTML for the one-page Design Resume variant", async () => {
    seedDesignResume("one_page", "One Page Candidate");

    const response = await fetch(
      `${baseUrl}/api/design-resume/resume-html?variant=one_page`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("One Page Candidate");
    expect(html).toContain('class="resume target-one"');
    expect(html).toContain('data-policy="targetPages=1"');
    expect(routeMocks.buildResumeHtml).toHaveBeenCalledWith(
      { basics: { name: "One Page Candidate" } },
      { targetPages: 1 },
    );
  });

  it("returns two-page HTML for the two-page Design Resume variant", async () => {
    seedDesignResume("two_page", "Two Page Candidate");

    const response = await fetch(
      `${baseUrl}/api/design-resume/resume-html?variant=two_page`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Two Page Candidate");
    expect(html).toContain('class="resume target-two"');
    expect(html).toContain('data-policy="targetPages=2"');
    expect(routeMocks.buildResumeHtml).toHaveBeenCalledWith(
      { basics: { name: "Two Page Candidate" } },
      { targetPages: 2 },
    );
  });

  it("returns not found when the requested Design Resume variant is missing", async () => {
    const response = await fetch(
      `${baseUrl}/api/design-resume/resume-html?variant=one_page`,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("Design Resume has not been imported yet.");
  });
});
