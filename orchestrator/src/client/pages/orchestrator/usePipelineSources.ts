import type { JobSource } from "@shared/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_PIPELINE_SOURCES,
  orderedSources,
  PIPELINE_SOURCES_STORAGE_KEY,
} from "./constants";

const PIPELINE_SOURCES_DEFAULTS_VERSION = "policyjobs-ottawa-v2";
const PIPELINE_SOURCES_DEFAULTS_VERSION_STORAGE_KEY = `${PIPELINE_SOURCES_STORAGE_KEY}.defaultsVersion`;
const LEGACY_DEFAULT_PIPELINE_SOURCES: JobSource[] = [
  "ontario-public-sector",
  "indeed",
  "linkedin",
  "hiringcafe",
];
const TEMPORARY_PUBLIC_SECTOR_ONLY_SOURCES: JobSource[] = [
  "ontario-public-sector",
  "policyjobs-ottawa",
];

const resolveAllowedSources = (enabledSources?: readonly JobSource[]) =>
  enabledSources && enabledSources.length > 0
    ? (enabledSources as JobSource[])
    : DEFAULT_PIPELINE_SOURCES;

const normalizeSources = (
  sources: JobSource[],
  allowedSources: JobSource[],
) => {
  const filtered = sources.filter((value) => allowedSources.includes(value));
  return filtered.length > 0 ? filtered : allowedSources.slice(0, 1);
};

const sourcesMatch = (left: JobSource[], right: JobSource[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const migrateStoredDefaultSources = (
  sources: JobSource[],
  allowedSources: JobSource[],
  storedDefaultsVersion: string | null,
) => {
  const normalized = normalizeSources(sources, allowedSources);
  if (storedDefaultsVersion === PIPELINE_SOURCES_DEFAULTS_VERSION) {
    return normalized;
  }

  const canMigrateLegacyDefaults = LEGACY_DEFAULT_PIPELINE_SOURCES.every(
    (source) => allowedSources.includes(source),
  );
  if (
    canMigrateLegacyDefaults &&
    sourcesMatch(normalized, LEGACY_DEFAULT_PIPELINE_SOURCES)
  ) {
    return normalizeSources(DEFAULT_PIPELINE_SOURCES, allowedSources);
  }

  const canMigrateTemporaryPublicSectorOnly =
    TEMPORARY_PUBLIC_SECTOR_ONLY_SOURCES.every((source) =>
      allowedSources.includes(source),
    );
  if (
    canMigrateTemporaryPublicSectorOnly &&
    sourcesMatch(normalized, TEMPORARY_PUBLIC_SECTOR_ONLY_SOURCES)
  ) {
    return normalizeSources(DEFAULT_PIPELINE_SOURCES, allowedSources);
  }

  return normalized;
};

export const usePipelineSources = (enabledSources?: readonly JobSource[]) => {
  const allowedSources = useMemo(
    () => resolveAllowedSources(enabledSources),
    [enabledSources],
  );
  const [pipelineSources, setPipelineSources] = useState<JobSource[]>(() => {
    try {
      const raw = localStorage.getItem(PIPELINE_SOURCES_STORAGE_KEY);
      const defaultsVersion = localStorage.getItem(
        PIPELINE_SOURCES_DEFAULTS_VERSION_STORAGE_KEY,
      );
      if (!raw) return normalizeSources(allowedSources, allowedSources);
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed))
        return normalizeSources(allowedSources, allowedSources);
      const next = parsed.filter((value): value is JobSource =>
        orderedSources.includes(value as JobSource),
      );
      return migrateStoredDefaultSources(next, allowedSources, defaultsVersion);
    } catch {
      return normalizeSources(allowedSources, allowedSources);
    }
  });

  useEffect(() => {
    setPipelineSources((current) => {
      const normalized = normalizeSources(current, allowedSources);
      return sourcesMatch(current, normalized) ? current : normalized;
    });
  }, [allowedSources]);

  useEffect(() => {
    try {
      localStorage.setItem(
        PIPELINE_SOURCES_STORAGE_KEY,
        JSON.stringify(pipelineSources),
      );
      localStorage.setItem(
        PIPELINE_SOURCES_DEFAULTS_VERSION_STORAGE_KEY,
        PIPELINE_SOURCES_DEFAULTS_VERSION,
      );
    } catch {
      // Ignore localStorage errors
    }
  }, [pipelineSources]);

  const toggleSource = useCallback(
    (source: JobSource, checked: boolean) => {
      if (!allowedSources.includes(source)) return;
      setPipelineSources((current) => {
        const next = checked
          ? Array.from(new Set([...current, source]))
          : current.filter((value) => value !== source);

        return next.length === 0 ? current : next;
      });
    },
    [allowedSources],
  );

  return { pipelineSources, setPipelineSources, toggleSource };
};
