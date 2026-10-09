import { buildOpenWaSendUrl } from "./openwaSend.ts";
import type { OpenWaMessageData } from "./types.ts";

export const MAX_MEDIA_BYTES = 3_500_000;
export const DEFAULT_OPENWA_MEDIA_PATH = "/api/sessions/{sessionId}/messages/{chatId}/{messageId}/media";

export type ResolvedMedia = {
  mime: string;
  base64: string;
  source: "webhook" | "openwa";
};

function stripDataUrl(raw: string): { mime: string; base64: string } | undefined {
  const trimmed = raw.trim();
  const match = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  if (match) return { mime: match[1], base64: match[2].replace(/\s/g, "") };
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 80) {
    return { mime: "image/jpeg", base64: trimmed.replace(/\s/g, "") };
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && "data" in value) {
    const nested = (value as { data?: unknown }).data;
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return undefined;
}

export function mediaFromWebhook(data: OpenWaMessageData | undefined, kind?: string): ResolvedMedia | undefined {
  const blob = data?.media?.data;
  if (!blob) return undefined;
  const parsed = stripDataUrl(blob);
  if (!parsed) return undefined;
  const mime = data?.media?.mimetype || parsed.mime || (kind === "image" ? "image/jpeg" : parsed.mime);
  if (!mime.startsWith("image/")) return undefined;
  const bytes = Math.floor((parsed.base64.length * 3) / 4);
  if (bytes > MAX_MEDIA_BYTES) return undefined;
  return { mime, base64: parsed.base64, source: "webhook" };
}

export function imageDataUrl(media: ResolvedMedia): string {
  return `data:${media.mime};base64,${media.base64}`;
}

async function readOkBody(response: Response): Promise<string | undefined> {
  if (!response.ok) return undefined;
  const ctype = response.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    try {
      const json = (await response.json()) as Record<string, unknown>;
      return stringField(json.data) ?? stringField(json.media) ?? stringField(json.base64) ?? stringField(json.body);
    } catch {
      return undefined;
    }
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (!buf.length) return undefined;
  return buf.toString("base64");
}

export function resolveOpenWaMediaUrls(input: {
  baseUrl: string;
  sessionId: string;
  messageId: string;
  chatId?: string;
  mediaPath: string;
}): string[] {
  const sid = encodeURIComponent(input.sessionId);
  const mid = encodeURIComponent(input.messageId);
  const cid = input.chatId ? encodeURIComponent(input.chatId) : "";
  const fill = (tpl: string) => {
    if (tpl.includes("{chatId}") && !cid) return undefined;
    return buildOpenWaSendUrl(
      input.baseUrl,
      tpl.replaceAll("{sessionId}", sid).replaceAll("{chatId}", cid).replaceAll("{messageId}", mid),
      input.sessionId,
    );
  };
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const tpl of [
    input.mediaPath,
    DEFAULT_OPENWA_MEDIA_PATH,
    "/api/sessions/{sessionId}/messages/{messageId}/media",
  ]) {
    const url = fill(tpl);
    if (url && !url.includes("{") && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/** Tenta baixar a imagem no OpenWA sem alterar o container. Caminho configurável. */
export async function fetchOpenWaImage(input: {
  baseUrl: string;
  apiKey: string;
  apiKeyHeader: string;
  sessionId: string;
  messageId: string;
  chatId?: string;
  mediaPath: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedMedia | undefined> {
  if (!input.baseUrl.trim() || !input.messageId) return undefined;
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (input.apiKey) headers[input.apiKeyHeader] = input.apiKey;
  const urls = resolveOpenWaMediaUrls(input);
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { method: "GET", headers });
      const raw = await readOkBody(response);
      if (!raw) continue;
      const parsed = stripDataUrl(raw) ?? { mime: "image/jpeg", base64: raw.replace(/\s/g, "") };
      if (!parsed.base64) continue;
      const bytes = Math.floor((parsed.base64.length * 3) / 4);
      if (bytes > MAX_MEDIA_BYTES) continue;
      return { mime: parsed.mime || "image/jpeg", base64: parsed.base64, source: "openwa" };
    } catch {
      /* tenta o próximo path do OpenWA */
    }
  }
  return undefined;
}
