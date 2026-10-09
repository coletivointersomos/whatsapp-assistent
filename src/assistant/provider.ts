import { canCallRemoteLlm, type NluRuntimeConfig } from "../nlu/config.ts";
import {
  extractChatMessageContent,
  maskHttpSnippet,
  resolveChatCompletionsUrl,
  urlHostPath,
} from "../nlu/llmHttp.ts";
import type { LlmHttpInfo, LlmProviderHooks } from "../nlu/llmProvider.ts";
import { ASSISTANT_SYSTEM_PROMPT, buildAssistantUserPayload } from "./prompt.ts";
import { parseAssistantResponse } from "./schema.ts";
import { emptyAssistant, type AssistantContext, type AssistantProvider } from "./types.ts";

type FetchLike = typeof fetch;

function completionBody(config: NluRuntimeConfig, context: AssistantContext, withFormat: boolean) {
  const payload: Record<string, unknown> = {
    model: config.model || "assistant",
    temperature: 0.3,
    max_tokens: Math.min(1024, Math.max(config.maxTokens, 640)),
    messages: [
      { role: "system", content: ASSISTANT_SYSTEM_PROMPT },
      { role: "user", content: buildAssistantUserPayload(context) },
    ],
  };
  if (withFormat && config.jsonResponseFormat) {
    payload.response_format = { type: "json_object" };
  }
  return payload;
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseBodyJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function createAssistantProvider(
  config: NluRuntimeConfig,
  fetchImpl: FetchLike = fetch,
  hooks: LlmProviderHooks = {},
): AssistantProvider {
  return {
    name: "assistant-llm",
    async interpret(context: AssistantContext) {
      if (!canCallRemoteLlm(config)) return emptyAssistant("llm_disabled");
      const url = resolveChatCompletionsUrl(config.baseUrl);
      if (!url) return emptyAssistant("llm_failed");
      const { host, path } = urlHostPath(url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
      const post = async (withFormat: boolean) => {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(completionBody(config, context, withFormat)),
          signal: ctrl.signal,
        });
        const raw = await readBody(response);
        const info: LlmHttpInfo = {
          status: response.status,
          ok: response.ok,
          statusText: response.statusText,
          host,
          path,
          bodyPreview: maskHttpSnippet(config.apiKey ? raw.split(config.apiKey).join("[key]") : raw),
          usedResponseFormat: withFormat && config.jsonResponseFormat,
        };
        hooks.onHttp?.(info);
        return { response, raw, withFormat };
      };
      try {
        let { response, raw, withFormat } = await post(true);
        if (
          !response.ok &&
          response.status === 400 &&
          withFormat &&
          config.jsonResponseFormat &&
          /response_format/i.test(raw)
        ) {
          ({ response, raw, withFormat } = await post(false));
        }
        if (!response.ok) return emptyAssistant(`llm_http:${response.status}`);
        const parsed = parseBodyJson(raw);
        const content = extractChatMessageContent(parsed);
        if (content === undefined) return emptyAssistant("llm_empty_content");
        return parseAssistantResponse(content);
      } catch {
        return emptyAssistant("llm_failed");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
