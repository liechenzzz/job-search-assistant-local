import { buildHeaders, joinUrl } from "../utils/http";
import {
  buildChatCompletionsBody,
  createProviderStrategy,
  extractChatCompletionsText,
  extractChatCompletionsUsage,
} from "./factory";

export const deepSeekStrategy = createProviderStrategy({
  provider: "deepseek",
  defaultBaseUrl: "https://api.deepseek.com",
  requiresApiKey: true,
  modes: ["json_object", "none"],
  validationPaths: ["/v1/models"],
  buildRequest: ({ mode, baseUrl, apiKey, model, messages, jsonSchema }) => {
    return {
      url: joinUrl(baseUrl, "/v1/chat/completions"),
      headers: buildHeaders({ apiKey, provider: "deepseek" }),
      body: buildChatCompletionsBody({
        mode,
        model,
        messages,
        jsonSchema,
        extra: { thinking: { type: "disabled" } },
      }),
    };
  },
  extractText: extractChatCompletionsText,
  extractUsage: extractChatCompletionsUsage,
});
