import * as api from "@client/api";
import { useProfile } from "@client/hooks/useProfile";
import { useTracerReadiness } from "@client/hooks/useTracerReadiness";
import { queryKeys } from "@client/lib/queryKeys";
import {
  type ApplicationWritingSettings,
  resolveApplicationWritingStrategy,
} from "@shared/application-writing.js";
import { resolveDocumentPolicy } from "@shared/document-policy.js";
import {
  applyDomainGateToText,
  scanDomainGateResiduals,
} from "@shared/jd-domain-gate.js";
import { buildJdKeywordProfile } from "@shared/jd-keyword-profile.js";
import type {
  JdKeywordProfile,
  Job,
  ResumeReferenceScanResult,
} from "@shared/types.js";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  FileText,
  Loader2,
  Sparkles,
} from "lucide-react";
import type React from "react";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  fromEditableSkillGroups,
  getOriginalHeadline,
  getOriginalSkills,
  getOriginalSummary,
  parseTailoredSkills,
  serializeTailoredSkills,
  toEditableSkillGroups,
} from "../tailoring-utils";
import { canFinalizeTailoring } from "./rules";
import { TailoringSections } from "./TailoringSections";
import {
  getTailoringSavePayloadKey,
  type TailoringSavePayload,
  useTailoringDraft,
} from "./useTailoringDraft";

interface TailoringWorkspaceBaseProps {
  job: Job;
  onDirtyChange?: (isDirty: boolean) => void;
}

interface TailoringWorkspaceEditorProps extends TailoringWorkspaceBaseProps {
  mode: "editor";
  onUpdate: () => void | Promise<void>;
  onRegisterSave?: (save: () => Promise<void>) => void;
  onBeforeGenerate?: () => boolean | Promise<boolean>;
}

interface TailoringWorkspaceTailorProps extends TailoringWorkspaceBaseProps {
  mode: "tailor";
  onBack: () => void;
  onFinalize: () => void;
  isFinalizing: boolean;
  variant?: "discovered" | "ready";
}

type TailoringWorkspaceProps =
  | TailoringWorkspaceEditorProps
  | TailoringWorkspaceTailorProps;
type TailoringSectionsProps = ComponentProps<typeof TailoringSections>;

interface TailoringBaseline {
  summary: string;
  headline: string;
  skillsJson: string;
}

type AutosaveStatus = "saved" | "unsaved" | "saving" | "error";

