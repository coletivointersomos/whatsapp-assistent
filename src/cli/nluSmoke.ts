import { loadNluConfig } from "../nlu/config.ts";
import { maskHttpSnippet, resolveChatCompletionsUrl, urlHostPath } from "../nlu/llmHttp.ts";

const SMOKE_USER =
  'Return exactly {"intent":"smalltalk","confidence":0.9,"action":"reply","reply":"ok"}';

function parseMaybeJson(raw: string): { parsed: boolean; value?: Record<string, unknown> } {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return { parsed: false };
  try {
    const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { parsed: false };
    return { parsed: true, value: value as Record<string, unknown> };
  } catch {
    return { parsed: false };
  }
}

function contentFromChat(body: Record<string, unknown> | undefined): string {
  const choices = body?.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) return JSON.stringify(content);
  return "";
}

async function main() {
  const config = loadNluConfig(process.env);
  if (!config.enabled || config.provider !== "llm" || !config.apiKey || !config.baseUrl) {
    console.log("skip=true");
    console.log("reason=llm_not_configured");
    console.log("enabled", config.enabled);
    console.log("provider", config.provider);
    console.log("has_key", Boolean(config.apiKey.trim()));
    console.log("has_url", Boolean(config.baseUrl));
    process.exitCode = 0;
    return;
  }

  const url = resolveChatCompletionsUrl(config.baseUrl);
  const { host, path } = urlHostPath(url);
  console.log("host", host);
  console.log("path", path);
  console.log("model_set", Boolean(config.model));
  console.log("max_tokens", config.maxTokens);
  console.log("json_object", config.jsonResponseFormat);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || "nlu",
      temperature: 0,
      max_tokens: config.maxTokens,
      ...(config.jsonResponseFormat ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: "Reply with JSON only. No markdown." },
        { role: "user", content: SMOKE_USER },
      ],
    }),
  });
  const raw = await response.text();
  const safeRaw = config.apiKey ? raw.split(config.apiKey).join("[key]") : raw;
  console.log("http_status", response.status);
  console.log("http_ok", response.ok);
  const chat = parseMaybeJson(raw);
  const inner = parseMaybeJson(contentFromChat(chat.value) || raw);
  console.log("parsed_json", inner.parsed);
  if (inner.value) {
    console.log("intent", inner.value.intent ?? "");
    console.log("action", inner.value.action ?? "");
    console.log("confidence", inner.value.confidence ?? "");
  }
  if (!response.ok) {
    console.log("body_preview", maskHttpSnippet(safeRaw));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.log("http_status", 0);
  console.log("parsed_json", false);
  console.log("error", error instanceof Error ? error.name : "unknown");
  process.exitCode = 1;
});
