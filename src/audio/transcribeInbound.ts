import { fetchOpenWaAudio, MAX_AUDIO_BYTES } from "../adapters/hermes/openwaMedia.ts";
import type { OpenWaEnvelope } from "../adapters/hermes/types.ts";
import type { InboundMessage } from "../domain/types.ts";
import { maskPii } from "../privacy/pii.ts";
import type { RuntimeConfig } from "../runtime/config.ts";
import { createAlibabaAsr, isAlibabaAsrConfigured, type SpeechToText } from "./alibabaAsr.ts";
import type { AsrRuntimeConfig } from "./config.ts";

export type AsrLog = (event: string, fields?: Record<string, unknown>) => void;

type AudioBytes = { mime: string; base64: string; bytes: number; source: "webhook" | "openwa" };

function base64Bytes(base64: string): number {
  const clean = base64.replace(/\s/g, "");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
}

/** Áudio que já veio no webhook (data URL ou base64 puro). */
function audioFromWebhook(envelope: OpenWaEnvelope): AudioBytes | undefined {
  const media = envelope.data?.media;
  const raw = typeof media?.data === "string" ? media.data.trim() : "";
  if (!raw) return undefined;
  const match = raw.match(/^data:([^;,]+)[^,]*;base64,(.+)$/is);
  const base64 = (match ? match[2] : raw).replace(/\s/g, "");
  const mime = (media?.mimetype || match?.[1] || "audio/ogg").split(";", 1)[0]!.trim().toLowerCase();
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) return undefined;
  return { mime: mime.startsWith("audio/") ? mime : "audio/ogg", base64, bytes: base64Bytes(base64), source: "webhook" };
}

/**
 * Áudio de conversa autorizada → texto (transcrição com PII mascarada) para o NLU.
 * Qualquer falha registra `asr_failed` e devolve a mensagem como estava (comportamento audio_info atual).
 * Nunca registra transcrição, áudio, chave ou JID completo.
 */
export async function transcribeAudioInbound(input: {
  inbound: InboundMessage;
  envelope: OpenWaEnvelope;
  runtime: RuntimeConfig;
  config: AsrRuntimeConfig;
  asr?: SpeechToText;
  fetchImpl?: typeof fetch;
  log?: AsrLog;
  /** Bytes do áudio aceito (para o arquivo no Drive, 2d). Não altera a transcrição. */
  onAudio?: (audio: { mime: string; base64: string }) => void;
}): Promise<InboundMessage> {
  const { inbound, config } = input;
  const log = input.log ?? (() => undefined);
  if (inbound.type !== "audio_info") return inbound;
  if (!config.enabled) return inbound;
  if (inbound.text?.trim()) return inbound;
  const fail = (reason: string, fields: Record<string, unknown> = {}) => {
    log("asr_failed", { reason, ...fields });
    return inbound;
  };
  if (!input.asr && !isAlibabaAsrConfigured(config)) return fail("asr_not_configured");

  let audio = audioFromWebhook(input.envelope);
  if (!audio) {
    const fetched = await fetchOpenWaAudio({
      baseUrl: input.runtime.openwaBaseUrl,
      apiKey: input.runtime.openwaApiKey,
      apiKeyHeader: input.runtime.openwaApiKeyHeader,
      sessionId: input.runtime.sessionId,
      messageId: inbound.externalId,
      chatId: inbound.conversationId,
      mediaPath: input.runtime.openwaMediaPath,
      fetchImpl: input.fetchImpl,
    });
    if (!fetched.ok) return fail(fetched.reason, fetched.bytes ? { bytes: fetched.bytes } : {});
    audio = { ...fetched.media, source: "openwa" };
  }
  if (audio.bytes <= 0) return fail("media_empty");
  if (audio.bytes > MAX_AUDIO_BYTES) return fail("media_too_large", { bytes: audio.bytes });
  input.onAudio?.({ mime: audio.mime, base64: audio.base64 });

  const started = Date.now();
  try {
    const client = input.asr ?? createAlibabaAsr(config, input.fetchImpl);
    const transcript = (await client.transcribe({ data: audio.base64, mimetype: audio.mime })).trim();
    if (!transcript) return fail("asr_transcript_missing");
    // Máscara pelo ponto único (privacy/pii.ts → maskPii), igual à 1b: desligar lá desliga aqui.
    const text = maskPii(transcript).slice(0, 8_000);
    log("asr_ok", { source: audio.source, mime: audio.mime, bytes: audio.bytes, transcriptChars: text.length, ms: Date.now() - started });
    return { ...inbound, text };
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 80) : "unknown";
    return fail(reason, { bytes: audio.bytes, ms: Date.now() - started });
  }
}
