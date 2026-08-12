import type { JobListItem } from "@shared/types.js";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface JobRowContentProps {
  job: JobListItem;
  isSelected?: boolean;
  className?: string;
}

function getSuitabilityScoreTone(score: number): string {
  if (score >= 70) return "text-emerald-400/90";
  if (score >= 50) return "text-foreground/60";
  return "text-muted-foreground/60";
}

function getAlignmentScore(raw: string | null | undefined): {
  score: number;
  status: string;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.score === "number" &&
      typeof parsed.status === "string"
    ) {
      return {
        score: Math.max(0, Math.min(100, Math.round(parsed.score))),
        status: parsed.status,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

const alignmentLabel = (status: string): string => {
  switch (status) {
    case "pass":
      return "Strong match";
    case "warning":
      return "Partial match";
    case "failed":
      return "Weak match";
    default:
      return status;
  }
};

export const JobRowContent = ({
  job,
  isSelected = false,
  className,
}: JobRowContentProps) => {
  const hasScore = job.suitabilityScore != null;
  const suitabilityTone = getSuitabilityScoreTone(job.suitabilityScore ?? 0);
  const alignment = getAlignmentScore(job.resumeAlignmentReport);

  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-3", className)}>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-sm leading-tight",
            isSelected ? "font-semibold" : "font-medium",
          )}
        >
          {job.title}
        </div>
        <div className="truncate text-xs text-muted-foreground mt-0.5">
          {job.employer}
          {job.location && (
            <span className="before:content-['_in_']">{job.location}</span>
          )}
        </div>
        {job.salary?.trim() && (
          <div className="truncate text-xs text-muted-foreground mt-0.5">
            {job.salary}
          </div>
        )}
      </div>

      {(hasScore || alignment) && (
        <TooltipProvider delayDuration={0}>
          {hasScore && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="shrink-0 cursor-default text-right">
                  <span className="text-[10px] text-muted-foreground/50">Fit </span>
                  <span className={cn("text-xs tabular-nums", suitabilityTone)}>
                    {job.suitabilityScore}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">Job fit score — higher is better</p>
              </TooltipContent>
            </Tooltip>
          )}
          {alignment && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="shrink-0 cursor-default text-right">
                  <span className="text-[10px] text-muted-foreground/50">Match </span>
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      alignment.status === "pass"
                        ? "text-emerald-400/90"
                        : alignment.status === "warning"
                          ? "text-amber-400/90"
                          : "text-rose-400/90",
                    )}
                  >
                    {alignment.score}%
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">
                  Resume-JD match — {alignmentLabel(alignment.status)} · {alignment.score}%
                </p>
              </TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
      )}
    </div>
  );
};
