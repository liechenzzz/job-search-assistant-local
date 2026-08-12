import { createJob } from "@shared/testing/factories";
import type { Job } from "@shared/types";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDateFilter } from "./constants";
import { useFilteredJobs } from "./useFilteredJobs";

const baseJob = createJob({
  id: "job-1",
  source: "linkedin",
  title: "Engineer",
  employer: "Acme",
  location: "London",
  jobDescription: "Desc",
  status: "ready",
});

const defaultDateFilter: JobDateFilter = {
  dimensions: [],
  startDate: null,
  endDate: null,
  preset: null,
};

describe("useFilteredJobs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps only ready jobs in the ready tab", () => {
    const jobs: Job[] = [
      { ...baseJob, id: "ready", status: "ready" },
      { ...baseJob, id: "processing", status: "processing" },
    ];

    const { result } = renderHook(() =>
      useFilteredJobs(
        jobs,
        "ready",
        defaultDateFilter,
        "all",
        "all",
        { mode: "at_least", min: null, max: null },
        { key: "score", direction: "desc" },
        "all",
      ),
    );

    expect(result.current.map((job) => job.id)).toEqual(["ready"]);
  });

  it("defaults discovered jobs to the action queue", () => {
    const jobs: Job[] = [
      {
        ...baseJob,
        id: "fresh-high",
        status: "discovered",
        relevanceStatus: "high_match",
        discoveredAt: "2026-04-08T14:00:00.000Z",
      },
      {
        ...baseJob,
        id: "old-medium",
        status: "discovered",
        relevanceStatus: "medium_match",
        discoveredAt: "2026-03-01T14:00:00.000Z",
      },
      {
        ...baseJob,
        id: "closing-soon",
        status: "discovered",
        relevanceStatus: "needs_review",
        discoveredAt: "2026-03-20T14:00:00.000Z",
        deadline: "2026-04-12",
      },
      {
        ...baseJob,
        id: "expired",
        status: "discovered",
        relevanceStatus: "high_match",
        discoveredAt: "2026-04-08T14:00:00.000Z",
        deadline: "2026-04-01",
      },
    ];

    const { result } = renderHook(() =>
      useFilteredJobs(
        jobs,
        "discovered",
        defaultDateFilter,
        "all",
        "all",
        { mode: "at_least", min: null, max: null },
        { key: "discoveredAt", direction: "desc" },
      ),
    );

    expect(result.current.map((job) => job.id)).toEqual([
      "fresh-high",
      "closing-soon",
    ]);
  });

  it("filters discovered jobs by non-overlapping age tiers", () => {
    const jobs: Job[] = [
      {
        ...baseJob,
        id: "fresh",
        status: "discovered",
        discoveredAt: "2026-04-06T14:00:00.000Z",
      },
      {
        ...baseJob,
        id: "recent",
        status: "discovered",
        discoveredAt: "2026-03-31T14:00:00.000Z",
      },
      {
        ...baseJob,
        id: "aging",
        status: "discovered",
        discoveredAt: "2026-03-21T14:00:00.000Z",
      },
    ];

    const { result } = renderHook(() =>
      useFilteredJobs(
        jobs,
        "discovered",
        defaultDateFilter,
        "all",
        "all",
        { mode: "at_least", min: null, max: null },
        { key: "discoveredAt", direction: "desc" },
        "recent_14",
      ),
    );

    expect(result.current.map((job) => job.id)).toEqual(["recent"]);
  });

  it("filters by discovered date on the discovered tab", () => {
    const jobs: Job[] = [
      {
        ...baseJob,
        id: "match",
        status: "discovered",
        discoveredAt: "2026-04-05T14:00:00.000Z",
      },
      {
        ...baseJob,
        id: "outside",
        status: "processing",
        discoveredAt: "2026-03-01T14:00:00.000Z",
      },
    ];

    const { result } = renderHook(() =>
      useFilteredJobs(
        jobs,
        "discovered",
        {
          dimensions: ["discovered"],
          startDate: "2026-04-01",
          endDate: "2026-04-06",
          preset: "custom",
        },
        "all",
        "all",
        { mode: "at_least", min: null, max: null },
        { key: "score", direction: "desc" },
        "all",
      ),
    );

    expect(result.current.map((job) => job.id)).toEqual(["match"]);
  });

  it("filters applied jobs by applied date", () => {
    const jobs: Job[] = [
      {
        ...baseJob,
        id: "applied",
        status: "applied",
        appliedAt: "2026-04-05T14:00:00.000Z",
      },
      {
        ...baseJob,
        id: "outside",
        status: "applied",
        appliedAt: "2026-03-20T14:00:00.000Z",
      },
    ];

    const { result } = renderHook(() =>
      useFilteredJobs(
        jobs,
        "applied",
        {
          dimensions: ["applied"],
          startDate: "2026-04-01",
          endDate: "2026-04-06",
          preset: "custom",
        },
        "all",
        "all",
        { mode: "at_least", min: null, max: null },
        { key: "score", direction: "desc" },
      ),
    );

    expect(result.current.map((job) => job.id)).toEqual(["applied"]);
  });

  it("matches multiple date dimensions with OR logic", () => {
    const jobs: Job[] = [
      {
        ...baseJob,
        id: "ready-match",
        status: "ready",
        readyAt: "2026-04-04T14:00:00.000Z",
      },
      {
        ...baseJob,
        id: "closed-match",
        status: "ready",
        closedAt: 1775347200,
      },
      {
        ...baseJob,
        id: "no-match",
        status: "ready",
        readyAt: "2026-03-01T14:00:00.000Z",
      },
    ];

    const { result } = renderHook(() =>
      useFilteredJobs(
        jobs,
        "all",
        {
          dimensions: ["ready", "closed"],
          startDate: "2026-04-03",
          endDate: "2026-04-06",
          preset: "custom",
        },
        "all",
        "all",
        { mode: "at_least", min: null, max: null },
        { key: "score", direction: "desc" },
      ),
    );

    expect(result.current.map((job) => job.id)).toEqual([
      "closed-match",
      "ready-match",
    ]);
  });

  it("composes date filtering with source, sponsor, and salary filters", () => {
    const jobs: Job[] = [
      {
        ...baseJob,
        id: "match",
        source: "linkedin",
        appliedAt: "2026-04-05T14:00:00.000Z",
        sponsorMatchScore: 99,
        salaryMinAmount: 80000,
      },
      {
        ...baseJob,
        id: "wrong-source",
        source: "indeed",
        appliedAt: "2026-04-05T14:00:00.000Z",
        sponsorMatchScore: 99,
        salaryMinAmount: 80000,
      },
      {
        ...baseJob,
        id: "wrong-sponsor",
        source: "linkedin",
        appliedAt: "2026-04-05T14:00:00.000Z",
        sponsorMatchScore: 45,
        salaryMinAmount: 80000,
      },
      {
        ...baseJob,
        id: "wrong-salary",
        source: "linkedin",
        appliedAt: "2026-04-05T14:00:00.000Z",
        sponsorMatchScore: 99,
        salaryMinAmount: 50000,
      },
    ];

    const { result } = renderHook(() =>
      useFilteredJobs(
        jobs,
        "all",
        {
          dimensions: ["applied"],
          startDate: "2026-04-01",
          endDate: "2026-04-06",
          preset: "custom",
        },
        "linkedin",
        "confirmed",
        { mode: "at_least", min: 70000, max: null },
        { key: "score", direction: "desc" },
      ),
    );

    expect(result.current.map((job) => job.id)).toEqual(["match"]);
  });

  it("sorts by date using the active date context", () => {
    const jobs: Job[] = [
      {
        ...baseJob,
        id: "older",
        appliedAt: "2026-04-03T14:00:00.000Z",
      },
      {
        ...baseJob,
        id: "newer",
        appliedAt: "2026-04-05T14:00:00.000Z",
      },
    ];

    const { result } = renderHook(() =>
      useFilteredJobs(
        jobs,
        "all",
        {
          dimensions: ["applied"],
          startDate: null,
          endDate: null,
          preset: null,
        },
        "all",
        "all",
        { mode: "at_least", min: null, max: null },
        { key: "date", direction: "desc" },
      ),
    );

    expect(result.current.map((job) => job.id)).toEqual(["newer", "older"]);
  });

  it("falls back through the date sort priority when the primary timestamp is missing", () => {
    const jobs: Job[] = [
      {
        ...baseJob,
        id: "fallback",
        appliedAt: "2026-04-05T14:00:00.000Z",
        readyAt: null,
      },
      {
        ...baseJob,
        id: "ready",
        readyAt: "2026-04-04T14:00:00.000Z",
        appliedAt: "2026-04-03T14:00:00.000Z",
      },
    ];

    const { result } = renderHook(() =>
      useFilteredJobs(
        jobs,
        "all",
        {
          dimensions: ["ready", "applied"],
          startDate: null,
          endDate: null,
          preset: null,
        },
        "all",
        "all",
        { mode: "at_least", min: null, max: null },
        { key: "date", direction: "desc" },
      ),
    );

    expect(result.current.map((job) => job.id)).toEqual(["fallback", "ready"]);
  });
});
