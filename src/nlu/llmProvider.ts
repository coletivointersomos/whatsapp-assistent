import { canCallRemoteLlm, type NluRuntimeConfig } from "./config.ts";
import { buildNluUserPayload, NLU_SYSTEM_PROMPT } from "./prompt.ts";
import { validateNluResult } from "./schema.ts";
import { unknownNlu, type NluContext, type NluProvider, type NluResult } from "./types.ts";

type FetchLike = typeof fetch;

export function createLlmProvider(
  config: NluRuntimeConfig,
  fetchImpl: FetchLike = fetch,
): NluProvider {
  return {
    name: "llm",
    async interpret(context: NluContext): Promise<NluResult> {
      if (!canCallRemoteLlm(config)) return unknownNlu("llm_disabled");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
      try {
        const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model || "nlu",
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: NLU_SYSTEM_PROMPT },
              { role: "user", content: buildNluUserPayload(context) },
            ],
          }),
          signal: ctrl.signal,
        });
        if (!response.ok) return unknownNlu("llm_http");
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = body.choices?.[0]?.message?.content;
        return validateNluResult(content ?? "");
      } catch {
        return unknownNlu("llm_failed");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
