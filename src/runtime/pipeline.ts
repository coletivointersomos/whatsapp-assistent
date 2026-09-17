import { applyChannelConfig } from "../adapters/hermes/config.ts";
import { normalizeOpenWaEnvelope } from "../adapters/hermes/normalize.ts";
import type { OpenWaEnvelope } from "../adapters/hermes/types.ts";
import type { MessageSender } from "../adapters/hermes/openwaSend.ts";
import { createAssistantProvider } from "../assistant/provider.ts";
import { createAssistantV2Provider } from "../assistant-v2/provider.ts";
import { loadAssistantV2Config } from "../assistant-v2/config.ts";
import type { AppState } from "../domain/types.ts";
import { processMessage, processMessageAsync, type Clock } from "../engine/process.ts";
import { canCallRemoteLlm, createNluProvider, loadNluConfig } from "../nlu/provider.ts";
import type { RuntimeConfig } from "./config.ts";
import { decideSend, type SendBlockReason } from "./sendGate.ts";

export type PipelineLog = (event: string, fields?: Record<string, unknown>) => void;

export type PipelineResult = {
  httpStatus: number;
  body: Record<string, unknown>;
};

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
}): Promise<PipelineResult> {
  const { runtime, state, sender } = input;
  const log = input.log ?? (() => undefined);
  const envelope = parseEnvelope(input.envelope);
  if (!envelope) {
    return { httpStatus: 400, body: { ok: false, reason: "invalid_payload" } };
  }

  const hydrated = applyChannelConfig(state, runtime.channel);
  Object.assign(state, hydrated);

  const normalized = normalizeOpenWaEnvelope(envelope, runtime.channel);
  if (!normalized.ok) {
    log("inbound_blocked", { reason: normalized.reason, chatId: envelope.data?.chatId });
    return {
      httpStatus: 200,
      body: { ok: false, processed: false, reason: normalized.reason, send: "blocked" },
    };
  }

  const inbound = normalized.inbound;
  const nluConfig = loadNluConfig(process.env);
  const v2Config = loadAssistantV2Config(process.env);
  const httpHooks = {
    onHttp: (info: {
      status: number;
      ok: boolean;
      statusText: string;
      host: string;
      path: string;
      usedResponseFormat: boolean;
      bodyPreview: string;
    }) =>
      log("nlu_http", {
        status: info.status,
        ok: info.ok,
        statusText: info.statusText,
        host: info.host,
        path: info.path,
        usedResponseFormat: info.usedResponseFormat,
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
  };
}
