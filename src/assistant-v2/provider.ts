import { canCallRemoteLlm, type NluRuntimeConfig } from "../nlu/config.ts";
import {
  extractChatMessageContent,
  maskHttpSnippet,
  resolveChatCompletionsUrl,
  urlHostPath,
} from "../nlu/llmHttp.ts";
import type { LlmHttpInfo, LlmProviderHooks } from "../nlu/llmProvider.ts";
import { ASSISTANT_V2_SYSTEM_PROMPT, buildAssistantV2UserPayload } from "./prompt.ts";
import { parseAssistantV2Response } from "./schema.ts";
import { emptyAssistantV2, type AssistantV2Context, type AssistantV2Provider } from "./types.ts";

type FetchLike = typeof fetch;

export function buildAssistantV2Messages(
  context: AssistantV2Context,
  withImage: boolean,
): Array<{ role: string; content: unknown }> {
  const { imageDataUrl, ...rest } = context;
  const text = buildAssistantV2UserPayload(rest);
  if (withImage && imageDataUrl) {
    return [
      { role: "system", content: ASSISTANT_V2_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ];
  }
  return [
    { role: "system", content: ASSISTANT_V2_SYSTEM_PROMPT },
    { role: "user", content: text },
  ];
}

function completionBody(
  config: NluRuntimeConfig,
  context: AssistantV2Context,
  withFormat: boolean,
  thinkingOff: boolean,
  withImage: boolean,
) {
  const model =
    withImage && (config.visionModel || config.model)
      ? config.visionModel || config.model
      : config.model || "assistant-v2";
  const payload: Record<string, unknown> = {
    model,
    temperature: 0.2,
    max_tokens: Math.min(4096, Math.max(config.maxTokens, 2048)),
    messages: buildAssistantV2Messages(context, withImage),
  };
  if (thinkingOff) {
    payload.enable_thinking = false;
    payload.chat_template_kwargs = { enable_thinking: false };
  }
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

export function createAssistantV2Provider(
  config: NluRuntimeConfig,
  fetchImpl: FetchLike = fetch,
  hooks: LlmProviderHooks = {},
): AssistantV2Provider {
  return {
    name: "assistant-v2-llm",
    async interpret(context: AssistantV2Context) {
      if (!canCallRemoteLlm(config)) return emptyAssistantV2("llm_disabled");
      const url = resolveChatCompletionsUrl(config.baseUrl);
      if (!url) return emptyAssistantV2("llm_failed");
      const { host, path } = urlHostPath(url);
      const wantImage = Boolean(config.visionEnabled && context.imageDataUrl);
      const timeoutMs = wantImage ? Math.max(config.timeoutMs, 45_000) : config.timeoutMs;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const post = async (withFormat: boolean, thinkingOff: boolean, withImage: boolean) => {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(completionBody(config, context, withFormat, thinkingOff, withImage)),
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
          vision: withImage,
        };
        hooks.onHttp?.(info);
        return { response, raw, withFormat };
      };
      try {
        let { response, raw, withFormat } = await post(true, true, wantImage);
        if (!response.ok && response.status === 400 && /enable_thinking|chat_template/i.test(raw)) {
          ({ response, raw, withFormat } = await post(true, false, wantImage));
        }
        if (!response.ok && response.status === 400 && wantImage) {
          ({ response, raw, withFormat } = await post(true, false, false));
        }
        if (
          !response.ok &&
          response.status === 400 &&
          withFormat &&
          config.jsonResponseFormat &&
          /response_format/i.test(raw)
        ) {
          ({ response, raw, withFormat } = await post(false, false, wantImage && Boolean(context.imageDataUrl)));
        }
        if (!response.ok) return emptyAssistantV2(`llm_http:${response.status}`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          parsed = undefined;
        }
        const content = extractChatMessageContent(parsed);
        if (content === undefined) return emptyAssistantV2("llm_empty_content");
        return parseAssistantV2Response(content);
      } catch (error) {
        const aborted = error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
        hooks.onHttp?.({
          status: 0,
          ok: false,
          statusText: aborted ? "abort" : "error",
          host,
          path,
          bodyPreview: aborted ? "timeout" : error instanceof Error ? error.name.slice(0, 40) : "llm_failed",
          usedResponseFormat: true,
        });
        return emptyAssistantV2(aborted ? "llm_timeout" : "llm_failed");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
