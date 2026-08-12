import { createJob } from "@shared/testing/factories";
import { describe, expect, it, vi } from "vitest";

vi.mock("@server/repositories/jobs", () => ({
  getAvailabilityRecheckCandidates: vi.fn(),
  updateJob: vi.fn(),
}));

import {
  checkJobAvailability,
  classifyJobAvailabilityFromContent,
} from "./jobAvailability";

describe("jobAvailability", () => {
  const now = new Date("2026-04-10T12:00:00.000Z").getTime();

  it("classifies passed deadlines as expired without fetching", async () => {
    const fetchImpl = vi.fn();
    const result = await checkJobAvailability(
      createJob({
        status: "discovered",
        deadline: "2026-04-01",
      }),
      { fetchImpl: fetchImpl as unknown as typeof fetch, now },
    );

    expect(result.status).toBe("expired");
    expect(result.closeJob).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps blocked job-board checks as unknown rather than expired", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 403,
      text: async () => "Forbidden",
    }));

    const result = await checkJobAvailability(createJob(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now,
    });

    expect(result.status).toBe("unknown");
    expect(result.closeJob).toBe(false);
  });

  it("classifies explicit closed-page language as filled", () => {
    const result = classifyJobAvailabilityFromContent({
      job: createJob({ title: "Policy Analyst", deadline: "2026-04-30" }),
      content:
        "<html><body>Policy Analyst. This job is no longer accepting applications.</body></html>",
      now,
    });

    expect(result.status).toBe("filled");
    expect(result.closeJob).toBe(true);
  });
});
