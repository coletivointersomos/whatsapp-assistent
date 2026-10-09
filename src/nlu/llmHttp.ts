export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function urlHostPath(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, path: parsed.pathname };
  } catch {
    return { host: "invalid", path: "" };
  }
}

export function maskHttpSnippet(text: string, max = 500): string {
  return text
    .replace(/sk-[a-zA-Z0-9._-]+/g, "[key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [key]")
    .replace(/https?:\/\/[^\s"'\\]+/gi, "[url]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[id]")
    .replace(/\d{10,}@(?:g\.us|lid|c\.us|s\.whatsapp\.net)/gi, "…jid")
    .slice(0, max);
}

export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) return fenced[1].trim();
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function textFromContentParts(content: unknown): string | undefined {
  if (typeof content === "string") return stripCodeFence(content);
  if (!Array.isArray(content)) return undefined;
  const parts = content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part) {
      return String((part as { text?: unknown }).text ?? "");
    }
    return "";
  });
  return stripCodeFence(parts.join(""));
}

export function extractChatMessageContent(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const rec = body as Record<string, unknown>;
  const choices = rec.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const message = (choices[0] as Record<string, unknown>).message;
    if (message && typeof message === "object") {
      const recMsg = message as Record<string, unknown>;
      const content = recMsg.content;
      if (content && typeof content === "object" && !Array.isArray(content)) return content;
      const text = textFromContentParts(content);
      if (text) return text;
      const reasoning = textFromContentParts(recMsg.reasoning_content);
      if (reasoning) return reasoning;
    }
  }
  if (typeof rec.content === "string") return stripCodeFence(rec.content);
  return undefined;
}
