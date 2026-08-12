import { isCapabilityError } from "../policies/capability-fallback";
import type {
  JsonSchemaDefinition,
  LlmRequestOptions,
  LlmUsage,
  ProviderStrategy,
  ResponseMode,
} from "../types";
import { joinUrl } from "../utils/http";
import { getNestedValue } from "../utils/object";

type ProviderStrategyArgs = Omit<
  ProviderStrategy,
  "isCapabilityError" | "getValidationUrls"
> & {
  getValidationUrls?: ProviderStrategy["getValidationUrls"];
};

export function createProviderStrategy(
  args: ProviderStrategyArgs,
): ProviderStrategy {
  return {
    ...args,
    isCapabilityError: ({ mode, status, body }) =>
      isCapabilityError({ mode, status, body }),
    getValidationUrls:
      args.getValidationUrls ??
      (({ baseUrl }) =>
        args.validationPaths.map((path) => joinUrl(baseUrl, path))),
  };
}

export function buildChatCompletionsBody(args: {
  mode: ResponseMode;
  model: string;
  messages: LlmRequestOptions<unknown>["messages"];
  jsonSchema: JsonSchemaDefinition;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: false,
    temperature: 0,
    ...(args.extra ?? {}),
  };

  if (args.mode === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: args.jsonSchema.name,
        strict: true,
        schema: args.jsonSchema.schema,
      },
    };
  } else if (args.mode === "json_object") {
    body.response_format = { type: "json_object" };
  } else if (args.mode === "text") {
    body.response_format = { type: "text" };
  }

  return body;
}

export function extractChatCompletionsText(response: unknown): string | null {
  const content = getNestedValue(response, [
    "choices",
    0,
    "message",
    "content",
  ]);
  return typeof content === "string" ? content : null;
}

export function extractChatCompletionsUsage(
  response: unknown,
): LlmUsage | undefined {
  const usage = getNestedValue(response, ["usage"]);
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const promptTokens = numberValue(record.prompt_tokens);
  const completionTokens = numberValue(record.completion_tokens);
  const totalTokens = numberValue(record.total_tokens);
  const promptCacheHitTokens = numberValue(record.prompt_cache_hit_tokens);
  const promptCacheMissTokens = numberValue(record.prompt_cache_miss_tokens);
  const completionDetails = record.completion_tokens_details;
  const reasoningTokens =
    completionDetails && typeof completionDetails === "object"
      ? numberValue(
          (completionDetails as Record<string, unknown>).reasoning_tokens,
        )
      : undefined;

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    promptCacheHitTokens === undefined &&
    promptCacheMissTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    reasoningTokens,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
