import * as api from "@client/api";
import type { DesignResumeDocument, DesignResumeVariant } from "@shared/types";
import { FileText, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type DesignResumeHtmlPreviewProps = {
  draft: DesignResumeDocument;
  isDirty: boolean;
  saveState: "idle" | "saving" | "saved" | "error";
  variant: DesignResumeVariant;
};

type PreviewState = "idle" | "waiting-for-save" | "loading" | "ready" | "error";

export function DesignResumeHtmlPreview({
  draft,
  isDirty,
  saveState,
  variant,
}: DesignResumeHtmlPreviewProps) {
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>("idle");
  const [isFrameLoading, setIsFrameLoading] = useState(false);
  const lastLoadedKey = useRef<string | null>(null);

  const revisionKey = useMemo(
    () => `${draft.id}:${draft.revision}:${variant}`,
    [draft.id, draft.revision, variant],
  );

  useEffect(() => {
    if (saveState === "error") {
      setIsFrameLoading(false);
      setPreviewState("error");
      return;
    }

    if (isDirty || saveState === "saving") {
      setPreviewState("waiting-for-save");
      setIsFrameLoading(false);
      return;
    }

    if (lastLoadedKey.current === revisionKey) {
      return;
    }

    lastLoadedKey.current = revisionKey;
    setPreviewState("loading");
    setIsFrameLoading(true);
    setPreviewHtml(null);

    let cancelled = false;
    api
      .getDesignResumeHtmlPreview(variant, draft.revision)
      .then((html) => {
        if (cancelled) return;
        setPreviewHtml(html);
        // Mark ready immediately — no iframe onLoad to wait for
        setIsFrameLoading(false);
        setPreviewState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        if (lastLoadedKey.current === revisionKey) {
          lastLoadedKey.current = null;
        }
        setIsFrameLoading(false);
        setPreviewState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [draft.revision, isDirty, revisionKey, saveState, variant]);

  const showLoader =
    previewState === "loading" ||
    previewState === "waiting-for-save" ||
    isFrameLoading;

  // Strip <html>, <head>, <body> tags so we only embed the resume article
  // and its styles. The styles are scoped by stripping body/html selectors.
  const embedContent = useMemo(() => {
    if (!previewHtml) return null;
    // Extract everything inside <body>...</body>
    const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(previewHtml);
    const bodyContent = bodyMatch ? bodyMatch[1] : previewHtml;
    // Extract <style>...</style>
    const styleMatch = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(previewHtml);
    const styles = styleMatch ? styleMatch[1] : "";
    // Scope body/html styles to a wrapper class, keep the rest
    const scopedStyles = styles
      .replace(/body\s*\{/g, ".resume-preview-wrapper {")
      .replace(/html,\s*body\s*\{/g, ".resume-preview-wrapper {")
      .replace(/html\s*\{/g, ".resume-preview-wrapper {")
      .replace(/@page\s*\{[^}]*\}/g, "")
      .replace(/@media print\s*\{[^}]*\}/g, "");
    return { __html: `<style>${scopedStyles}</style>${bodyContent}` };
  }, [previewHtml]);

  return (
    <div className="relative flex h-full min-h-0 items-start justify-center overflow-y-auto bg-muted/10 p-6 xl:p-8">
      <div className="relative w-full border border-border/70 bg-white shadow-[0_24px_80px_rgba(0,0,0,0.24)]">
        <div
          key={revisionKey}
          className="resume-preview-wrapper w-full bg-white"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: The server renderer escapes resume data; preserving its generated markup and scoped styles is required for the preview.
          dangerouslySetInnerHTML={embedContent || undefined}
        />

        {showLoader ? (
          <div className="absolute inset-0 grid place-items-center bg-background/70 backdrop-blur-[2px]">
            <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-border/70 bg-background/95 px-6 py-5 text-center shadow-lg">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">
                {previewState === "waiting-for-save"
                  ? "Saving changes before updating the preview"
                  : "Loading HTML preview"}
              </div>
            </div>
          </div>
        ) : null}

        {previewState === "error" ? (
          <div className="absolute inset-0 grid place-items-center bg-background/80">
            <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-6 py-5 text-center">
              <FileText className="h-6 w-6 text-rose-300" />
              <div className="text-sm font-medium text-rose-200">
                Preview unavailable
              </div>
              <div className="text-xs leading-6 text-rose-200/80">
                The HTML preview could not be loaded. Refresh or sign in again.
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
