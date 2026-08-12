import * as api from "@client/api";
import {
  JobHeader,
  ResumeAlignmentPill,
  TailoredSummary,
} from "@client/components";
import { GhostwriterDrawer } from "@client/components/ghostwriter/GhostwriterDrawer";
import { JobDescriptionMarkdown } from "@client/components/JobDescriptionMarkdown";
import { JobDetailsEditDrawer } from "@client/components/JobDetailsEditDrawer";
import { KbdHint } from "@client/components/KbdHint";
import { OpenJobListingButton } from "@client/components/OpenJobListingButton";
import { TailoringWorkspace } from "@client/components/tailoring/TailoringWorkspace";
import {
  useMarkAsAppliedMutation,
  useSkipJobMutation,
} from "@client/hooks/queries/useJobMutations";
import { useProfile } from "@client/hooks/useProfile";
import { useRescoreJob } from "@client/hooks/useRescoreJob";
import { useSettings } from "@client/hooks/useSettings";
import { uploadJobPdfFromFile } from "@client/lib/job-pdf-upload";
import { getRenderableJobDescription } from "@client/lib/jobDescription";
import {
  downloadJobHtmlResume,
  downloadJobPdf,
  downloadJobWordDraft,
  openJobHtmlResume,
  openJobPdf,
  openJobWordDraft,
} from "@client/lib/private-pdf";
import { resolveDocumentPolicy } from "@shared/document-policy.js";
import type {
  Job,
  JobDocumentDiagnostics,
  JobListItem,
  ResumeProjectCatalogItem,
} from "@shared/types.js";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Edit2,
  ExternalLink,
  FileCheck2,
  FileText,
  FolderKanban,
  Loader2,
  MoreHorizontal,
  RefreshCcw,
  Save,
  Sparkles,
  Upload,
  XCircle,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { trackProductEvent } from "@/lib/analytics";
import {
  cn,
  copyTextToClipboard,
  formatJobForWebhook,
  safeFilenamePart,
} from "@/lib/utils";
import type { FilterTab } from "./constants";

interface JobDetailPanelProps {
  activeTab: FilterTab;
  activeJobs: JobListItem[];
  selectedJob: Job | null;
  onSelectJobId: (jobId: string | null) => void;
  onJobUpdated: () => Promise<void>;
  onPauseRefreshChange?: (paused: boolean) => void;
}

type InspectorTab = "brief" | "tailoring" | "apply";

const tabCopy: Record<
  InspectorTab,
  {
    label: string;
    description: string;
    dotClassName: string;
    selectedClassName: string;
  }
> = {
  brief: {
    label: "Brief",
    description: "Read the role, fit, and job description.",
    dotClassName: "bg-sky-500/70",
    selectedClassName: "!border-sky-400/65 !bg-sky-500/20 !text-sky-100",
  },
  tailoring: {
    label: "Tailoring",
    description: "Shape the resume material for this job.",
    dotClassName: "bg-amber-500/70",
    selectedClassName: "!border-amber-400/65 !bg-amber-500/20 !text-amber-100",
  },
  apply: {
    label: "Apply",
    description: "Use the generated kit, Ghostwriter, and final actions.",
    dotClassName: "bg-emerald-500/70",
    selectedClassName:
      "!border-emerald-400/65 !bg-emerald-500/20 !text-emerald-100",
  },
};

const statusTone: Record<
  Job["status"],
  {
    shell: string;
    eyebrow: string;
    icon: string;
    button?: string;
  }
> = {
  discovered: {
    shell: "border-border/45 bg-muted/10",
    eyebrow: "text-muted-foreground",
    icon: "bg-sky-500/70",
  },
  processing: {
    shell: "border-border/45 bg-muted/10",
    eyebrow: "text-muted-foreground",
    icon: "bg-amber-500/70",
  },
  ready: {
    shell: "border-border/45 bg-muted/10",
    eyebrow: "text-muted-foreground",
    icon: "bg-emerald-500/70",
    button: "bg-emerald-600 text-white hover:bg-emerald-500",
  },
  applied: {
    shell: "border-border/45 bg-muted/10",
    eyebrow: "text-muted-foreground",
    icon: "bg-teal-500/70",
    button: "bg-teal-600 text-white hover:bg-teal-500",
  },
  in_progress: {
    shell: "border-border/45 bg-muted/10",
    eyebrow: "text-muted-foreground",
    icon: "bg-cyan-500/70",
  },
  skipped: {
    shell: "border-border/45 bg-muted/10",
    eyebrow: "text-muted-foreground",
    icon: "bg-rose-500/70",
  },
  expired: {
    shell: "border-border/45 bg-muted/10",
    eyebrow: "text-muted-foreground",
    icon: "bg-slate-500/70",
  },
};

const getPrimaryAction = (job: Job): string => {
  if (job.status === "processing") return "Processing";
  if (job.status === "ready") return "Mark Applied";
  if (job.status === "discovered") return "Start Tailoring";
  if (job.status === "applied") return "Move to In Progress";
  if (job.status === "in_progress") return "In Progress";
  if (job.status === "skipped") return "Skipped";
  if (job.status === "expired") return "Expired";
  return "Review Job";
};

const getDefaultInspectorTab = (
  job: Job | null,
  activeTab: FilterTab,
): InspectorTab => {
  if (!job) return "brief";
  if (activeTab === "ready" || job.status === "ready") return "apply";
  return "brief";
};

const getJobStageNote = (job: Job): string => {
  if (job.status === "ready") {
    return "Ready to apply. Review the brief, use the application kit, then mark it applied.";
  }
  if (job.status === "discovered") {
    return "Newly discovered. Decide if it is worth tailoring, then generate the application kit.";
  }
  if (job.status === "processing") {
    return "JobOps is analyzing this role and preparing the first draft.";
  }
  if (job.status === "applied") {
    return "Already applied. Keep notes, follow-ups, and status changes here.";
  }
  if (job.status === "in_progress") {
    return "Application is in progress. Use this space to keep the job context close.";
  }
  return "Archived or inactive job. The details remain available for reference.";
};

const Stat: React.FC<{
  label: string;
  value?: string | null;
  tone?: "blue" | "green" | "neutral";
}> = ({ label, value, tone = "neutral" }) => {
  if (!value) return null;
  const toneClassName =
    tone === "blue"
      ? "border-sky-400/10 bg-muted/5"
      : tone === "green"
        ? "border-emerald-400/10 bg-muted/5"
        : "border-border/35 bg-muted/5";
  return (
    <div className={cn("min-w-0 rounded-md border px-3 py-2", toneClassName)}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
        {label}
      </div>
      <div className="mt-1 truncate text-xs font-medium text-foreground/85">
        {value}
      </div>
    </div>
  );
};