const AutosaveStatusIcon: React.FC<{ status: AutosaveStatus }> = ({
  status,
}) => {
  const copy =
    status === "saving"
      ? "Saving..."
      : status === "unsaved"
        ? "Unsaved changes"
        : status === "error"
          ? "Save failed"
          : "Saved";
  const iconClassName =
    status === "error"
      ? "text-rose-300"
      : status === "unsaved"
        ? "text-amber-300"
        : status === "saving"
          ? "text-muted-foreground"
          : "text-emerald-400/80";

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground"
            role="img"
            aria-label={copy}
          >
            {status === "saving" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : status === "error" || status === "unsaved" ? (
              <CircleAlert className={`h-3.5 w-3.5 ${iconClassName}`} />
            ) : (
              <Check className={`h-3.5 w-3.5 ${iconClassName}`} />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{copy}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const normalizeSkillsJson = (value: string | null | undefined) =>
  serializeTailoredSkills(parseTailoredSkills(value));

const toBaselineFromJob = (job: Job): TailoringBaseline => ({
  summary: job.tailoredSummary ?? "",
  headline: job.tailoredHeadline ?? "",
  skillsJson: normalizeSkillsJson(job.tailoredSkills),
});

const toSavePayloadFromJob = (job: Job): TailoringSavePayload => ({
  tailoredSummary: job.tailoredSummary ?? "",
  tailoredHeadline: job.tailoredHeadline ?? "",
  tailoredSkills: normalizeSkillsJson(job.tailoredSkills),
  jobDescription: job.jobDescription ?? "",
  selectedProjectIds: job.selectedProjectIds ?? "",
  tracerLinksEnabled: Boolean(job.tracerLinksEnabled),
});

const DEFAULT_APPLICATION_WRITING_SETTINGS: ApplicationWritingSettings = {
  humanizerEnabled: true,
  impactFramingEnabled: true,
  roleFramingMode: "auto",
  manualRoleFamily: "public_sector_policy_economic_development",
  customRoleFramingInstructions: "",
};

const REFERENCE_INDEX_STALE_MS = 14 * 24 * 60 * 60 * 1000;

function getReferenceGenerationNotice(
  scan: ResumeReferenceScanResult | null | undefined,
  now = Date.now(),
): { tone: "warning" | "error"; message: string } | null {
  if (!scan) {
    return {
      tone: "warning",
      message:
        "Reference index unavailable. Re-scan Resume References before generating if you want AI to use your full reference folder.",
    };
  }
  if (scan.indexStatus === "failed") {
    return {
      tone: "error",
      message:
        "Reference index failed to build. Re-scan the folder; generation will fall back to the master resume until indexing succeeds.",
    };
  }
  if (scan.indexStatus !== "indexed" && (scan.chunkCount ?? 0) > 0) {
    return {
      tone: "warning",
      message:
        "Reference index was scanned locally but is not searchable yet. Re-scan Resume References so Job Ops can save and index the reference evidence.",
    };
  }
  if ((scan.chunkCount ?? 0) === 0) {
    return {
      tone: "warning",
      message:
        "Reference index has no searchable chunks. Re-scan Resume References after adding resume or cover letter files.",
    };
  }
  const indexedAt = Date.parse(scan.lastIndexedAt ?? scan.scannedAt);
  if (Number.isFinite(indexedAt) && now - indexedAt > REFERENCE_INDEX_STALE_MS) {
    return {
      tone: "warning",
      message:
        "Reference index may be stale. Re-scan after folder changes so this draft uses the latest evidence.",
    };
  }
  return null;
}

const parseJdKeywordProfile = (
  value: string | null | undefined,
): JdKeywordProfile | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<JdKeywordProfile>;
    if (!parsed || typeof parsed.roleFamily !== "string") return null;
    return {
      roleFamily: parsed.roleFamily,
      requiredKeywords: Array.isArray(parsed.requiredKeywords)
        ? parsed.requiredKeywords.filter(
            (keyword): keyword is string => typeof keyword === "string",
          )
        : [],
      domainKeywordsPresent: Array.isArray(parsed.domainKeywordsPresent)
        ? parsed.domainKeywordsPresent.filter(
            (keyword): keyword is string => typeof keyword === "string",
          )
        : [],
      blockedUnlessPresent: Array.isArray(parsed.blockedUnlessPresent)
        ? parsed.blockedUnlessPresent.filter(
            (keyword): keyword is string => typeof keyword === "string",
          )
        : [],
      experienceFocus: Array.isArray(parsed.experienceFocus)
        ? parsed.experienceFocus.filter(
            (focus): focus is string => typeof focus === "string",
          )
        : [],
    };
  } catch {
    return null;
  }
};

const formatList = (items: string[], fallback = "None detected") =>
  items.length > 0 ? items.slice(0, 8).join(", ") : fallback;

const TailoringDiagnosticsPanel: React.FC<{
  profile: JdKeywordProfile;
  summary: string;
  skillsJson: string;
  tailoredExperience?: string | null;
}> = ({ profile, summary, skillsJson, tailoredExperience }) => {
  const gateCheck = applyDomainGateToText(
    [summary, skillsJson, tailoredExperience ?? ""].join("\n"),
    profile,
  );
  const residuals = scanDomainGateResiduals(
    [summary, skillsJson, tailoredExperience ?? ""].join("\n"),
    profile,
  );
  const gateStatus = gateCheck.changed
    ? "Would clean current draft"
    : profile.blockedUnlessPresent.length > 0
      ? "Active, no blocked terms detected"
      : "No blocked domain terms";
  const pdfGateStatus =
    residuals.blockedTerms.length > 0
      ? `Blocks ${residuals.blockedTerms.join(", ")}`
      : "Clean for visible draft fields";

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-foreground/85">
          JD keyword diagnostics
        </span>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
          {profile.roleFamily.replaceAll("_", " ")}
        </span>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
          {gateStatus}
        </span>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
          PDF gate: {pdfGateStatus}
        </span>
      </div>
      <div className="mt-2 grid gap-2 text-[10px] leading-relaxed text-muted-foreground sm:grid-cols-2">
        <div>
          <span className="text-foreground/70">Required keywords:</span>{" "}
          {formatList(profile.requiredKeywords)}
        </div>
        <div>
          <span className="text-foreground/70">Domain terms present:</span>{" "}
          {formatList(profile.domainKeywordsPresent)}
        </div>
        <div>
          <span className="text-foreground/70">Blocked unless present:</span>{" "}
          {formatList(profile.blockedUnlessPresent)}
        </div>
        <div>
          <span className="text-foreground/70">Experience focus:</span>{" "}
          {formatList(profile.experienceFocus)}
        </div>
      </div>
    </div>
  );
};

