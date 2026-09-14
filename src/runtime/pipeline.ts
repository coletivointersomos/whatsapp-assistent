import { applyChannelConfig } from "../adapters/hermes/config.ts";
import { normalizeOpenWaEnvelope } from "../adapters/hermes/normalize.ts";
import type { OpenWaEnvelope } from "../adapters/hermes/types.ts";
import type { MessageSender } from "../adapters/hermes/openwaSend.ts";
import type { AppState } from "../domain/types.ts";
import { processMessage, type Clock } from "../engine/process.ts";
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
  const clock = input.clock ?? { now: () => new Date(inbound.sentAt) };
  const processed = processMessage(state, inbound, clock);
  log("engine_decision", {
    decision: processed.decision,
    duplicate: processed.duplicate,
    conversationId: inbound.conversationId,
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
