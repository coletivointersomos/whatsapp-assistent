import { canCallRemoteLlm, type NluRuntimeConfig } from "./config.ts";
import {
  extractChatMessageContent,
  maskHttpSnippet,
  resolveChatCompletionsUrl,
  urlHostPath,
} from "./llmHttp.ts";
import { buildNluUserPayload, NLU_SYSTEM_PROMPT } from "./prompt.ts";
import { validateNluResult } from "./schema.ts";
import { unknownNlu, type NluContext, type NluProvider, type NluResult } from "./types.ts";

type FetchLike = typeof fetch;

export type LlmHttpInfo = {
  status: number;
  ok: boolean;
  statusText: string;
  host: string;
  path: string;
  bodyPreview: string;
  usedResponseFormat: boolean;
};

export type LlmProviderHooks = {
  onHttp?: (info: LlmHttpInfo) => void;
};

function completionBody(config: NluRuntimeConfig, context: NluContext, withFormat: boolean) {
  const payload: Record<string, unknown> = {
    model: config.model || "nlu",
    temperature: 0,
    max_tokens: config.maxTokens,
    messages: [
      { role: "system", content: NLU_SYSTEM_PROMPT },
      { role: "user", content: buildNluUserPayload(context) },
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

export function createLlmProvider(
  config: NluRuntimeConfig,
  fetchImpl: FetchLike = fetch,
  hooks: LlmProviderHooks = {},
): NluProvider {
  return {
    name: "llm",
    async interpret(context: NluContext): Promise<NluResult> {
      if (!canCallRemoteLlm(config)) return unknownNlu("llm_disabled");
      const url = resolveChatCompletionsUrl(config.baseUrl);
      if (!url) return unknownNlu("llm_failed");
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
        hooks.onHttp?.({
          status: response.status,
          ok: response.ok,
          statusText: response.statusText,
          host,
          path,
          bodyPreview: maskHttpSnippet(config.apiKey ? raw.split(config.apiKey).join("[key]") : raw),
          usedResponseFormat: withFormat && config.jsonResponseFormat,
        });
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
        if (!response.ok) return unknownNlu(`llm_http:${response.status}`);
        const parsed = parseBodyJson(raw);
        const content = extractChatMessageContent(parsed);
        if (content === undefined) return unknownNlu("llm_empty_content");
        return validateNluResult(content);
      } catch {
        return unknownNlu("llm_failed");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
