import { applyChannelConfig } from "../adapters/hermes/config.ts";
import { normalizeOpenWaEnvelope } from "../adapters/hermes/normalize.ts";
import { decodePlainText, fetchOpenWaImage, isPlainTextMime } from "../adapters/hermes/openwaMedia.ts";
import type { OpenWaEnvelope } from "../adapters/hermes/types.ts";
import type { MessageSender } from "../adapters/hermes/openwaSend.ts";
import { createAssistantProvider } from "../assistant/provider.ts";
import { createAssistantV2Provider } from "../assistant-v2/provider.ts";
import { loadAssistantV2Config } from "../assistant-v2/config.ts";
import type { AppState, ProcessResult } from "../domain/types.ts";
import { processMessage, processMessageAsync, type Clock } from "../engine/process.ts";
import { canCallRemoteLlm, createNluProvider, loadNluConfig } from "../nlu/provider.ts";
import type { SpeechToText } from "../audio/alibabaAsr.ts";
import { loadAsrConfig, type AsrRuntimeConfig } from "../audio/config.ts";
import { transcribeAudioInbound } from "../audio/transcribeInbound.ts";
import { ingestPdfInbound, isPdfMime, type PdfRunner } from "../documents/pdf.ts";
import { archiveToDrive, buildArchiveItems } from "../drive/archive.ts";
import { driveSkipReason, loadDriveConfig, type DriveConfig } from "../drive/config.ts";
import { driveTokenProvider } from "../drive/auth.ts";
import { createDriveClient, type DriveClient } from "../drive/googleDrive.ts";
import type { RuntimeConfig } from "./config.ts";
import { decideSend, type SendBlockReason } from "./sendGate.ts";

export type PipelineLog = (event: string, fields?: Record<string, unknown>) => void;

export type PipelineResult = {
  httpStatus: number;
  body: Record<string, unknown>;
  /**
   * true só quando a mensagem foi de fato processada numa conversa autorizada.
   * Bloqueada, rejeitada, duplicada ou do próprio bot → false (não dispara sync da planilha).
   */
  sheetsSync: boolean;
};

/** A mensagem pode ter mudado registros de uma conversa autorizada? Só então vale sincronizar a planilha. */
export function shouldSyncSheetsAfter(processed: Pick<ProcessResult, "decision" | "duplicate" | "message">): boolean {
  if (processed.duplicate) return false;
  if (processed.decision === "duplicate" || processed.decision === "rejected_unauthorized") return false;
  if (processed.message?.authorRole === "bot") return false;
  return true;
}

let driveClientCache: { key: string; client: DriveClient } | undefined;
function defaultDriveClient(config: DriveConfig): DriveClient {
  const key = `${config.auth ?? "service_account"}|${config.credentialsPath}|${config.oauthClientFile ?? ""}|${config.oauthTokenFile ?? ""}`;
  if (driveClientCache?.key !== key) {
    driveClientCache = { key, client: createDriveClient({ token: driveTokenProvider(config) }) };
  }
  return driveClientCache.client;
}

function parseEnvelope(raw: unknown): OpenWaEnvelope | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return raw as OpenWaEnvelope;
}

