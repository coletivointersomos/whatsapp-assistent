import { buildOpenWaSendUrl } from "./openwaSend.ts";
import type { OpenWaMessageData } from "./types.ts";

export const MAX_MEDIA_BYTES = 3_500_000;
/** PDF baixado (o que vai ao vision é a página rasterizada, que respeita MAX_MEDIA_BYTES). */
export const MAX_PDF_BYTES = 8 * 1024 * 1024;

/** Tipo pelo início do base64 quando o OpenWA não manda data URL. */
export function sniffBase64Mime(base64: string): string | undefined {
  if (base64.startsWith("JVBERi")) return "application/pdf";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  return undefined;
}

function mediaLimit(mime: string): number {
  return mime.toLowerCase().startsWith("application/pdf") ? MAX_PDF_BYTES : MAX_MEDIA_BYTES;
}
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
    const base64 = trimmed.replace(/\s/g, "");
    return { mime: sniffBase64Mime(base64) ?? "image/jpeg", base64 };
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

export function isVisionImage(mime: string | undefined): boolean {
  return (mime ?? "").startsWith("image/");
}

export function isPlainTextMime(mime: string | undefined): boolean {
  const m = (mime ?? "").toLowerCase();
  return m.startsWith("text/") || m === "application/json";
}

export function isAcceptedDocumentMime(mime: string | undefined): boolean {
  const m = (mime ?? "").toLowerCase();
  return isVisionImage(m) || isPlainTextMime(m) || m === "application/pdf";
}

export function decodePlainText(base64: string): string {
  try {
    return Buffer.from(base64.replace(/\s/g, ""), "base64").toString("utf8").slice(0, 80_000);
  } catch {
    return "";
  }
}

export function mediaFromWebhook(data: OpenWaMessageData | undefined, kind?: string): ResolvedMedia | undefined {
  const blob = data?.media?.data;
  if (!blob) return undefined;
  const parsed = stripDataUrl(blob);
  if (!parsed) return undefined;
  const mime = data?.media?.mimetype || parsed.mime || (kind === "image" ? "image/jpeg" : parsed.mime);
  if (!isAcceptedDocumentMime(mime)) return undefined;
  const bytes = Math.floor((parsed.base64.length * 3) / 4);
  if (bytes > mediaLimit(mime)) return undefined;
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
      const parsed = stripDataUrl(raw) ?? { mime: sniffBase64Mime(raw.replace(/\s/g, "")) ?? "image/jpeg", base64: raw.replace(/\s/g, "") };
      if (!parsed.base64) continue;
      const mime = parsed.mime || "image/jpeg";
      const bytes = Math.floor((parsed.base64.length * 3) / 4);
      if (bytes > mediaLimit(mime)) continue;
      if (!isAcceptedDocumentMime(mime)) continue;
      return { mime, base64: parsed.base64, source: "openwa" };
    } catch {
      /* tenta o próximo path do OpenWA */
    }
  }
  return undefined;
}

/** Limite de áudio baixado do OpenWA (o ASR aceita até ~10 MiB). */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export type AudioFetchResult =
  | { ok: true; media: { mime: string; base64: string; bytes: number } }
  | { ok: false; reason: "media_unavailable" | "media_too_large" | "media_not_audio"; bytes?: number };

function audioMime(value: string | null | undefined): string | undefined {
  const base = (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("audio/")) return base;
  if (base === "application/ogg" || base === "video/ogg") return "audio/ogg";
  return undefined;
}

/** Baixa o áudio da mensagem no OpenWA (só GET), com limite de 8 MiB. */
export async function fetchOpenWaAudio(input: {
  baseUrl: string;
  apiKey: string;
  apiKeyHeader: string;
  sessionId: string;
  messageId: string;
  chatId?: string;
  mediaPath: string;
  fetchImpl?: typeof fetch;
}): Promise<AudioFetchResult> {
  if (!input.baseUrl.trim() || !input.messageId) return { ok: false, reason: "media_unavailable" };
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (input.apiKey) headers[input.apiKeyHeader] = input.apiKey;
  let notAudio = false;
  for (const url of resolveOpenWaMediaUrls(input)) {
    try {
      const response = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) continue;
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES * 1.4) return { ok: false, reason: "media_too_large", bytes: declared };
      const ctype = response.headers.get("content-type") ?? "";
      let base64: string | undefined;
      let mime = audioMime(ctype);
      if (ctype.includes("application/json")) {
        const json = (await response.json()) as Record<string, unknown>;
        const raw = stringField(json.data) ?? stringField(json.media) ?? stringField(json.base64) ?? stringField(json.body);
        if (!raw) continue;
        const match = raw.trim().match(/^data:([^;,]+)[^,]*;base64,(.+)$/is);
        base64 = (match ? match[2] : raw).replace(/\s/g, "");
        const nested = json.media && typeof json.media === "object" ? (json.media as { mimetype?: unknown }).mimetype : undefined;
        mime = audioMime(match?.[1]) ?? audioMime(typeof json.mimetype === "string" ? json.mimetype : undefined) ?? audioMime(typeof nested === "string" ? nested : undefined);
      } else {
        const buf = Buffer.from(await response.arrayBuffer());
        if (!buf.length) continue;
        if (buf.length > MAX_AUDIO_BYTES) return { ok: false, reason: "media_too_large", bytes: buf.length };
        base64 = buf.toString("base64");
        if (!mime && buf.subarray(0, 4).toString("latin1") === "OggS") mime = "audio/ogg";
      }
      if (!base64) continue;
      const bytes = Math.floor((base64.length * 3) / 4);
      if (bytes > MAX_AUDIO_BYTES) return { ok: false, reason: "media_too_large", bytes };
      if (!mime) {
        notAudio = true;
        continue;
      }
      return { ok: true, media: { mime, base64, bytes } };
    } catch {
      /* tenta o próximo path do OpenWA */
    }
  }
  return { ok: false, reason: notAudio ? "media_not_audio" : "media_unavailable" };
}
