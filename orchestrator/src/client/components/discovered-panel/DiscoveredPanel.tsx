import * as api from "@client/api";
import { useSkipJobMutation } from "@client/hooks/queries/useJobMutations";
import { useRescoreJob } from "@client/hooks/useRescoreJob";
import type { Job } from "@shared/types.js";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { trackProductEvent } from "@/lib/analytics";
import { JobDetailsEditDrawer } from "../JobDetailsEditDrawer";
import { DecideMode } from "./DecideMode";
import { EmptyState } from "./EmptyState";
import { ProcessingState } from "./ProcessingState";
import { TailorMode } from "./TailorMode";

type PanelMode = "decide" | "tailor";

interface DiscoveredPanelProps {
  job: Job | null;
  onJobUpdated: () => void | Promise<void>;
  onJobMoved: (jobId: string) => void;
  onTailoringDirtyChange?: (isDirty: boolean) => void;
}

export const DiscoveredPanel: React.FC<DiscoveredPanelProps> = ({
  job,
  onJobUpdated,
  onJobMoved,
  onTailoringDirtyChange,
}) => {
  const [mode, setMode] = useState<PanelMode>("decide");
  const [isSkipping, setIsSkipping] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isEditDetailsOpen, setIsEditDetailsOpen] = useState(false);
  const previousJobIdRef = useRef<string | null>(null);
  const skipJobMutation = useSkipJobMutation();
  const { isRescoring, rescoreJob } = useRescoreJob(onJobUpdated);

  useEffect(() => {
    const currentJobId = job?.id ?? null;
    if (previousJobIdRef.current === currentJobId) return;
    previousJobIdRef.current = currentJobId;
    setMode("decide");
    setIsSkipping(false);
    setIsFinalizing(false);
    setIsEditDetailsOpen(false);
    onTailoringDirtyChange?.(false);
  }, [job?.id, onTailoringDirtyChange]);

  useEffect(() => {
    if (mode !== "tailor") {
      onTailoringDirtyChange?.(false);
    }
  }, [mode, onTailoringDirtyChange]);

  useEffect(() => {
    return () => onTailoringDirtyChange?.(false);
  }, [onTailoringDirtyChange]);

  const handleSkip = async () => {
    if (!job) return;
    try {
      setIsSkipping(true);
      await skipJobMutation.mutateAsync(job.id);
      trackProductEvent("jobs_job_action_completed", {
        action: "skip",
        result: "success",
        from_status: job.status,
        to_status: "skipped",
      });
      toast.message("Job skipped");
      onJobMoved(job.id);
      await onJobUpdated();
    } catch (error) {
      trackProductEvent("jobs_job_action_completed", {
        action: "skip",
        result: "error",
        from_status: job.status,
        to_status: "skipped",
      });
      const message =
        error instanceof Error ? error.message : "Failed to skip job";
      toast.error(message);
    } finally {
      setIsSkipping(false);
    }
  };

  const handleFinalize = async () => {
    if (!job) return;
    try {
      setIsFinalizing(true);
      await api.processJob(job.id);
      trackProductEvent("jobs_job_action_completed", {
        action: "process_job",
        result: "success",
        from_status: job.status,
        to_status: "ready",
      });

      toast.success("Job moved to Ready", {
        description: "Your tailored Word and HTML materials are ready.",
      });

      onJobMoved(job.id);
      await onJobUpdated();
    } catch (error) {
      trackProductEvent("jobs_job_action_completed", {
        action: "process_job",
        result: "error",
        from_status: job.status,
        to_status: "ready",
      });
      const message =
        error instanceof Error ? error.message : "Failed to finalize job";
      toast.error(message);
    } finally {
      setIsFinalizing(false);
    }
  };

  const handleRescore = () => rescoreJob(job?.id);

  if (!job) {
    return <EmptyState />;
  }

  if (job.status === "processing") {
    return <ProcessingState />;
  }

  return (
    <div className="h-full">
      {mode === "decide" ? (
        <DecideMode
          job={job}
          onTailor={() => setMode("tailor")}
          onSkip={handleSkip}
          isSkipping={isSkipping}
          onRescore={handleRescore}
          isRescoring={isRescoring}
          onEditDetails={() => setIsEditDetailsOpen(true)}
          onCheckSponsor={async () => {
            try {
              await api.checkSponsor(job.id);
              trackProductEvent("jobs_job_action_completed", {
                action: "check_sponsor",
                result: "success",
                from_status: job.status,
              });
              await onJobUpdated();
            } catch (error) {
              trackProductEvent("jobs_job_action_completed", {
                action: "check_sponsor",
                result: "error",
                from_status: job.status,
              });
              throw error;
            }
          }}
        />
      ) : (
        <TailorMode
          job={job}
          onBack={() => setMode("decide")}
          onFinalize={handleFinalize}
          isFinalizing={isFinalizing}
          onDirtyChange={onTailoringDirtyChange}
        />
      )}

      <JobDetailsEditDrawer
        open={isEditDetailsOpen}
        onOpenChange={setIsEditDetailsOpen}
        job={job}
        onJobUpdated={onJobUpdated}
      />
    </div>
  );
};

export default DiscoveredPanel;
