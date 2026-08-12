import type { DesignResumeDocument, DesignResumeVariant } from "@shared/types";
import { Eye } from "lucide-react";
import { DesignResumeHtmlPreview } from "./DesignResumeHtmlPreview";

type DesignResumePreviewPanelProps = {
  draft: DesignResumeDocument;
  isDirty: boolean;
  saveState: "idle" | "saving" | "saved" | "error";
  variant: DesignResumeVariant;
};

export function DesignResumePreviewPanel({
  draft,
  isDirty,
  saveState,
  variant,
}: DesignResumePreviewPanelProps) {
  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-border/70 bg-muted/20">
      <div className="border-b border-border/70 px-4 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <Eye className="h-4 w-4" />
            Live preview
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            HTML preview matching the generated Word and HTML resume output.
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <DesignResumeHtmlPreview
          draft={draft}
          isDirty={isDirty}
          saveState={saveState}
          variant={variant}
        />
      </div>
    </section>
  );
}