export const TailoringWorkspace: React.FC<TailoringWorkspaceProps> = (
  props,
) => {
  const editorProps = props.mode === "editor" ? props : null;
  const tailorProps = props.mode === "tailor" ? props : null;

  const {
    catalog,
    isCatalogLoading,
    summary,
    setSummary,
    headline,
    setHeadline,
    jobDescription,
    setJobDescription,
    selectedIds,
    selectedIdsCsv,
    tracerLinksEnabled,
    setTracerLinksEnabled,
    skillsDraft,
    setSkillsDraft,
    openSkillGroupId,
    setOpenSkillGroupId,
    skillsJson,
    isDirty,
    savedPayloadKey,
    applyIncomingDraft,
    markSavedJob,
    handleToggleProject,
    handleAddSkillGroup,
    handleUpdateSkillGroup,
    handleRemoveSkillGroup,
  } = useTailoringDraft({
    job: props.job,
    onDirtyChange: props.onDirtyChange,
  });

  const [isSaving, setIsSaving] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>("saved");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSavingResumeTarget, setIsSavingResumeTarget] = useState(false);
  const [resumeTargetPagesOverride, setResumeTargetPagesOverride] = useState<
    1 | 2 | null
  >(props.job.resumeTargetPagesOverride ?? null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const saveAgainRef = useRef(false);
  const latestPayloadRef = useRef<TailoringSavePayload | null>(null);
  const persistedPayloadKeyRef = useRef(savedPayloadKey);
  const isMountedRef = useRef(true);
  const { profile, error: profileError } = useProfile();
  const { readiness: tracerReadiness, isChecking: isTracerReadinessChecking } =
    useTracerReadiness();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings.current(),
    queryFn: api.getSettings,
    staleTime: 30_000,
  });
  const resumeReferencesQuery = useQuery({
    queryKey: queryKeys.settings.resumeReferences(),
    queryFn: api.getResumeReferenceScan,
    staleTime: 30_000,
  });

  const originalValues = useMemo(() => {
    const skillsDraft = toEditableSkillGroups(getOriginalSkills(profile));
    return {
      summary: getOriginalSummary(profile),
      headline: getOriginalHeadline(profile),
      skillsDraft,
      skillsJson: serializeTailoredSkills(fromEditableSkillGroups(skillsDraft)),
    };
  }, [profile]);
  const canUseOriginalValues = Boolean(profile) && !profileError;
  const applicationWritingStrategy = useMemo(() => {
    const settings = settingsQuery.data;
    const applicationSettings: ApplicationWritingSettings = settings
      ? {
          humanizerEnabled:
            settings.humanizerEnabled?.value ??
            DEFAULT_APPLICATION_WRITING_SETTINGS.humanizerEnabled,
          impactFramingEnabled:
            settings.impactFramingEnabled?.value ??
            DEFAULT_APPLICATION_WRITING_SETTINGS.impactFramingEnabled,
          roleFramingMode:
            settings.roleFramingMode?.value ??
            DEFAULT_APPLICATION_WRITING_SETTINGS.roleFramingMode,
          manualRoleFamily:
            settings.manualRoleFamily?.value ??
            DEFAULT_APPLICATION_WRITING_SETTINGS.manualRoleFamily,
          customRoleFramingInstructions:
            settings.customRoleFramingInstructions?.value ??
            DEFAULT_APPLICATION_WRITING_SETTINGS.customRoleFramingInstructions,
        }
      : DEFAULT_APPLICATION_WRITING_SETTINGS;

    return resolveApplicationWritingStrategy({
      settings: applicationSettings,
      roleInput: {
        title: props.job.title,
        employer: props.job.employer,
        jobDescription,
      },
    });
  }, [props.job.title, props.job.employer, jobDescription, settingsQuery.data]);
  const documentPolicy = useMemo(
    () =>
      resolveDocumentPolicy({
        source: props.job.source,
        title: props.job.title,
        employer: props.job.employer,
        jobDescription,
        jobUrl: props.job.jobUrl,
        applicationLink: props.job.applicationLink,
        location: props.job.location,
        resumeTargetPagesOverride,
      }),
    [
      props.job.source,
      props.job.title,
      props.job.employer,
      props.job.jobUrl,
      props.job.applicationLink,
      props.job.location,
      jobDescription,
      resumeTargetPagesOverride,
    ],
  );
  const jdDiagnosticsProfile = useMemo(
    () =>
      parseJdKeywordProfile(props.job.jdKeywordProfile) ??
      buildJdKeywordProfile({
        title: props.job.title,
        employer: props.job.employer,
        jobDescription,
      }),
    [
      props.job.jdKeywordProfile,
      props.job.title,
      props.job.employer,
      jobDescription,
    ],
  );
  const [aiBaseline, setAiBaseline] = useState<TailoringBaseline>(() =>
    toBaselineFromJob(props.job),
  );

  useEffect(() => {
    setAiBaseline({
      summary: props.job.tailoredSummary ?? "",
      headline: props.job.tailoredHeadline ?? "",
      skillsJson: normalizeSkillsJson(props.job.tailoredSkills),
    });
  }, [
    props.job.tailoredSummary,
    props.job.tailoredHeadline,
    props.job.tailoredSkills,
  ]);

  useEffect(() => {
    setResumeTargetPagesOverride(props.job.resumeTargetPagesOverride ?? null);
  }, [props.job.id, props.job.resumeTargetPagesOverride]);

  const tracerEnableBlocked =
    !tracerLinksEnabled && !tracerReadiness?.canEnable;
  const tracerEnableBlockedReason =
    tracerReadiness?.canEnable === false
      ? (tracerReadiness.reason ??
        "Verify tracer links in Settings before enabling this job.")
      : null;

  const savePayload = useMemo<TailoringSavePayload>(
    () => ({
      tailoredSummary: summary,
      tailoredHeadline: headline,
      tailoredSkills: skillsJson,
      jobDescription,
      selectedProjectIds: selectedIdsCsv,
      tracerLinksEnabled,
    }),
    [
      summary,
      headline,
      skillsJson,
      jobDescription,
      selectedIdsCsv,
      tracerLinksEnabled,
    ],
  );
  const savePayloadKey = useMemo(
    () => getTailoringSavePayloadKey(savePayload),
    [savePayload],
  );

  useEffect(() => {
    latestPayloadRef.current = savePayload;
  }, [savePayload]);

  useEffect(() => {
    persistedPayloadKeyRef.current = savedPayloadKey;
  }, [savedPayloadKey]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
    };
  }, []);

  const persistCurrent = useCallback(async () => {
    const updatedJob = await api.updateJob(props.job.id, savePayload);
    applyIncomingDraft(updatedJob);
  }, [props.job.id, savePayload, applyIncomingDraft]);

  const runAutosaveLoop = useCallback(async () => {
    if (!editorProps) return;
    if (saveInFlightRef.current) {
      saveAgainRef.current = true;
      await saveInFlightRef.current;
      return;
    }

    const savePromise = (async () => {
      try {
        do {
          saveAgainRef.current = false;
          const snapshot = latestPayloadRef.current;
          if (!snapshot) return;

          if (
            getTailoringSavePayloadKey(snapshot) ===
            persistedPayloadKeyRef.current
          ) {
            if (isMountedRef.current) setAutosaveStatus("saved");
            return;
          }

          if (isMountedRef.current) setAutosaveStatus("saving");
          const snapshotKey = getTailoringSavePayloadKey(snapshot);
          const updatedJob = await api.updateJob(props.job.id, snapshot);
          if (!isMountedRef.current) return;
          const updatedPayload = toSavePayloadFromJob(updatedJob);

          const latestStillMatchesSnapshot =
            latestPayloadRef.current &&
            getTailoringSavePayloadKey(latestPayloadRef.current) ===
              snapshotKey;
          if (latestStillMatchesSnapshot) {
            applyIncomingDraft(updatedJob);
            latestPayloadRef.current = updatedPayload;
          } else {
            markSavedJob(updatedJob);
          }
          persistedPayloadKeyRef.current =
            getTailoringSavePayloadKey(updatedPayload);

          const latestKey = latestPayloadRef.current
            ? getTailoringSavePayloadKey(latestPayloadRef.current)
            : persistedPayloadKeyRef.current;
          if (isMountedRef.current) {
            setAutosaveStatus(
              latestKey === persistedPayloadKeyRef.current
                ? "saved"
                : "unsaved",
            );
          }
        } while (
          saveAgainRef.current ||
          (latestPayloadRef.current &&
            getTailoringSavePayloadKey(latestPayloadRef.current) !==
              persistedPayloadKeyRef.current)
        );
      } catch {
        if (isMountedRef.current) setAutosaveStatus("error");
        throw new Error("Autosave failed");
      } finally {
        saveInFlightRef.current = null;
      }
    })();

    saveInFlightRef.current = savePromise;
    await savePromise;
  }, [applyIncomingDraft, editorProps, markSavedJob, props.job.id]);

  const flushAutosave = useCallback(async () => {
    if (!editorProps) return;
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (saveInFlightRef.current) {
      saveAgainRef.current = true;
      await saveInFlightRef.current;
    }
    const latestPayload = latestPayloadRef.current;
    if (
      latestPayload &&
      getTailoringSavePayloadKey(latestPayload) !==
        persistedPayloadKeyRef.current
    ) {
      await runAutosaveLoop();
    }
  }, [editorProps, runAutosaveLoop]);

  useEffect(() => {
    if (!editorProps) return;
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    if (!isDirty || savePayloadKey === persistedPayloadKeyRef.current) {
      if (!saveInFlightRef.current) setAutosaveStatus("saved");
      return;
    }

    setAutosaveStatus("unsaved");
    if (saveInFlightRef.current) {
      saveAgainRef.current = true;
      return;
    }

    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void runAutosaveLoop().catch(() => {
        // The status state already reflects the failure; keep the draft local.
      });
    }, 800);

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [editorProps, isDirty, runAutosaveLoop, savePayloadKey]);

  useEffect(() => {
    if (!editorProps?.onRegisterSave) return;
    editorProps.onRegisterSave(flushAutosave);
  }, [editorProps, flushAutosave]);

  const handleSummarizeEditor = useCallback(async () => {
    if (!editorProps) return;

    try {
      setIsSummarizing(true);
      await flushAutosave();

      const updatedJob = await api.summarizeJob(props.job.id, { force: true });
      applyIncomingDraft(updatedJob);
      setAiBaseline(toBaselineFromJob(updatedJob));
      toast.success("Draft content generated");
      await editorProps.onUpdate();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "AI summarization failed";
      toast.error(message);
    } finally {
      setIsSummarizing(false);
    }
  }, [editorProps, flushAutosave, props.job.id, applyIncomingDraft]);

  const handleGenerateWithAi = useCallback(async () => {
    if (!tailorProps) return;

    try {
      setIsGenerating(true);

      if (isDirty) {
        await persistCurrent();
      }

      const updatedJob = await api.summarizeJob(props.job.id, { force: true });
      applyIncomingDraft(updatedJob);
      setAiBaseline(toBaselineFromJob(updatedJob));

      toast.success("Draft generated with AI", {
        description: "Review and edit before finalizing.",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to generate AI draft";
      toast.error(message);
    } finally {
      setIsGenerating(false);
    }
  }, [tailorProps, isDirty, persistCurrent, props.job.id, applyIncomingDraft]);

  const handleGeneratePdf = useCallback(async () => {
    if (!editorProps) return;

    try {
      const shouldProceed = editorProps.onBeforeGenerate
        ? await editorProps.onBeforeGenerate()
        : true;
      if (shouldProceed === false) return;

      setIsGeneratingPdf(true);
      await flushAutosave();
      await api.generateJobPdf(props.job.id);
      toast.success("Resume materials generated");
      await editorProps.onUpdate();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Resume generation failed";
      if (/tracer/i.test(message)) {
        toast.error("Tracer links are unavailable right now", {
          description: message,
        });
      } else {
        toast.error(message);
      }
    } finally {
      setIsGeneratingPdf(false);
    }
  }, [editorProps, flushAutosave, props.job.id]);

  const handleResumeTargetPagesChange = useCallback(
    async (targetPages: 1 | 2) => {
      if (!documentPolicy.allowsManualResumeTargetPages) return;
      try {
        setIsSavingResumeTarget(true);
        setResumeTargetPagesOverride(targetPages);
        await api.updateJob(props.job.id, {
          resumeTargetPagesOverride: targetPages,
        });
        toast.success(
          `Resume target set to ${targetPages} page${targetPages === 1 ? "" : "s"}`,
        );
        if (editorProps) await editorProps.onUpdate();
      } catch (error) {
        setResumeTargetPagesOverride(props.job.resumeTargetPagesOverride ?? null);
        const message =
          error instanceof Error
            ? error.message
            : "Failed to update resume page target";
        toast.error(message);
      } finally {
        setIsSavingResumeTarget(false);
      }
    },
    [documentPolicy, editorProps, props.job.id, props.job.resumeTargetPagesOverride],
  );

  const handleFinalize = useCallback(async () => {
    if (!tailorProps) return;

    if (isDirty) {
      try {
        setIsSaving(true);
        await persistCurrent();
      } catch {
        toast.error("Failed to save draft before finalizing");
        setIsSaving(false);
        return;
      } finally {
        setIsSaving(false);
      }
    }

    tailorProps.onFinalize();
  }, [tailorProps, isDirty, persistCurrent]);

  const handleUndoSummary = useCallback(() => {
    setSummary(originalValues.summary);
  }, [originalValues.summary, setSummary]);

  const handleUndoHeadline = useCallback(() => {
    setHeadline(originalValues.headline);
  }, [originalValues.headline, setHeadline]);

  const handleUndoSkills = useCallback(() => {
    setSkillsDraft(originalValues.skillsDraft);
  }, [originalValues.skillsDraft, setSkillsDraft]);

  const handleRedoSummary = useCallback(() => {
    setSummary(aiBaseline.summary);
  }, [aiBaseline.summary, setSummary]);

  const handleRedoHeadline = useCallback(() => {
    setHeadline(aiBaseline.headline);
  }, [aiBaseline.headline, setHeadline]);

  const handleRedoSkills = useCallback(() => {
    setSkillsDraft(
      toEditableSkillGroups(parseTailoredSkills(aiBaseline.skillsJson)),
    );
  }, [aiBaseline.skillsJson, setSkillsDraft]);

  const disableInputs = editorProps
    ? isSummarizing || isGeneratingPdf || isSaving
    : isGenerating || Boolean(tailorProps?.isFinalizing) || isSaving;

  const canFinalize = canFinalizeTailoring(summary);
  const tailoringSectionsProps = useMemo<TailoringSectionsProps>(
    () => ({
      catalog,
      isCatalogLoading,
      summary,
      headline,
      jobDescription,
      skillsDraft,
      selectedIds,
      tracerLinksEnabled,
      tracerEnableBlocked,
      tracerEnableBlockedReason,
      tracerReadinessChecking: isTracerReadinessChecking,
      openSkillGroupId,
      disableInputs,
      onSummaryChange: setSummary,
      onHeadlineChange: setHeadline,
      onUndoSummary: handleUndoSummary,
      onUndoHeadline: handleUndoHeadline,
      onUndoSkills: handleUndoSkills,
      onRedoSummary: handleRedoSummary,
      onRedoHeadline: handleRedoHeadline,
      onRedoSkills: handleRedoSkills,
      canUndoSummary:
        canUseOriginalValues && summary !== originalValues.summary,
      canUndoHeadline:
        canUseOriginalValues && headline !== originalValues.headline,
      canUndoSkills:
        canUseOriginalValues && skillsJson !== originalValues.skillsJson,
      canRedoSummary: summary !== aiBaseline.summary,
      canRedoHeadline: headline !== aiBaseline.headline,
      canRedoSkills: skillsJson !== aiBaseline.skillsJson,
      undoDisabledReason: canUseOriginalValues
        ? null
        : "Original base CV unavailable.",
      onDescriptionChange: setJobDescription,
      onSkillGroupOpenChange: setOpenSkillGroupId,
      onAddSkillGroup: handleAddSkillGroup,
      onUpdateSkillGroup: handleUpdateSkillGroup,
      onRemoveSkillGroup: handleRemoveSkillGroup,
      onToggleProject: handleToggleProject,
      onTracerLinksEnabledChange: setTracerLinksEnabled,
    }),
    [
      catalog,
      isCatalogLoading,
      summary,
      headline,
      jobDescription,
      skillsDraft,
      selectedIds,
      tracerLinksEnabled,
      tracerEnableBlocked,
      tracerEnableBlockedReason,
      isTracerReadinessChecking,
      openSkillGroupId,
      disableInputs,
      setSummary,
      setHeadline,
      handleUndoSummary,
      handleUndoHeadline,
      handleUndoSkills,
      handleRedoSummary,
      handleRedoHeadline,
      handleRedoSkills,
      canUseOriginalValues,
      originalValues,
      skillsJson,
      aiBaseline,
      setJobDescription,
      setOpenSkillGroupId,
      handleAddSkillGroup,
      handleUpdateSkillGroup,
      handleRemoveSkillGroup,
      handleToggleProject,
      setTracerLinksEnabled,
    ],
  );

  const applicationWritingPanel = (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-foreground/85">
          Application writing strategy
        </span>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
          {applicationWritingStrategy.roleLabel}
        </span>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
          Humanizer {applicationWritingStrategy.humanizerEnabled ? "on" : "off"}
        </span>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
          Impact{" "}
          {applicationWritingStrategy.impactFramingEnabled ? "on" : "off"}
        </span>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        Look for metrics before finalizing:{" "}
        {applicationWritingStrategy.metricHints.join(", ")}.
      </p>
    </div>
  );
  const referenceGenerationNotice = getReferenceGenerationNotice(
    resumeReferencesQuery.data,
  );
  const referenceGenerationPanel = referenceGenerationNotice ? (
    <div
      className={`rounded-lg border p-3 text-xs leading-relaxed ${
        referenceGenerationNotice.tone === "error"
          ? "border-rose-500/35 bg-rose-500/10 text-rose-200"
          : "border-amber-500/35 bg-amber-500/10 text-amber-100"
      }`}
    >
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{referenceGenerationNotice.message}</span>
      </div>
    </div>
  ) : null;

  const documentPolicyPanel = (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground/85">
              Resume page policy
            </span>
            <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
              {documentPolicy.resumePagePolicyLabel}
            </span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {documentPolicy.reason}
          </p>
        </div>
        {documentPolicy.allowsManualResumeTargetPages ? (
          <div className="flex shrink-0 rounded-md border border-border/45 bg-background/40 p-0.5">
            {[1, 2].map((targetPages) => (
              <Button
                key={targetPages}
                type="button"
                variant={
                  documentPolicy.resumeTargetPages === targetPages
                    ? "secondary"
                    : "ghost"
                }
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={disableInputs || isSavingResumeTarget}
                onClick={() =>
                  void handleResumeTargetPagesChange(targetPages as 1 | 2)
                }
              >
                {isSavingResumeTarget &&
                documentPolicy.resumeTargetPages === targetPages ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : null}
                Generate {targetPages} page{targetPages === 1 ? "" : "s"}
              </Button>
            ))}
          </div>
        ) : (
          <span className="shrink-0 rounded-full border border-border/60 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Locked
          </span>
        )}
      </div>
    </div>
  );

  if (editorProps) {
    return (
      <div className="space-y-4">
        <div className="space-y-3 pb-2">
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-semibold text-foreground/85">
                Tailoring
              </h3>
              <AutosaveStatusIcon status={autosaveStatus} />
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">
              Changes autosave. Draft resume content, or generate the PDF.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              onClick={handleSummarizeEditor}
              disabled={isSummarizing || isGeneratingPdf}
              variant="outline"
              className="h-10 w-full gap-1.5 px-2 text-xs"
            >
              {isSummarizing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              Draft Content
            </Button>
            <Button
              onClick={handleGeneratePdf}
              disabled={isSummarizing || isGeneratingPdf || !summary}
              className="h-10 w-full gap-1.5 px-2 text-xs"
            >
              {isGeneratingPdf ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="mr-2 h-4 w-4" />
              )}
              Generate Materials
            </Button>
          </div>
        </div>

        <div className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
          {referenceGenerationPanel}
          {applicationWritingPanel}
          {documentPolicyPanel}
          <TailoringDiagnosticsPanel
            profile={jdDiagnosticsProfile}
            summary={summary}
            skillsJson={skillsJson}
            tailoredExperience={props.job.tailoredExperience}
          />
          <TailoringSections {...tailoringSectionsProps} />
        </div>
      </div>
    );
  }

  if (!tailorProps) return null;

  const finalizeVariant = tailorProps.variant ?? "discovered";

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={tailorProps.onBack}
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to overview
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="flex flex-col gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
              <span className="text-xs font-medium text-amber-300">
                Draft tailoring for this role
              </span>
            </div>
            <p className="ml-4 mt-1 text-[10px] text-muted-foreground">
              AI can draft summary, headline, skills, and project selection.
            </p>
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={handleGenerateWithAi}
            disabled={isGenerating || tailorProps.isFinalizing || isSaving}
            className="h-8 w-full text-xs sm:w-auto"
          >
            {isGenerating ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            )}
            Generate draft
          </Button>
        </div>

        {applicationWritingPanel}
        {referenceGenerationPanel}
        {documentPolicyPanel}
        <TailoringDiagnosticsPanel
          profile={jdDiagnosticsProfile}
          summary={summary}
          skillsJson={skillsJson}
          tailoredExperience={props.job.tailoredExperience}
        />

        <TailoringSections {...tailoringSectionsProps} />
      </div>

      <Separator className="my-4 opacity-50" />

      <div className="space-y-2">
        {!canFinalize && (
          <p className="text-center text-[10px] text-muted-foreground">
            Add a summary to{" "}
            {finalizeVariant === "ready" ? "regenerate" : "finalize"}.
          </p>
        )}
        <Button
          onClick={() => void handleFinalize()}
          disabled={tailorProps.isFinalizing || !canFinalize || isGenerating}
          className="h-10 w-full bg-emerald-600 text-white hover:bg-emerald-500"
        >
          {tailorProps.isFinalizing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {finalizeVariant === "ready"
                ? "Regenerating materials..."
                : "Finalizing & generating materials..."}
            </>
          ) : (
            <>
              <Check className="mr-2 h-4 w-4" />
              {finalizeVariant === "ready"
                ? "Regenerate Materials"
                : "Finalize & Move to Ready"}
            </>
          )}
        </Button>
        <p className="text-center text-[10px] text-muted-foreground/70">
          {finalizeVariant === "ready"
            ? "This will save your changes and regenerate Word/HTML materials."
            : "This will generate Word/HTML materials and move the job to Ready."}
        </p>
      </div>
    </div>
  );
};
