import type { LlmProvider, LlmUsage } from "./types";

type TokenPrice = {
  cacheHitInputPerMillion: number;
  cacheMissInputPerMillion: number;
  outputPerMillion: number;
};

const DEEPSEEK_V4_PRICES: Record<string, TokenPrice> = {
  "deepseek-v4-pro": {
    cacheHitInputPerMillion: 0.003625,
    cacheMissInputPerMillion: 0.435,
    outputPerMillion: 0.87,
  },
  "deepseek-v4-flash": {
    cacheHitInputPerMillion: 0.0028,
    cacheMissInputPerMillion: 0.14,
    outputPerMillion: 0.28,
  },
};

export function estimateLlmCostUsd(args: {
  provider: LlmProvider | string;
  model: string;
  usage?: LlmUsage;
}): number | undefined {
  if (!args.usage) return undefined;
  const normalizedModel = args.model.trim().toLowerCase();
  if (args.provider !== "deepseek") return undefined;
  const price = DEEPSEEK_V4_PRICES[normalizedModel];
  if (!price) return undefined;

  const promptTokens = args.usage.promptTokens ?? 0;
  const cacheHitTokens = args.usage.promptCacheHitTokens ?? 0;
  const cacheMissTokens =
    args.usage.promptCacheMissTokens ??
    Math.max(0, promptTokens - cacheHitTokens);
  const completionTokens = args.usage.completionTokens ?? 0;

  return (
    (cacheHitTokens / 1_000_000) * price.cacheHitInputPerMillion +
    (cacheMissTokens / 1_000_000) * price.cacheMissInputPerMillion +
    (completionTokens / 1_000_000) * price.outputPerMillion
  );
}
