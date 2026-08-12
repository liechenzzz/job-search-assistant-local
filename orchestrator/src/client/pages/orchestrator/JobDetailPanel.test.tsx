import * as api from "@client/api";
import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import { createJob } from "@shared/testing/factories.js";
import type { Job } from "@shared/types.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobDetailPanel } from "./JobDetailPanel";

const render = (ui: Parameters<typeof renderWithQueryClient>[0]) =>
  renderWithQueryClient(ui);

const mockSettings = {
  settings: null,
  error: null,
  isLoading: false,
  showSponsorInfo: true,
  renderMarkdownInJobDescriptions: true,
  refreshSettings: vi.fn(),
};

vi.mock("@/components/ui/dropdown-menu", () => {
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuItem: ({
      children,
      onSelect,
      ...props
    }: {
      children: React.ReactNode;
      onSelect?: () => void;
    }) => (
      <button
        type="button"
        role="menuitem"
        onClick={() => onSelect?.()}
        {...props}
      >
        {children}
      </button>
    ),
    DropdownMenuSeparator: () => <hr />,
  };
});

vi.mock("@client/components", () => ({
  JobHeader: () => <div data-testid="job-header" />,
  FitAssessment: () => <div data-testid="fit-assessment" />,
  ResumeAlignmentPill: () => <span data-testid="resume-alignment-pill" />,
  TailoredSummary: () => <div data-testid="tailored-summary" />,
}));

vi.mock("@client/hooks/useSettings", () => ({
  useSettings: () => mockSettings,
}));

vi.mock("@client/components/tailoring/TailoringWorkspace", () => ({
  TailoringWorkspace: ({
    onDirtyChange,
  }: {
    onDirtyChange?: (isDirty: boolean) => void;
  }) => (
    <div data-testid="tailoring-workspace">
      <button type="button" onClick={() => onDirtyChange?.(true)}>
        Mark tailoring dirty
      </button>
      <button type="button" onClick={() => onDirtyChange?.(false)}>
        Mark tailoring clean
      </button>
    </div>
  ),
}));

vi.mock("@client/components/JobDetailsEditDrawer", () => ({
  JobDetailsEditDrawer: ({
    open,
    onOpenChange,
    onJobUpdated,
    job,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onJobUpdated: () => Promise<void>;
    job: Job | null;
  }) =>
    open ? (
      <div data-testid="job-details-edit-drawer">
        <div>{job?.id}</div>
        <button
          type="button"
          onClick={() => {
            void onJobUpdated();
            onOpenChange(false);
          }}
        >
          Save details
        </button>
      </div>
    ) : null,
}));

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return {
    ...actual,
    copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
    formatJobForWebhook: vi.fn(() => "payload"),
  };
});