export async function handleInboundPayload(input: {
  runtime: RuntimeConfig;
  state: AppState;
  envelope: unknown;
  sender: MessageSender;
  clock?: Clock;
  log?: PipelineLog;
  /** Testes: cliente ASR, config ASR e fetch (mídia do OpenWA) simulados. */
  audio?: { asr?: SpeechToText; config?: AsrRuntimeConfig; fetchImpl?: typeof fetch };
  /** Testes: executor de pdftotext/pdftoppm simulado. */
  pdfRunner?: PdfRunner;
  /** Testes: config/cliente do Drive simulados; awaitArchive espera o upload terminar. */
  drive?: { config?: DriveConfig; client?: DriveClient; awaitArchive?: boolean };
}): Promise<PipelineResult> {
  const { runtime, state, sender } = input;
  const log = input.log ?? (() => undefined);
  const envelope = parseEnvelope(input.envelope);
  if (!envelope) {
    return { httpStatus: 400, body: { ok: false, reason: "invalid_payload" }, sheetsSync: false };
  }

  const hydrated = applyChannelConfig(state, runtime.channel);
  Object.assign(state, hydrated);

  const normalized = normalizeOpenWaEnvelope(envelope, runtime.channel);
  if (!normalized.ok) {
    log("inbound_blocked", { reason: normalized.reason, chatId: envelope.data?.chatId });
    return {
      httpStatus: 200,
      body: { ok: false, processed: false, reason: normalized.reason, send: "blocked" },
      sheetsSync: false,
    };
  }

  let inbound = normalized.inbound;
  const alreadySeen =
    state.messages.some((m) => m.externalId === inbound.externalId) ||
    state.rejected.some((r) => r.externalId === inbound.externalId);
  const original: {
    audio?: { mime: string; base64: string };
    photo?: { mime: string; base64: string };
    pdf?: { mime: string; base64: string };
    transcript?: string;
  } = {};
  if (inbound.type === "audio_info" && !alreadySeen) {
    inbound = await transcribeAudioInbound({
      onAudio: (audio) => {
        original.audio = audio;
      },
      inbound,
      envelope,
      runtime,
      config: input.audio?.config ?? loadAsrConfig(process.env),
      asr: input.audio?.asr,
      fetchImpl: input.audio?.fetchImpl,
      log,
    });
    if (original.audio && inbound.text?.trim()) original.transcript = inbound.text;
  }
  if (inbound.type === "anexo_comprovante" && !inbound.media?.base64 && runtime.openwaBaseUrl) {
    const fetched = await fetchOpenWaImage({
      baseUrl: runtime.openwaBaseUrl,
      apiKey: runtime.openwaApiKey,
      apiKeyHeader: runtime.openwaApiKeyHeader,
      sessionId: runtime.sessionId,
      messageId: inbound.externalId,
      chatId: inbound.conversationId,
      mediaPath: runtime.openwaMediaPath,
    });
    if (fetched) {
      inbound = { ...inbound, media: fetched };
      log("vision_media_fetched", { source: fetched.source });
    } else {
      log("vision_media_missing", { type: inbound.type });
    }
  }
  if (inbound.media?.base64 && isPdfMime(inbound.media.mime)) original.pdf = { mime: inbound.media.mime, base64: inbound.media.base64 };
  else if (inbound.media?.base64 && inbound.media.mime.startsWith("image/")) original.photo = { mime: inbound.media.mime, base64: inbound.media.base64 };
  if (inbound.media && isPdfMime(inbound.media.mime)) {
    inbound = await ingestPdfInbound({ inbound, runner: input.pdfRunner, log });
  }
  if (inbound.media && isPlainTextMime(inbound.media.mime)) {
    const decoded = decodePlainText(inbound.media.base64).trim();
    inbound = {
      ...inbound,
      type: "texto",
      text: [inbound.text, decoded].filter(Boolean).join("\n").slice(0, 80_000),
      media: undefined,
    };
    log("plain_text_ingested", { chars: decoded.length });
  }
  const nluConfig = loadNluConfig(process.env);
  const v2Config = loadAssistantV2Config(process.env);
  if (inbound.media?.base64 && inbound.media.mime.startsWith("image/")) {
    log(nluConfig.visionEnabled ? "vision_armed" : "vision_disabled", { mime: inbound.media.mime });
  }
  const httpHooks = {
    onHttp: (info: {
      status: number;
      ok: boolean;
      statusText: string;
      host: string;
      path: string;
      usedResponseFormat: boolean;
      bodyPreview: string;
      vision?: boolean;
    }) =>
      log("nlu_http", {
        status: info.status,
        ok: info.ok,
        statusText: info.statusText,
        host: info.host,
        path: info.path,
        usedResponseFormat: info.usedResponseFormat,
        vision: info.vision,
        bodyPreview: info.bodyPreview,
      }),
  };
  const nlu = input.clock?.nlu ?? createNluProvider(nluConfig, httpHooks);
  const llmReady =
    input.clock?.nluFirst === true ||
    (input.clock?.nluFirst !== false && canCallRemoteLlm(nluConfig) && input.clock?.nluEnabled !== false);
  const v2On = input.clock?.assistantV2Enabled ?? v2Config.enabled;
  const assistant =
    input.clock?.assistant ??
    (canCallRemoteLlm(nluConfig) && !v2On ? createAssistantProvider(nluConfig, fetch, httpHooks) : undefined);
  const assistantV2 =
    input.clock?.assistantV2 ??
    (v2On && canCallRemoteLlm(nluConfig) ? createAssistantV2Provider(nluConfig, fetch, httpHooks) : undefined);
  const clock: Clock = {
    now: input.clock?.now ?? (() => new Date(inbound.sentAt)),
    nluEnabled: input.clock?.nluEnabled,
    nlu,
    nluFirst: v2On ? false : llmReady,
    assistant,
    assistantFirst: v2On ? false : (input.clock?.assistantFirst ?? llmReady),
    assistantV2Enabled: v2On,
    assistantV2SessionStartedAt: input.clock?.assistantV2SessionStartedAt ?? v2Config.sessionStartedAt,
    assistantV2,
    nluLog: input.clock?.nluLog ?? ((event, fields) => log(event, fields)),
  };
  const processed =
    clock.assistantV2Enabled || clock.assistantFirst || llmReady
      ? await processMessageAsync(state, inbound, clock)
      : processMessage(state, inbound, clock);

  if (clock.assistantV2Enabled) {
    log("assistant_v2", { provider: assistantV2?.name ?? "none", decision: processed.decision });
  } else if (clock.assistantFirst) {
    log("assistant_first", { provider: assistant?.name ?? "none", decision: processed.decision });
  } else if (llmReady) {
    log("nlu_first", { provider: nlu?.name ?? "none", decision: processed.decision });
  }

  log("engine_decision", {
    decision: processed.decision,
    duplicate: processed.duplicate,
    conversationId: inbound.conversationId.replace(/\d{10,}(?=@)/, "…"),
    replyCount: processed.replies.length,
  });

  const sheetsSync = shouldSyncSheetsAfter(processed);

  // 2d: arquivo no Drive (só criar). Desligado sem DRIVE_ENABLED=true e sem a conversa em DRIVE_CHAT_IDS.
  const driveConfig = input.drive?.config ?? loadDriveConfig(process.env);
  const driveSkip = driveSkipReason(driveConfig);
  if (!driveSkip && sheetsSync && !alreadySeen && driveConfig.chatIds.includes(inbound.conversationId)) {
    const factDate = state.records
      .filter((record) => record.sourceMessageIds.includes(inbound.externalId))
      .map((record) => (record.viagem ?? record.despesa ?? record.abastecimento)?.date)
      .find((date): date is string => Boolean(date && /^\d{4}-\d{2}/.test(date)));
    const items = buildArchiveItems({
      externalId: inbound.externalId,
      sentAt: inbound.sentAt,
      factCompetencia: factDate?.slice(0, 7),
      photo: original.photo,
      pdf: original.pdf,
      audio: original.audio,
      transcript: original.transcript,
      text: original.audio ? undefined : inbound.text,
      author: inbound.authorRole,
      originalName: typeof envelope.data?.media?.filename === "string" ? envelope.data.media.filename : undefined,
    });
    if (items.length) {
      const client = input.drive?.client ?? defaultDriveClient(driveConfig);
      const job = archiveToDrive({ client, rootFolderId: driveConfig.rootFolderId, items, log }).catch((error: unknown) => {
        log("drive_failed", { reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" });
        return [];
      });
      if (input.drive?.awaitArchive) await job;
    }
  }

  const gate = decideSend({
    runtime,
    conversationId: inbound.conversationId,
    sessionId: envelope.sessionId,
    process: processed,
  });

  if (!gate.allowed) {
    log("send_blocked", { reason: gate.reason, liveSend: runtime.liveSend });
    return {
      httpStatus: 200,
      body: {
        ok: true,
        processed: true,
        decision: processed.decision,
        duplicate: processed.duplicate,
        replies: processed.replies,
        send: { attempted: false, reason: gate.reason as SendBlockReason },
      },
      sheetsSync,
    };
  }

  const deliveries = [];
  for (const text of gate.texts) {
    const result = await sender.sendText({
      sessionId: runtime.sessionId,
      chatId: inbound.conversationId,
      text,
    });
    deliveries.push({ chatId: inbound.conversationId, ok: result.ok, status: result.status });
    log(result.ok ? "send_ok" : "send_failed", {
      chatId: inbound.conversationId,
      status: result.status,
    });
  }

  return {
    httpStatus: deliveries.every((d) => d.ok) ? 200 : 502,
    body: {
      ok: deliveries.every((d) => d.ok),
      processed: true,
      decision: processed.decision,
      duplicate: processed.duplicate,
      replies: processed.replies,
      send: { attempted: true, deliveries },
    },
    sheetsSync,
  };
}