const FitSignal: React.FC<{ job: Job }> = ({ job }) => {
  if (!job.suitabilityReason) return null;

  const score = job.suitabilityScore ?? 0;
  const isStrong = score >= 75;
  const isRisk = score > 0 && score < 55;
  const toneClassName = isStrong
    ? "border-emerald-400/20 bg-muted/5"
    : isRisk
      ? "border-rose-400/25 bg-muted/5"
      : "border-amber-400/25 bg-muted/5";
  const label = isStrong ? "Strong fit" : isRisk ? "Fit risk" : "Fit check";
  const iconClassName = isStrong
    ? "text-emerald-300"
    : isRisk
      ? "text-rose-300"
      : "text-amber-300";

  return (
    <div className={cn("rounded-lg border px-3 py-3", toneClassName)}>
      <div
        className={cn(
          "mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide",
          iconClassName,
        )}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {label}
        {job.suitabilityScore != null ? (
          <span className="ml-auto text-[10px] tabular-nums opacity-80">
            {job.suitabilityScore}/100
          </span>
        ) : null}
      </div>
      <p className="text-sm leading-relaxed text-foreground/85">
        {job.suitabilityReason}
      </p>
    </div>
  );
};

const KitStatus: React.FC<{ label: string; ready: boolean }> = ({
  label,
  ready,
}) => (
  <div className="flex items-center justify-between gap-3 rounded-md border border-border/35 bg-background/30 px-3 py-2">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        ready
          ? "bg-emerald-500/10 text-emerald-300"
          : "bg-amber-500/10 text-amber-300",
      )}
    >
      {ready ? "Ready" : "Missing"}
    </span>
  </div>
);

