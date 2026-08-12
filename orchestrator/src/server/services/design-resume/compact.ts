import type {
  DesignResumeDocument,
  DesignResumeJson,
  DesignResumeVariant,
} from "@shared/types";
import { badRequest } from "@infra/errors";

type CompactTargetPages = 1 | 2;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compactMetadata(
  metadata: unknown,
  targetPages: CompactTargetPages,
): Record<string, unknown> {
  const next = structuredClone(asRecord(metadata) ?? {});
  const page = asRecord(next.page) ?? {};
  next.page = {
    ...page,
    gapX: Math.min(Number(page.gapX) || 4, targetPages === 1 ? 2 : 3),
    gapY: Math.min(Number(page.gapY) || 4, targetPages === 1 ? 2 : 3),
    marginX: Math.min(Number(page.marginX) || 12, targetPages === 1 ? 8 : 10),
    marginY: Math.min(Number(page.marginY) || 12, targetPages === 1 ? 7 : 9),
  };

  const typography = asRecord(next.typography) ?? {};
  const body = asRecord(typography.body) ?? {};
  const heading = asRecord(typography.heading) ?? {};
  next.typography = {
    ...typography,
    body: {
      ...body,
      fontSize: Math.min(Number(body.fontSize) || 10, targetPages === 1 ? 9 : 10),
      lineHeight: Math.min(
        Number(body.lineHeight) || 1.35,
        targetPages === 1 ? 1.15 : 1.25,
      ),
    },
    heading: {
      ...heading,
      fontSize: Math.min(
        Number(heading.fontSize) || 12,
        targetPages === 1 ? 11 : 12,
      ),
      lineHeight: Math.min(Number(heading.lineHeight) || 1.3, 1.2),
    },
  };

  return next;
}

export function compactDesignResumeJson(
  resumeJson: DesignResumeJson | Record<string, unknown>,
  targetPages: CompactTargetPages,
): DesignResumeJson {
  const next = structuredClone(resumeJson) as Record<string, unknown>;
  // Page compaction is intentionally layout-only. Do not truncate summary,
  // remove projects, limit bullets, hide sections, or rewrite user content here.
  next.metadata = compactMetadata(next.metadata, targetPages);
  return next as DesignResumeJson;
}

export async function generateCompactDesignResumeMaster(input: {
  targetPages: CompactTargetPages;
  variant?: DesignResumeVariant;
}): Promise<DesignResumeDocument> {
  const { getCurrentDesignResume, replaceCurrentDesignResumeDocument } =
    await import(".");
  const variant: DesignResumeVariant =
    input.variant ?? (input.targetPages === 1 ? "one_page" : "two_page");
  const sourceVariant: DesignResumeVariant =
    input.targetPages === 1 ? "two_page" : variant;
  const source = await getCurrentDesignResume(sourceVariant);
  if (!source?.resumeJson) {
    throw badRequest(
      input.targetPages === 1
        ? "Import a 2-page master before generating a compact 1-page master."
        : "Import a 2-page master before compacting it.",
    );
  }

  return replaceCurrentDesignResumeDocument({
    resumeJson: compactDesignResumeJson(source.resumeJson, input.targetPages),
    sourceResumeId: null,
    sourceMode: null,
    importedAt: new Date().toISOString(),
    variant,
  });
}