vi.mock("@client/api", () => ({
  updateJob: vi.fn(),
  processJob: vi.fn(),
  generateJobPdf: vi.fn(),
  markAsApplied: vi.fn(),
  skipJob: vi.fn(),
  getProfile: vi.fn().mockResolvedValue({}),
  getResumeProjectsCatalog: vi.fn().mockResolvedValue([]),
  getJobDocumentDiagnostics: vi.fn().mockResolvedValue(null),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

const renderJobDetailPanel = async (
  props: React.ComponentProps<typeof JobDetailPanel>,
) => {
  const rendered = render(<JobDetailPanel {...props} />);
  await act(async () => {
    await Promise.resolve();
  });
  return rendered;
};

describe("JobDetailPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.renderMarkdownInJobDescriptions = true;
    vi.mocked(api.getJobDocumentDiagnostics).mockResolvedValue({
      jobId: "job-1",
      policy: {
        roleFamily: "data_analytics_operations",
        roleLabel: "Data analytics / operations",
        resumeTargetPages: 2,
        resumePagePolicyMode: "manual",
        resumePagePolicyReason: "manual",
        resumePagePolicyLabel: "Manual - 2 pages",
        allowsManualResumeTargetPages: true,
        coverLetter: {
          maxWords: 400,
          targetBodyWords: 330,
          salutation: "To Whom It May Concern:",
          requirePersonalHeader: true,
          requireReLine: true,
        },
        reason:
          "Non-government, non-consulting applications use the user's selected one-page or two-page resume target.",
      },
      pdf: {
        exists: false,
        pageCount: null,
        targetPages: 2,
        exceedsTarget: false,
      },
      skills: {
        tailoredSkillGroups: 0,
        designResumeSkillsHidden: null,
        designResumeSkillItems: null,
        canRenderTailoredSkills: true,
      },
      alignment: null,
      issues: [],
      recommendations: [],
    });
  });

  it("renders discovered jobs in the unified inspector", async () => {
    const job = createJob({ id: "job-99", status: "discovered" });

    await renderJobDetailPanel({
      activeTab: "discovered",
      activeJobs: [job],
      selectedJob: job,
      onSelectJobId: vi.fn(),
      onJobUpdated: vi.fn().mockResolvedValue(undefined),
    });

    expect(screen.getByText("Start Tailoring")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The source material for deciding, tailoring, and applying.",
      ),
    ).toBeInTheDocument();
  });

  it("shows an empty state when no job is selected", async () => {
    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: null,
      onSelectJobId: vi.fn(),
      onJobUpdated: vi.fn().mockResolvedValue(undefined),
    });

    expect(screen.getByText("No job selected")).toBeInTheDocument();
  });

  it("renders a stripped description preview for html content", async () => {
    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({
        status: "applied",
        jobDescription: "<p>Hello <strong>world</strong></p>",
      }),
      onSelectJobId: vi.fn(),
      onJobUpdated: vi.fn().mockResolvedValue(undefined),
    });

    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders markdown in the brief job description when enabled", async () => {
    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({
        status: "applied",
        jobDescription: "# Responsibilities\n\n- Build APIs",
      }),
      onSelectJobId: vi.fn(),
      onJobUpdated: vi.fn().mockResolvedValue(undefined),
    });

    expect(
      screen.getByRole("heading", { name: "Responsibilities" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("# Responsibilities")).not.toBeInTheDocument();
  });

  it("renders raw markdown in the brief job description when disabled", async () => {
    mockSettings.renderMarkdownInJobDescriptions = false;

    const rendered = await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({
        status: "applied",
        jobDescription: "# Responsibilities\n\n- Build APIs",
      }),
      onSelectJobId: vi.fn(),
      onJobUpdated: vi.fn().mockResolvedValue(undefined),
    });

    const rawDescription = rendered.container.querySelector(
      "div.whitespace-pre-wrap",
    );
    expect(rawDescription?.textContent).toBe(
      "# Responsibilities\n\n- Build APIs",
    );
    expect(
      screen.queryByRole("heading", { name: "Responsibilities" }),
    ).not.toBeInTheDocument();
  });

  it("saves an edited description", async () => {
    const onJobUpdated = vi.fn().mockResolvedValue(undefined);
    vi.mocked(api.updateJob).mockResolvedValue(undefined as any);

    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({ status: "applied", jobDescription: "Original" }),
      onSelectJobId: vi.fn(),
      onJobUpdated,
    });

    fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));

    fireEvent.change(screen.getByPlaceholderText("Enter job description..."), {
      target: { value: "Updated description" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(api.updateJob).toHaveBeenCalledWith("job-1", {
        jobDescription: "Updated description",
      }),
    );
    expect(onJobUpdated).toHaveBeenCalled();
  });

  it("opens edit details drawer from menu and saves", async () => {
    const onJobUpdated = vi.fn().mockResolvedValue(undefined);

    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({ jobDescription: "Original" }),
      onSelectJobId: vi.fn(),
      onJobUpdated,
    });

    fireEvent.click(screen.getByRole("menuitem", { name: /edit details/i }));
    expect(
      await screen.findByTestId("job-details-edit-drawer"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save details/i }));

    await waitFor(() => expect(onJobUpdated).toHaveBeenCalled());
    expect(
      screen.queryByTestId("job-details-edit-drawer"),
    ).not.toBeInTheDocument();
  });

  it("shows manual resume generation target buttons and saves the selected target", async () => {
    const onJobUpdated = vi.fn().mockResolvedValue(undefined);
    vi.mocked(api.updateJob).mockResolvedValue(undefined as any);
    vi.mocked(api.getJobDocumentDiagnostics).mockResolvedValue({
      jobId: "job-1",
      policy: {
        roleFamily: "data_analytics_operations",
        roleLabel: "Data analytics / operations",
        resumeTargetPages: 2,
        resumePagePolicyMode: "manual",
        resumePagePolicyReason: "manual",
        resumePagePolicyLabel: "Manual - 2 pages",
        allowsManualResumeTargetPages: true,
        coverLetter: {
          maxWords: 400,
          targetBodyWords: 330,
          salutation: "To Whom It May Concern:",
          requirePersonalHeader: true,
          requireReLine: true,
        },
        reason:
          "Non-government, non-consulting applications use the user's selected one-page or two-page resume target.",
      },
      pdf: {
        exists: false,
        pageCount: null,
        targetPages: 2,
        exceedsTarget: false,
      },
      skills: {
        tailoredSkillGroups: 0,
        designResumeSkillsHidden: null,
        designResumeSkillItems: null,
        canRenderTailoredSkills: true,
      },
      alignment: null,
      issues: [],
      recommendations: [],
    } as any);

    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({ status: "ready" }),
      onSelectJobId: vi.fn(),
      onJobUpdated,
    });

    const onePageButton = (
      await screen.findAllByRole("button", {
        name: /generate 1 page/i,
      })
    )[0];
    expect(
      screen.getAllByRole("button", { name: /generate 2 pages/i })[0],
    ).toBeInTheDocument();

    fireEvent.click(onePageButton);

    await waitFor(() =>
      expect(api.updateJob).toHaveBeenCalledWith("job-1", {
        resumeTargetPagesOverride: 1,
      }),
    );
    expect(onJobUpdated).toHaveBeenCalled();
  });

  it("shows evidence gate trace from document diagnostics", async () => {
    vi.mocked(api.getJobDocumentDiagnostics).mockResolvedValue({
      jobId: "job-1",
      policy: {
        roleFamily: "data_analytics_operations",
        roleLabel: "Data analytics / operations",
        resumeTargetPages: 2,
        resumePagePolicyMode: "manual",
        resumePagePolicyReason: "manual",
        resumePagePolicyLabel: "Manual - 2 pages",
        allowsManualResumeTargetPages: true,
        coverLetter: {
          maxWords: 400,
          targetBodyWords: 330,
          salutation: "To Whom It May Concern:",
          requirePersonalHeader: true,
          requireReLine: true,
        },
        reason: "manual",
      },
      pdf: {
        exists: false,
        pageCount: null,
        targetPages: 2,
        exceedsTarget: false,
      },
      skills: {
        tailoredSkillGroups: 0,
        designResumeSkillsHidden: null,
        designResumeSkillItems: null,
        canRenderTailoredSkills: true,
      },
      alignment: {
        engineVersion: "semantic-v2",
        score: 85,
        status: "warning",
        missingRequired: [],
        partialRequired: [],
        matchedSections: {},
        referenceUsed: ["resume.docx"],
        generationTrace: {
          selectedEvidence: [
            {
              requirement: "Build Power BI dashboards",
              requirementId: "req-1",
              status: "selected",
              fit: "direct",
              confidence: "high",
              candidateChunkCount: 5,
              chunks: [
                {
                  chunkId: "chunk-1",
                  sourceFile: "resume.docx",
                  relativePath: "refs/resume.docx",
                  section: "Experience",
                  roleFamily: "data_analytics_operations",
                  rawText: "Built Power BI dashboards.",
                  keywords: ["Power BI"],
                },
              ],
              allowedClaims: ["Power BI dashboards"],
              blockedClaims: [],
            },
            {
              requirement: "Grant writing",
              requirementId: "req-2",
              status: "no_evidence",
              fit: "unsupported",
              confidence: "low",
              candidateChunkCount: 0,
              chunks: [],
              blockedClaims: ["Do not claim grant writing."],
              reason: "No supporting history.",
            },
          ],
          contentPlan: {
            targetPages: 2,
            requirementTiers: [],
            experienceAllocations: [
              {
                experienceId: "exp-1",
                label: "Analyst at Analytics Team",
                kind: "supporting",
                fitLevel: "relevant",
                digestId: "exp-1",
                experienceFitScore: 88,
                bulletBudget: 5,
                minBulletBudget: 5,
                maxBulletBudget: 5,
                requiredBulletThemes: ["Power BI dashboards", "KPI reporting"],
                coveredRequirementIds: ["req-1"],
                evidenceChunkIds: ["chunk-1"],
                reason: "Built dashboard reporting.",
              },
            ],
            sectionBudgets: {
              summaryWords: { min: 70, max: 110 },
              skillGroups: { min: 4, max: 6 },
              experienceBullets: { min: 5, max: 5 },
            },
            bulletBudgets: { "exp-1": 5 },
            softenedRequirements: [],
            omittedOrDeemphasizedItems: [],
            blockedClaims: [],
          },
          experienceDigests: [
            {
              experienceId: "exp-1",
              label: "Analyst at Analytics Team",
              fitLevel: "relevant",
              capabilitySummary: "Built dashboard reporting.",
              coreClaims: ["Power BI dashboards"],
              transferableClaims: [],
              matchedRequirementIds: ["req-1"],
              recommendedBulletThemes: ["Power BI dashboards", "KPI reporting"],
              sourceChunkIds: ["chunk-1"],
              blockedClaims: [],
              confidence: "high",
            },
          ],
          experience: [],
          uncoveredRequirements: ["Grant writing"],
        },
      },
      issues: [],
      recommendations: [],
    } as any);

    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({ status: "ready" }),
      onSelectJobId: vi.fn(),
      onJobUpdated: vi.fn(),
    });

    expect(await screen.findByText("Evidence gate")).toBeInTheDocument();
    expect(screen.getByText(/1 direct/i)).toBeInTheDocument();
    expect(screen.getByText(/1 weak\/no evidence/i)).toBeInTheDocument();
    expect(screen.getByText("Build Power BI dashboards")).toBeInTheDocument();
    expect(screen.getByText("Grant writing")).toBeInTheDocument();
    expect(
      screen.getByText(/sources: resume.docx > Experience/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Content allocation")).toBeInTheDocument();
    expect(screen.getAllByText(/5 bullets/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Experience digests")).toBeInTheDocument();
    expect(screen.getByText(/confidence high/i)).toBeInTheDocument();
  });

  it("marks a job as applied from the action button", async () => {
    const onJobUpdated = vi.fn().mockResolvedValue(undefined);
    vi.mocked(api.markAsApplied).mockResolvedValue(undefined as any);

    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({ status: "ready" }),
      onSelectJobId: vi.fn(),
      onJobUpdated,
    });

    fireEvent.click(screen.getByRole("button", { name: /applied/i }));

    await waitFor(() =>
      expect(api.markAsApplied).toHaveBeenCalledWith("job-1"),
    );
    expect(onJobUpdated).toHaveBeenCalled();
  });

  it("moves an applied job to in progress from the action button", async () => {
    const onJobUpdated = vi.fn().mockResolvedValue(undefined);
    vi.mocked(api.updateJob).mockResolvedValue(undefined as any);

    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({ status: "applied" }),
      onSelectJobId: vi.fn(),
      onJobUpdated,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /move to in progress/i }),
    );

    await waitFor(() =>
      expect(api.updateJob).toHaveBeenCalledWith("job-1", {
        status: "in_progress",
      }),
    );
    expect(onJobUpdated).toHaveBeenCalled();
  });

  it("skips a job from the menu", async () => {
    const onJobUpdated = vi.fn().mockResolvedValue(undefined);
    vi.mocked(api.skipJob).mockResolvedValue(undefined as any);

    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({ status: "ready" }),
      onSelectJobId: vi.fn(),
      onJobUpdated,
    });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: /more actions/i }),
    );
    const skipItem = await screen.findByRole("menuitem", { name: /skip job/i });
    fireEvent.click(skipItem);

    await waitFor(() => expect(api.skipJob).toHaveBeenCalledWith("job-1"));
    expect(onJobUpdated).toHaveBeenCalled();
  });

  it("forwards tailoring dirty state to refresh pause callback", async () => {
    const onPauseRefreshChange = vi.fn();

    await renderJobDetailPanel({
      activeTab: "all",
      activeJobs: [],
      selectedJob: createJob({ status: "ready" }),
      onSelectJobId: vi.fn(),
      onJobUpdated: vi.fn().mockResolvedValue(undefined),
      onPauseRefreshChange,
    });

    fireEvent.mouseDown(screen.getByRole("tab", { name: /tailoring/i }));
    fireEvent.click(await screen.findByText("Mark tailoring dirty"));
    fireEvent.click(screen.getByText("Mark tailoring clean"));

    expect(onPauseRefreshChange).toHaveBeenCalledWith(true);
    expect(onPauseRefreshChange).toHaveBeenCalledWith(false);
  });
});