const DocumentPolicyCard: React.FC<{
  diagnostics: JobDocumentDiagnostics | null;
  isLoading: boolean;
  canGenerate: boolean;
  isProcessing: boolean;
  isSavingResumeTarget: boolean;
  onRegenerate: () => void;
  onResumeTargetPagesChange: (targetPages: 1 | 2) => void;
}> = ({
  diagnostics,
  isLoading,
  canGenerate,
  isProcessing,
  isSavingResumeTarget,
  onRegenerate,
  onResumeTargetPagesChange,
}) => {
  const pageLabel = diagnostics?.pdf.exists
    ? `${diagnostics.pdf.pageCount ?? "Unknown"} pages`
    : "No PDF";
  const targetPages = diagnostics?.pdf.targetPages ?? 2;
  const targetPageLabel = `${targetPages} page${targetPages === 1 ? "" : "s"}`;
  const issues = diagnostics?.issues ?? [];
  const recommendations = diagnostics?.recommendations ?? [];
  const alignment = diagnostics?.alignment ?? null;
  const serviceFit = diagnostics?.serviceFit ?? null;
  const policy = diagnostics?.policy ?? null;
  const resumePlan = diagnostics?.resumePlan ?? null;
  const evidenceTrace = alignment?.generationTrace ?? null;
  const contentPlan = evidenceTrace?.contentPlan ?? null;
  const experienceAllocations = contentPlan?.experienceAllocations ?? [];
  const experienceAnchors = evidenceTrace?.experienceAnchors ?? [];
  const experienceDigests = evidenceTrace?.experienceDigests ?? [];
  const evidenceItems = evidenceTrace?.selectedEvidence ?? [];
  const directEvidenceCount = evidenceItems.filter(
    (item) => item.status === "selected",
  ).length;
  const transferableEvidenceCount = evidenceItems.filter(
    (item) => item.status === "transferable_only",
  ).length;
  const weakOrMissingEvidenceCount = evidenceItems.filter(
    (item) => item.status === "weak_evidence" || item.status === "no_evidence",
  ).length;
  const canSelectTargetPages =
    Boolean(policy?.allowsManualResumeTargetPages) && !isProcessing;
  const serviceFitTone = serviceFit
    ? serviceFit.status === "pass"
      ? {
          label: "Pass",
          icon: CheckCircle2,
          className:
            "border-emerald-400/25 bg-emerald-500/5 text-emerald-100/90",
          pillClassName: "border-emerald-400/25 text-emerald-200/85",
        }
      : serviceFit.status === "weak_fit"
        ? {
            label: "Weak Fit",
            icon: XCircle,
            className: "border-rose-400/25 bg-rose-500/5 text-rose-100/90",
            pillClassName: "border-rose-400/25 text-rose-200/85",
          }
        : {
            label: "Needs Review",
            icon: AlertTriangle,
            className: "border-amber-400/25 bg-amber-500/5 text-amber-100/90",
            pillClassName: "border-amber-400/25 text-amber-200/85",
          }
    : null;
  const ServiceFitIcon = serviceFitTone?.icon;

  return (
    <div className="rounded-lg border border-border/45 bg-muted/5 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground/90">
            <FileCheck2 className="h-3.5 w-3.5 text-sky-400/80" />
            Document policy
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground/65">
            Resume length, cover letter format, and template health.
          </p>
        </div>
        {isLoading ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <div className="rounded-md border border-border/35 bg-background/30 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Resume
          </div>
          <div className="mt-1 text-xs font-medium text-foreground/85">
            Target {targetPageLabel}
          </div>
          {policy ? (
            <div className="mt-1 text-[10px] text-muted-foreground/70">
              {policy.resumePagePolicyLabel}
            </div>
          ) : null}
        </div>
        <div className="rounded-md border border-border/35 bg-background/30 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Current PDF
          </div>
          <div
            className={cn(
              "mt-1 text-xs font-medium",
              diagnostics?.pdf.exceedsTarget
                ? "text-rose-300"
                : "text-foreground/85",
            )}
          >
            {pageLabel}
          </div>
        </div>
        <div className="rounded-md border border-border/35 bg-background/30 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Skills
          </div>
          <div className="mt-1 text-xs font-medium text-foreground/85">
            {diagnostics
              ? `${diagnostics.skills.tailoredSkillGroups} groups`
              : "Checking"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-border/35 bg-background/30 px-3 py-2">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          Cover letter
        </div>
        <div className="mt-1 text-xs text-foreground/80">
          Personal header, To Whom It May Concern, Re line, max 400 words.
        </div>
      </div>

      {policy ? (
        <div className="mt-3 rounded-md border border-border/35 bg-background/30 px-3 py-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                Resume page rule
              </div>
              <div className="mt-1 text-xs text-foreground/80">
                {policy.reason}
              </div>
            </div>
            {policy.allowsManualResumeTargetPages ? (
              <div className="flex shrink-0 rounded-md border border-border/45 bg-background/40 p-0.5">
                {[1, 2].map((targetPages) => (
                  <Button
                    key={targetPages}
                    type="button"
                    variant={
                      policy.resumeTargetPages === targetPages
                        ? "secondary"
                        : "ghost"
                    }
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={!canSelectTargetPages || isSavingResumeTarget}
                    onClick={() =>
                      onResumeTargetPagesChange(targetPages as 1 | 2)
                    }
                  >
                    {isSavingResumeTarget &&
                    policy.resumeTargetPages === targetPages ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : null}
                    Generate {targetPages} page{targetPages === 1 ? "" : "s"}
                  </Button>
                ))}
              </div>
            ) : (
              <span className="shrink-0 rounded-full border border-border/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Locked
              </span>
            )}
          </div>
        </div>
      ) : null}

      {resumePlan ? (
        <div className="mt-3 rounded-md border border-sky-400/20 bg-sky-500/5 px-3 py-2">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-sky-200/70">
                Resume plan
              </div>
              <div className="mt-1 text-xs font-medium text-sky-50/90">
                {resumePlan.allowsManualResumeTargetPages ? "Manual" : "Locked"}{" "}
                {resumePlan.targetPages}-page · Master:{" "}
                {resumePlan.masterVariant} · {resumePlan.layoutMode}
              </div>
              <div className="mt-1 text-[10px] text-sky-100/65">
                {resumePlan.policyReason}
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-sky-300/25 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-sky-100/80">
              {resumePlan.documentPolicyReason.replaceAll("_", " ")}
            </span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-sky-200/60">
                Format references
              </div>
              <div className="mt-1 text-[10px] leading-relaxed text-sky-50/75">
                {resumePlan.formatReferences.length
                  ? resumePlan.formatReferences
                      .slice(0, 3)
                      .map((item) => item.relativePath || item.fileName)
                      .join("; ")
                  : "No matching format reference selected"}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-sky-200/60">
                Evidence references
              </div>
              <div className="mt-1 text-[10px] leading-relaxed text-sky-50/75">
                {resumePlan.evidenceReferences.length
                  ? resumePlan.evidenceReferences
                      .slice(0, 3)
                      .map(
                        (item) =>
                          `${item.relativePath || item.fileName}${
                            item.section ? ` > ${item.section}` : ""
                          }`,
                      )
                      .join("; ")
                  : "No RAG evidence reference selected"}
              </div>
            </div>
          </div>
        </div>
      ) : diagnostics ? (
        <div className="mt-3 rounded-md border border-border/35 bg-background/25 px-3 py-2 text-muted-foreground">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground/70">
                <FileCheck2 className="h-3.5 w-3.5" />
                Service Fit
              </div>
              <div className="mt-1 text-xs font-medium text-foreground/75">
                Not generated yet
              </div>
              <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground/70">
                Regenerate materials to run JD service-value verification.
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-border/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Pending
            </span>
          </div>
        </div>
      ) : null}

      {serviceFit && serviceFitTone ? (
        <div
          className={cn(
            "mt-3 rounded-md border px-3 py-2",
            serviceFitTone.className,
          )}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-current/75">
                {ServiceFitIcon ? (
                  <ServiceFitIcon className="h-3.5 w-3.5" />
                ) : null}
                Service Fit
              </div>
              <div className="mt-1 text-xs font-medium text-current">
                {serviceFit.targetBuyerNeed}
              </div>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase",
                serviceFitTone.pillClassName,
              )}
            >
              {serviceFitTone.label} - {serviceFit.score}/100
            </span>
          </div>

          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              <div className="text-[10px] font-medium uppercase text-current/60">
                Resume signals
              </div>
              <div className="mt-1 text-[10px] leading-relaxed text-current/75">
                {serviceFit.resumeCurrentlySignals.length
                  ? serviceFit.resumeCurrentlySignals.slice(0, 4).join("; ")
                  : "No clear service-value signal detected."}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase text-current/60">
                Service-value gaps
              </div>
              <div className="mt-1 text-[10px] leading-relaxed text-current/75">
                {serviceFit.missingOrWeakServiceValues.length
                  ? serviceFit.missingOrWeakServiceValues.slice(0, 4).join("; ")
                  : "No major gaps reported."}
              </div>
            </div>
          </div>

          {serviceFit.oldFrameRisks.length ? (
            <div className="mt-2 text-[10px] leading-relaxed text-current/75">
              <span className="font-medium text-current/85">
                Old-frame risk:{" "}
              </span>
              {serviceFit.oldFrameRisks.slice(0, 3).join("; ")}
            </div>
          ) : null}

          {serviceFit.unsupportedOrNeedsConfirmation.length ? (
            <div className="mt-2 rounded-md border border-current/15 bg-background/20 px-2.5 py-2">
              <div className="text-[10px] font-medium uppercase text-current/60">
                Confirm before use
              </div>
              <div className="mt-1 space-y-1 text-[10px] leading-relaxed text-current/75">
                {serviceFit.unsupportedOrNeedsConfirmation
                  .slice(0, 4)
                  .map((item) => (
                    <div key={`${item.severity}-${item.claim}`}>
                      <span className="font-semibold uppercase text-current/85">
                        {item.severity}
                      </span>
                      {": "}
                      {item.claim}
                      {item.recommendation ? ` - ${item.recommendation}` : ""}
                    </div>
                  ))}
              </div>
            </div>
          ) : null}

          {serviceFit.manualFixSuggestions.length ? (
            <div className="mt-2 rounded-md border border-current/15 bg-background/20 px-2.5 py-2">
              <div className="text-[10px] font-medium uppercase text-current/60">
                Suggested manual fixes
              </div>
              <div className="mt-1 space-y-1 text-[10px] leading-relaxed text-current/75">
                {serviceFit.manualFixSuggestions.slice(0, 4).map((item) => (
                  <div key={`${item.section}-${item.issue}`}>
                    <span className="font-semibold uppercase text-current/85">
                      {item.section}
                    </span>
                    {": "}
                    {item.issue}
                    {item.suggestedDirection
                      ? ` - ${item.suggestedDirection}`
                      : ""}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {evidenceItems.length > 0 ? (
        <div className="mt-3 rounded-md border border-border/35 bg-background/25 px-3 py-2">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/65">
                Evidence gate
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground/75">
                {directEvidenceCount} direct | {transferableEvidenceCount}{" "}
                transferable | {weakOrMissingEvidenceCount} weak/no evidence
              </div>
            </div>
            {evidenceTrace?.uncoveredRequirements.length ? (
              <span className="shrink-0 rounded-full border border-amber-400/25 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200/85">
                {evidenceTrace.uncoveredRequirements.length} uncovered
              </span>
            ) : (
              <span className="shrink-0 rounded-full border border-emerald-400/25 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-200/85">
                covered
              </span>
            )}
          </div>
          <div className="mt-2 space-y-1.5">
            {evidenceItems.slice(0, 6).map((item) => {
              const statusClassName =
                item.status === "selected"
                  ? "border-emerald-400/25 bg-emerald-500/5 text-emerald-100/90"
                  : item.status === "transferable_only"
                    ? "border-sky-400/25 bg-sky-500/5 text-sky-100/90"
                    : "border-amber-400/25 bg-amber-500/5 text-amber-100/90";
              const sourceSummary = item.chunks
                .slice(0, 2)
                .map(
                  (chunk) =>
                    `${chunk.sourceFile}${chunk.section ? ` > ${chunk.section}` : ""}`,
                )
                .join("; ");
              return (
                <div
                  key={item.requirementId ?? item.requirement}
                  className={cn(
                    "rounded-md border px-2.5 py-2 text-[10px] leading-relaxed",
                    statusClassName,
                  )}
                >
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 font-medium">
                      {item.requirement}
                    </div>
                    <div className="shrink-0 uppercase tracking-wide">
                      {item.status.replaceAll("_", " ")}
                    </div>
                  </div>
                  <div className="mt-1 text-current/70">
                    fit: {item.fit ?? "unknown"} | confidence:{" "}
                    {item.confidence ?? "unknown"} | candidates:{" "}
                    {item.candidateChunkCount ?? item.chunks.length}
                  </div>
                  {item.allowedClaims?.length ? (
                    <div className="mt-1 text-current/75">
                      allowed: {item.allowedClaims.slice(0, 3).join("; ")}
                    </div>
                  ) : null}
                  {item.blockedClaims?.length ? (
                    <div className="mt-1 text-current/75">
                      blocked: {item.blockedClaims.slice(0, 2).join("; ")}
                    </div>
                  ) : null}
                  {sourceSummary ? (
                    <div className="mt-1 text-current/75">
                      sources: {sourceSummary}
                    </div>
                  ) : item.reason || item.missingReason ? (
                    <div className="mt-1 text-current/75">
                      reason: {item.reason ?? item.missingReason}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {contentPlan ? (
        <div className="mt-3 rounded-md border border-violet-400/20 bg-violet-500/5 px-3 py-2">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-violet-200/70">
                Content allocation
              </div>
              <div className="mt-1 text-[10px] text-violet-50/75">
                Summary {contentPlan.sectionBudgets.summaryWords.min}-
                {contentPlan.sectionBudgets.summaryWords.max} words | Skills{" "}
                {contentPlan.sectionBudgets.skillGroups.min}-
                {contentPlan.sectionBudgets.skillGroups.max} groups | Experience{" "}
                {contentPlan.sectionBudgets.experienceBullets.min}-
                {contentPlan.sectionBudgets.experienceBullets.max} bullets
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-violet-300/25 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-violet-100/80">
              {contentPlan.targetPages} page
              {contentPlan.targetPages === 1 ? "" : "s"}
            </span>
          </div>
          {experienceAllocations.length ? (
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {experienceAllocations.slice(0, 6).map((item) => (
                <div
                  key={item.experienceId}
                  className="rounded-md border border-violet-300/15 px-2.5 py-2 text-[10px] leading-relaxed text-violet-50/80"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 font-medium">{item.label}</span>
                    <span className="shrink-0 uppercase tracking-wide text-violet-100/70">
                      {item.kind}
                    </span>
                  </div>
                  <div className="mt-1 text-violet-100/65">
                    {item.bulletBudget} bullets | {item.fitLevel ?? item.kind} |
                    score {item.experienceFitScore}
                  </div>
                  {item.requiredBulletThemes?.length ? (
                    <div className="mt-1 text-violet-100/60">
                      themes: {item.requiredBulletThemes.slice(0, 3).join("; ")}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {experienceAnchors.length ? (
        <div className="mt-3 rounded-md border border-emerald-400/20 bg-emerald-500/5 px-3 py-2">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-emerald-200/70">
                Experience anchors
              </div>
              <div className="mt-1 text-[10px] text-emerald-50/75">
                Stable cached role summaries used before selecting fine-grained
                evidence.
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-emerald-300/25 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-100/80">
              {experienceAnchors.length} anchors
            </span>
          </div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {experienceAnchors.slice(0, 6).map((anchor) => (
              <div
                key={anchor.experienceAnchorId}
                className="rounded-md border border-emerald-300/15 px-2.5 py-2 text-[10px] leading-relaxed text-emerald-50/80"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-medium">
                    {anchor.identity.title || "Role"} at{" "}
                    {anchor.identity.company || "Unknown"}
                  </span>
                  <span className="shrink-0 uppercase tracking-wide text-emerald-100/70">
                    {anchor.confidence}
                  </span>
                </div>
                <div className="mt-1 text-emerald-100/65">
                  chunks {anchor.sourceChunkIds.length} | files{" "}
                  {anchor.sourceFiles.length} | v{anchor.version}
                </div>
                <div className="mt-1 text-emerald-100/60">
                  {anchor.roleOverview.text}
                </div>
                {anchor.diagnostics.warnings.length ? (
                  <div className="mt-1 text-emerald-100/60">
                    warning:{" "}
                    {anchor.diagnostics.warnings.slice(0, 2).join("; ")}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {experienceDigests.length ? (
        <div className="mt-3 rounded-md border border-cyan-400/20 bg-cyan-500/5 px-3 py-2">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-cyan-200/70">
                Experience digests
              </div>
              <div className="mt-1 text-[10px] text-cyan-50/75">
                Per-role claim map used to keep each experience comprehensive.
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-cyan-300/25 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-100/80">
              {experienceDigests.length} roles
            </span>
          </div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {experienceDigests.slice(0, 6).map((digest) => (
              <div
                key={digest.experienceId}
                className="rounded-md border border-cyan-300/15 px-2.5 py-2 text-[10px] leading-relaxed text-cyan-50/80"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-medium">{digest.label}</span>
                  <span className="shrink-0 uppercase tracking-wide text-cyan-100/70">
                    {digest.fitLevel}
                  </span>
                </div>
                <div className="mt-1 text-cyan-100/65">
                  confidence {digest.confidence} | requirements{" "}
                  {digest.matchedRequirementIds.length} | chunks{" "}
                  {digest.sourceChunkIds.length}
                </div>
                {digest.recommendedBulletThemes.length ? (
                  <div className="mt-1 text-cyan-100/60">
                    themes:{" "}
                    {digest.recommendedBulletThemes.slice(0, 3).join("; ")}
                  </div>
                ) : null}
                {digest.blockedClaims.length ? (
                  <div className="mt-1 text-cyan-100/60">
                    blocked: {digest.blockedClaims.slice(0, 2).join("; ")}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div className="mt-3 space-y-2">
          {issues.map((issue) => (
            <div
              key={issue}
              className="flex gap-2 rounded-md border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-100/85"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{issue}</span>
            </div>
          ))}
        </div>
      ) : null}

      {alignment?.status === "failed" &&
      alignment.missingRequired.length > 0 ? (
        <div className="mt-3 rounded-md border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100/90">
          <div className="font-medium">Needs manual resume review</div>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {alignment.missingRequired.slice(0, 3).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {recommendations.length > 0 || canGenerate ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className="min-w-0 text-xs text-muted-foreground/75">
              {recommendations[0] ?? "Regenerate when tailoring changes."}
            </div>
            <ResumeAlignmentPill report={alignment} />
          </div>
          {canGenerate ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 px-2 text-xs"
              onClick={onRegenerate}
              disabled={isProcessing}
            >
              {isProcessing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCcw className="h-3.5 w-3.5" />
              )}
              Regenerate Materials
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const JobDetailPanel: React.FC<JobDetailPanelProps> = ({
  activeTab,
  activeJobs,
  selectedJob,
  onSelectJobId,
  onJobUpdated,
  onPauseRefreshChange,
}) => {
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("brief");
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [editedDescription, setEditedDescription] = useState("");
  const [isSavingDescription, setIsSavingDescription] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [isEditDetailsOpen, setIsEditDetailsOpen] = useState(false);
  const [catalog, setCatalog] = useState<ResumeProjectCatalogItem[]>([]);
  const [documentDiagnostics, setDocumentDiagnostics] =
    useState<JobDocumentDiagnostics | null>(null);
  const [isLoadingDocumentDiagnostics, setIsLoadingDocumentDiagnostics] =
    useState(false);
  const [documentDiagnosticsRefreshToken, setDocumentDiagnosticsRefreshToken] =
    useState(0);
  const [isSavingResumeTarget, setIsSavingResumeTarget] = useState(false);
  const [isUploadingPdf, setIsUploadingPdf] = useState(false);
  const uploadPdfInputRef = useRef<HTMLInputElement | null>(null);
  const previousSelectionKeyRef = useRef<string | null>(null);
  const markAsAppliedMutation = useMarkAsAppliedMutation();
  const skipJobMutation = useSkipJobMutation();
  const { isRescoring, rescoreJob } = useRescoreJob(onJobUpdated);
  const { personName } = useProfile();
  const { renderMarkdownInJobDescriptions } = useSettings();

  const jobLink = selectedJob
    ? selectedJob.applicationLink || selectedJob.jobUrl
    : "#";
  const selectedPdfFilename = selectedJob
    ? `${safeFilenamePart(personName || "Unknown")}_${safeFilenamePart(selectedJob.employer || "Unknown")}.pdf`
    : "resume.pdf";
  const selectedWordFilename = selectedJob
    ? `${safeFilenamePart(personName || "Unknown")}_${safeFilenamePart(selectedJob.employer || "Unknown")}.docx`
    : "resume.docx";
  const selectedHtmlFilename = selectedJob
    ? `${safeFilenamePart(personName || "Unknown")}_${safeFilenamePart(selectedJob.employer || "Unknown")}.html`
    : "resume.html";
  const resumeAlignment = documentDiagnostics?.alignment ?? null;
  const fallbackDocumentPolicy = useMemo(
    () => (selectedJob ? resolveDocumentPolicy(selectedJob) : null),
    [selectedJob],
  );
  const description = useMemo(
    () => getRenderableJobDescription(selectedJob?.jobDescription),
    [selectedJob?.jobDescription],
  );
  const selectedProjectIds = useMemo(
    () => selectedJob?.selectedProjectIds?.split(",").filter(Boolean) ?? [],
    [selectedJob?.selectedProjectIds],
  );
  const selectedProjects = useMemo(
    () =>
      selectedProjectIds
        .map((id) => catalog.find((project) => project.id === id)?.name ?? id)
        .filter(Boolean),
    [catalog, selectedProjectIds],
  );

  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await api.getResumeProjectsCatalog());
    } catch {
      setCatalog([]);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    const currentJobId = selectedJob?.id ?? null;
    const currentSelectionKey = `${activeTab}:${currentJobId ?? ""}`;
    if (previousSelectionKeyRef.current === currentSelectionKey) return;
    previousSelectionKeyRef.current = currentSelectionKey;
    setInspectorTab(getDefaultInspectorTab(selectedJob, activeTab));
    setIsEditingDescription(false);
    setEditedDescription(selectedJob?.jobDescription || "");
    setIsEditDetailsOpen(false);
    onPauseRefreshChange?.(false);
  }, [activeTab, selectedJob, onPauseRefreshChange]);

  useEffect(() => {
    if (!selectedJob || isEditingDescription) return;
    setEditedDescription(selectedJob.jobDescription || "");
  }, [selectedJob, isEditingDescription]);

  useEffect(() => {
    return () => onPauseRefreshChange?.(false);
  }, [onPauseRefreshChange]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Diagnostics must refresh when generated job artifacts or the explicit refresh token change, although the request itself only needs the job id.
  useEffect(() => {
    let cancelled = false;
    if (!selectedJob) {
      setDocumentDiagnostics(null);
      return;
    }

    setIsLoadingDocumentDiagnostics(true);
    void api
      .getJobDocumentDiagnostics(selectedJob.id)
      .then((result) => {
        if (!cancelled) setDocumentDiagnostics(result);
      })
      .catch(() => {
        if (!cancelled) setDocumentDiagnostics(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingDocumentDiagnostics(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedJob?.id,
    selectedJob?.pdfPath,
    selectedJob?.tailoredSkills,
    selectedJob?.resumeAlignmentReport,
    selectedJob?.resumeServiceFitReport,
    selectedJob?.resumeTargetPagesOverride,
    documentDiagnosticsRefreshToken,
  ]);

  const handleJobMoved = useCallback(
    (jobId: string) => {
      const currentIndex = activeJobs.findIndex((job) => job.id === jobId);
      const nextJob =
        activeJobs[currentIndex + 1] || activeJobs[currentIndex - 1];
      onSelectJobId(nextJob?.id ?? null);
    },
    [activeJobs, onSelectJobId],
  );

  const handleSaveDescription = useCallback(async () => {
    if (!selectedJob) return;
    try {
      setIsSavingDescription(true);
      await api.updateJob(selectedJob.id, {
        jobDescription: editedDescription,
      });
      toast.success("Job description updated");
      setIsEditingDescription(false);
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update description";
      toast.error(message);
    } finally {
      setIsSavingDescription(false);
    }
  }, [editedDescription, onJobUpdated, selectedJob]);

  const handleResumeTargetPagesChange = useCallback(
    async (targetPages: 1 | 2) => {
      if (!selectedJob) return;
      try {
        setIsSavingResumeTarget(true);
        await api.updateJob(selectedJob.id, {
          resumeTargetPagesOverride: targetPages,
        });
        toast.success(
          `Resume target set to ${targetPages} page${targetPages === 1 ? "" : "s"}`,
        );
        await onJobUpdated();
        setDocumentDiagnosticsRefreshToken((value) => value + 1);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to update resume page target";
        toast.error(message);
      } finally {
        setIsSavingResumeTarget(false);
      }
    },
    [onJobUpdated, selectedJob],
  );

  const openEditDetails = useCallback(() => {
    window.setTimeout(() => setIsEditDetailsOpen(true), 0);
  }, []);

  const handleCopyInfo = useCallback(async () => {
    if (!selectedJob) return;

    try {
      await copyTextToClipboard(formatJobForWebhook(selectedJob));
      toast.success("Copied job info");
    } catch {
      toast.error("Could not copy job info");
    }
  }, [selectedJob]);

  const handleProcess = useCallback(async () => {
    if (!selectedJob) return;
    try {
      setIsProcessing(true);
      if (selectedJob.status === "ready") {
        toast.message(
          "Repairing resume from JD + reference evidence if needed...",
        );
        await api.generateJobPdf(selectedJob.id);
        toast.success("Resume materials regenerated");
        trackProductEvent("jobs_job_action_completed", {
          action: "generate_pdf",
          result: "success",
          from_status: selectedJob.status,
        });
      } else {
        await api.processJob(selectedJob.id);
        toast.success("Job moved to Ready", {
          description: "Your tailored Word and HTML materials are ready.",
        });
        trackProductEvent("jobs_job_action_completed", {
          action: "process_job",
          result: "success",
          from_status: selectedJob.status,
          to_status: "ready",
        });
        handleJobMoved(selectedJob.id);
      }
      await onJobUpdated();
      setDocumentDiagnosticsRefreshToken((value) => value + 1);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to process job";
      toast.error(message);
    } finally {
      setIsProcessing(false);
    }
  }, [handleJobMoved, onJobUpdated, selectedJob]);

  const handlePrimaryAction = useCallback(async () => {
    if (!selectedJob) return;
    if (selectedJob.status === "discovered") {
      setInspectorTab("tailoring");
      return;
    }
    if (selectedJob.status === "ready") {
      try {
        setIsApplying(true);
        await markAsAppliedMutation.mutateAsync(selectedJob.id);
        trackProductEvent("jobs_job_action_completed", {
          action: "mark_applied",
          result: "success",
          from_status: selectedJob.status,
          to_status: "applied",
        });
        toast.success("Marked as applied", {
          description: `${selectedJob.title} at ${selectedJob.employer}`,
        });
        handleJobMoved(selectedJob.id);
        await onJobUpdated();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to mark as applied";
        toast.error(message);
      } finally {
        setIsApplying(false);
      }
      return;
    }
    if (selectedJob.status === "applied") {
      try {
        setIsMoving(true);
        await api.updateJob(selectedJob.id, { status: "in_progress" });
        trackProductEvent("jobs_job_action_completed", {
          action: "move_in_progress",
          result: "success",
          from_status: selectedJob.status,
          to_status: "in_progress",
        });
        toast.success("Moved to in progress");
        await onJobUpdated();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to move to in progress";
        toast.error(message);
      } finally {
        setIsMoving(false);
      }
      return;
    }
    setInspectorTab("brief");
  }, [handleJobMoved, markAsAppliedMutation, onJobUpdated, selectedJob]);

  const handleSkip = useCallback(async () => {
    if (!selectedJob) return;
    try {
      await skipJobMutation.mutateAsync(selectedJob.id);
      trackProductEvent("jobs_job_action_completed", {
        action: "skip",
        result: "success",
        from_status: selectedJob.status,
        to_status: "skipped",
      });
      toast.message("Job skipped");
      handleJobMoved(selectedJob.id);
      await onJobUpdated();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to skip";
      toast.error(message);
    }
  }, [handleJobMoved, onJobUpdated, selectedJob, skipJobMutation]);

  const handleOpenPdf = useCallback(() => {
    if (!selectedJob) return;
    void openJobPdf(selectedJob.id).catch((error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not open PDF",
      );
    });
  }, [selectedJob]);

  const handleDownloadPdf = useCallback(() => {
    if (!selectedJob) return;
    void downloadJobPdf(selectedJob.id, selectedPdfFilename).catch((error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not download PDF",
      );
    });
  }, [selectedJob, selectedPdfFilename]);

  const handleOpenWordDraft = useCallback(() => {
    if (!selectedJob) return;
    void openJobWordDraft(selectedJob.id).catch((error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not open Word draft",
      );
    });
  }, [selectedJob]);

  const handleDownloadWordDraft = useCallback(() => {
    if (!selectedJob) return;
    void downloadJobWordDraft(selectedJob.id, selectedWordFilename).catch(
      (error) => {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not download Word draft",
        );
      },
    );
  }, [selectedJob, selectedWordFilename]);

  const handleOpenHtmlResume = useCallback(() => {
    if (!selectedJob) return;
    void openJobHtmlResume(selectedJob.id).catch((error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not open HTML resume",
      );
    });
  }, [selectedJob]);

  const handleDownloadHtmlResume = useCallback(() => {
    if (!selectedJob) return;
    void downloadJobHtmlResume(selectedJob.id, selectedHtmlFilename).catch(
      (error) => {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not download HTML resume",
        );
      },
    );
  }, [selectedJob, selectedHtmlFilename]);

  const handleUploadPdf = useCallback(
    async (file: File) => {
      if (!selectedJob) return;
      try {
        setIsUploadingPdf(true);
        await uploadJobPdfFromFile(selectedJob.id, file);
        toast.success(selectedJob.pdfPath ? "PDF replaced" : "PDF attached");
        await onJobUpdated();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to upload PDF";
        toast.error(message);
      } finally {
        setIsUploadingPdf(false);
        if (uploadPdfInputRef.current) {
          uploadPdfInputRef.current.value = "";
        }
      }
    },
    [onJobUpdated, selectedJob],
  );

  if (!selectedJob) {
    return (
      <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-2 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-border/50 bg-muted/20">
          <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="text-sm font-medium text-muted-foreground">
          No job selected
        </div>
        <p className="max-w-[220px] text-xs text-muted-foreground/70">
          Select a job to see the brief, tailoring, and application kit.
        </p>
      </div>
    );
  }

  const primaryBusy =
    isProcessing ||
    isApplying ||
    isMoving ||
    selectedJob.status === "processing";
  const canGenerate = ["discovered", "ready"].includes(selectedJob.status);
  const canSkip = ["discovered", "ready"].includes(selectedJob.status);
  const tone = statusTone[selectedJob.status];
  const resumePagePolicy =
    documentDiagnostics?.policy ?? fallbackDocumentPolicy;
  const canSelectResumeTargetPages =
    Boolean(resumePagePolicy?.allowsManualResumeTargetPages) && !isProcessing;

  return (
    <div className="flex min-h-[520px] flex-col gap-4">
      <div className="space-y-4">
        <JobHeader
          job={selectedJob}
          onCheckSponsor={async () => {
            await api.checkSponsor(selectedJob.id);
            await onJobUpdated();
          }}
        />

        <div
          className={cn(
            "relative overflow-hidden rounded-lg border p-3",
            tone.shell,
          )}
        >
          <div className={cn("absolute inset-y-0 left-0 w-1", tone.icon)} />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div
                className={cn(
                  "text-[10px] font-semibold uppercase tracking-wide",
                  tone.eyebrow,
                )}
              >
                Next step
              </div>
              <p className="mt-1 text-xs text-foreground/80">
                {getJobStageNote(selectedJob)}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                onClick={() => void handlePrimaryAction()}
                disabled={primaryBusy || selectedJob.status === "processing"}
                className={cn("h-9 gap-1.5 px-3 text-xs", tone.button)}
              >
                {primaryBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : selectedJob.status === "discovered" ? (
                  <Sparkles className="h-3.5 w-3.5" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                {getPrimaryAction(selectedJob)}
                {selectedJob.status === "ready" ? (
                  <KbdHint shortcut="a" className="ml-1" />
                ) : null}
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9"
                    aria-label="More actions"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onSelect={openEditDetails}>
                    <Edit2 className="mr-2 h-4 w-4" />
                    Edit details
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setInspectorTab("brief");
                      setIsEditingDescription(true);
                    }}
                  >
                    <Edit2 className="mr-2 h-4 w-4" />
                    Edit job description
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleCopyInfo()}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy job info
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => rescoreJob(selectedJob.id)}
                    disabled={isRescoring}
                  >
                    <RefreshCcw
                      className={cn(
                        "mr-2 h-4 w-4",
                        isRescoring && "animate-spin",
                      )}
                    />
                    {isRescoring ? "Recalculating..." : "Recalculate match"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {canGenerate && (
                    <DropdownMenuItem
                      onSelect={() => void handleProcess()}
                      disabled={isProcessing}
                    >
                      <RefreshCcw
                        className={cn(
                          "mr-2 h-4 w-4",
                          isProcessing && "animate-spin",
                        )}
                      />
                      {selectedJob.status === "ready"
                        ? "Regenerate Materials"
                        : "Generate Materials"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() => uploadPdfInputRef.current?.click()}
                    disabled={isUploadingPdf}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    {isUploadingPdf
                      ? "Uploading PDF..."
                      : selectedJob.pdfPath
                        ? "Replace PDF"
                        : "Upload PDF"}
                  </DropdownMenuItem>
                  {selectedJob.pdfPath && (
                    <>
                      <DropdownMenuItem onSelect={handleOpenPdf}>
                        <ExternalLink className="mr-2 h-4 w-4" />
                        View PDF
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={handleDownloadPdf}>
                        <Download className="mr-2 h-4 w-4" />
                        Download PDF
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuItem onSelect={handleOpenWordDraft}>
                    <FileText className="mr-2 h-4 w-4" />
                    View Word
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleDownloadWordDraft}>
                    <Download className="mr-2 h-4 w-4" />
                    Download Word
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleOpenHtmlResume}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    View HTML
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleDownloadHtmlResume}>
                    <Download className="mr-2 h-4 w-4" />
                    Download HTML
                  </DropdownMenuItem>
                  {canSkip && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => void handleSkip()}
                        className="text-destructive focus:text-destructive"
                      >
                        <XCircle className="mr-2 h-4 w-4" />
                        Skip job
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {resumePagePolicy?.allowsManualResumeTargetPages ? (
            <div className="mt-3 flex flex-col gap-2 border-t border-border/35 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/65">
                  Resume target
                </div>
                <p className="mt-0.5 text-xs text-foreground/75">
                  Choose which resume length to generate for this application.
                </p>
              </div>
              <div className="flex shrink-0 rounded-md border border-border/45 bg-background/40 p-0.5">
                {[1, 2].map((targetPages) => (
                  <Button
                    key={targetPages}
                    type="button"
                    variant={
                      resumePagePolicy.resumeTargetPages === targetPages
                        ? "secondary"
                        : "ghost"
                    }
                    size="sm"
                    className="h-8 px-2.5 text-[11px]"
                    disabled={
                      !canSelectResumeTargetPages || isSavingResumeTarget
                    }
                    onClick={() =>
                      void handleResumeTargetPagesChange(targetPages as 1 | 2)
                    }
                  >
                    {isSavingResumeTarget &&
                    resumePagePolicy.resumeTargetPages === targetPages ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : null}
                    Generate {targetPages} page{targetPages === 1 ? "" : "s"}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <Tabs
        value={inspectorTab}
        onValueChange={(value) => setInspectorTab(value as InspectorTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TooltipProvider delayDuration={0}>
          <TabsList className="grid h-auto grid-cols-3 gap-1 rounded-lg border border-border/35 bg-background/30 p-1 text-xs">
            {Object.entries(tabCopy).map(([value, copy]) => {
              const isSelected = inspectorTab === value;
              const trigger = (
                <TabsTrigger
                  key={value}
                  value={value}
                  className={cn(
                    "h-9 gap-2 border border-transparent text-xs text-muted-foreground data-[state=active]:shadow-none",
                    isSelected && copy.selectedClassName,
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      copy.dotClassName,
                    )}
                  />
                  <span>{copy.label}</span>
                </TabsTrigger>
              );

              return (
                <Tooltip key={value}>
                  <TooltipTrigger asChild>{trigger}</TooltipTrigger>
                  <TooltipContent className="max-w-xs text-center">
                    <p>{copy.description}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </TabsList>
        </TooltipProvider>

        <div className="mt-2 border-l border-border/50 pl-2 text-[10px] text-muted-foreground/65">
          {tabCopy[inspectorTab].description}
        </div>

        <TabsContent value="brief" className="min-h-0 flex-1 space-y-4 pt-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Stat label="Location" value={selectedJob.location} tone="blue" />
            <Stat label="Salary" value={selectedJob.salary} tone="green" />
            <Stat label="Level" value={selectedJob.jobLevel} />
            <Stat label="Function" value={selectedJob.jobFunction} />
            <Stat label="Type" value={selectedJob.jobType} />
            <Stat label="Discipline" value={selectedJob.disciplines} />
          </div>

          <FitSignal job={selectedJob} />
          <TailoredSummary job={selectedJob} />

          <div className="overflow-hidden rounded-lg border border-border/45 bg-muted/5">
            <div className="flex items-center justify-between gap-2 border-b border-border/35 bg-muted/5 px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground/90">
                  <FileText className="h-3.5 w-3.5 text-sky-400/80" />
                  Job description
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground/65">
                  The source material for deciding, tailoring, and applying.
                </p>
              </div>
              <div className="flex gap-1">
                {!isEditingDescription ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        void copyTextToClipboard(
                          selectedJob.jobDescription || "",
                        );
                        toast.success("Copied job description");
                      }}
                    >
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      Copy
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setIsEditingDescription(true)}
                    >
                      <Edit2 className="mr-1.5 h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setIsEditingDescription(false);
                        setEditedDescription(selectedJob.jobDescription || "");
                      }}
                      disabled={isSavingDescription}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-8 px-2 text-xs"
                      onClick={() => void handleSaveDescription()}
                      disabled={isSavingDescription}
                    >
                      {isSavingDescription ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Save
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="max-h-[420px] overflow-y-auto bg-background/20 p-4 text-sm text-foreground/75">
              {isEditingDescription ? (
                <Textarea
                  value={editedDescription}
                  onChange={(event) => setEditedDescription(event.target.value)}
                  className="min-h-[360px] bg-background/70 font-mono text-sm leading-relaxed focus-visible:ring-1"
                  placeholder="Enter job description..."
                />
              ) : renderMarkdownInJobDescriptions ? (
                <JobDescriptionMarkdown description={description} />
              ) : (
                <div className="whitespace-pre-wrap leading-7">
                  {description}
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent
          value="tailoring"
          className="min-h-0 flex-1 space-y-4 pt-3"
        >
          <TailoringWorkspace
            mode="editor"
            job={selectedJob}
            onUpdate={onJobUpdated}
            onDirtyChange={onPauseRefreshChange}
          />
        </TabsContent>

        <TabsContent value="apply" className="min-h-0 flex-1 space-y-4 pt-3">
          <div className="space-y-3 pb-1">
            <div>
              <h3 className="text-sm font-semibold text-foreground/85">
                Application kit
              </h3>
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                Open, write, and use the generated materials for this job.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              <GhostwriterDrawer
                job={selectedJob}
                triggerClassName="h-10 w-full justify-center gap-1.5 px-2 text-xs"
              />
              <OpenJobListingButton
                href={jobLink}
                className="h-10 w-full px-2 text-xs"
                shortcut="o"
              />
              <Button
                variant="outline"
                className="h-10 w-full gap-1.5 px-2 text-xs"
                onClick={handleDownloadPdf}
                disabled={!selectedJob.pdfPath}
              >
                <Download className="h-3.5 w-3.5" />
                Download PDF
                <KbdHint shortcut="d" className="ml-auto" />
              </Button>
              <Button
                variant="outline"
                className="h-10 w-full gap-1.5 px-2 text-xs"
                onClick={handleOpenPdf}
                disabled={!selectedJob.pdfPath}
              >
                <FileText className="h-3.5 w-3.5" />
                View PDF
              </Button>
              <Button
                variant="outline"
                className="h-10 w-full gap-1.5 px-2 text-xs"
                onClick={handleOpenWordDraft}
              >
                <FileText className="h-3.5 w-3.5" />
                View Word
              </Button>
              <Button
                variant="outline"
                className="h-10 w-full gap-1.5 px-2 text-xs"
                onClick={handleDownloadWordDraft}
              >
                <Download className="h-3.5 w-3.5" />
                Download Word
              </Button>
              <Button
                variant="outline"
                className="h-10 w-full gap-1.5 px-2 text-xs"
                onClick={handleOpenHtmlResume}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View HTML
              </Button>
              {canGenerate && (
                <Button
                  variant="outline"
                  className="h-10 w-full gap-1.5 px-2 text-xs"
                  onClick={() => void handleProcess()}
                  disabled={isProcessing}
                >
                  {isProcessing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCcw className="h-3.5 w-3.5" />
                  )}
                  {selectedJob.status === "ready"
                    ? "Regenerate Materials"
                    : "Generate Materials"}
                </Button>
              )}
            </div>
            {resumeAlignment?.status === "failed" ? (
              <div className="mt-2 rounded-md border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100/90">
                View Word/HTML is available, but this resume needs manual
                changes:
                {resumeAlignment.missingRequired.slice(0, 2).map((item) => (
                  <span key={item} className="ml-1 font-medium">
                    {item}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <DocumentPolicyCard
            diagnostics={documentDiagnostics}
            isLoading={isLoadingDocumentDiagnostics}
            canGenerate={canGenerate}
            isProcessing={isProcessing}
            isSavingResumeTarget={isSavingResumeTarget}
            onRegenerate={() => void handleProcess()}
            onResumeTargetPagesChange={(targetPages) =>
              void handleResumeTargetPagesChange(targetPages)
            }
          />

          <div className="rounded-lg border border-border/45 bg-muted/5 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground/90">
              <FolderKanban className="h-3.5 w-3.5 text-amber-400/80" />
              Selected projects
            </div>
            {selectedProjects.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {selectedProjects.map((project) => (
                  <span
                    key={project}
                    className="rounded-md border border-border/35 bg-background/40 px-2 py-1 text-[11px] text-muted-foreground"
                  >
                    {project}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/70">
                No projects selected yet. Use Tailoring to choose the evidence
                for this role.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-border/45 bg-muted/5 p-3">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-foreground/90">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400/80" />
              Application kit
            </div>
            <div className="space-y-2">
              <KitStatus
                label="Tailored summary"
                ready={Boolean(selectedJob.tailoredSummary)}
              />
              <KitStatus
                label="Tailored skills"
                ready={Boolean(selectedJob.tailoredSkills)}
              />
              <KitStatus label="PDF" ready={Boolean(selectedJob.pdfPath)} />
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <JobDetailsEditDrawer
        open={isEditDetailsOpen}
        onOpenChange={setIsEditDetailsOpen}
        job={selectedJob}
        onJobUpdated={onJobUpdated}
      />

      <input
        ref={uploadPdfInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) {
            void handleUploadPdf(file);
          }
        }}
      />
    </div>
  );
};
