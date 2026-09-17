import { normalizeInbound } from "../adapters/inbound.ts";
import { PAUSE_MS, isPauseActive, isSuspensionCovering } from "../domain/rules.ts";
import { isPrincipalDriver, resolveAuthorRole } from "../domain/identity.ts";
import type {
  AppState,
  BotReply,
  ConversationPause,
  InboundMessage,
  OperationalRecord,
  ProcessResult,
  StoredMessage,
} from "../domain/types.ts";
import { looksLikeBotPauseRequest } from "../extraction/pending.ts";
import { looksLikeAdminCommand } from "../extraction/extract.ts";
import { looksLikeClosingConfirmation, looksLikeFollowupQuestion } from "../nlu/plan.ts";
import { buildAssistantContext } from "./context.ts";
import { executeAssistantActions, localSummaryFallback } from "./execute.ts";
import { safeAssistantLogFields } from "./log.ts";
import { isUsableAssistantResponse, type AssistantProvider } from "./types.ts";

export type AssistantClock = {
  now: () => Date;
  assistant?: AssistantProvider;
  nluLog?: (event: string, fields: Record<string, unknown>) => void;
};

function pushReply(state: AppState, conversationId: string, text: string): BotReply {
  const reply = { conversationId, text };
  state.botReplies.push(reply);
  return reply;
}

function conversationPause(state: AppState, conversationId: string) {
  return state.pauses.find((p) => p.conversationId === conversationId);
}

function activeSuspension(state: AppState, driverId: string, now: Date) {
  return state.suspensions.find((s) => isSuspensionCovering(s.start, s.end, now, s.status) && s.driverId === driverId);
}

function canSendProactive(
  state: AppState,
  conversationId: string,
  driverId: string | undefined,
  now: Date,
): boolean {
  const pause = conversationPause(state, conversationId);
  if (pause && isPauseActive(pause.silenceUntil, now)) return false;
  if (driverId && activeSuspension(state, driverId, now)) return false;
  return true;
}

function naturalRecordAck(record: OperationalRecord): string {
  if (record.kind === "viagem") {
    const v = record.viagem ?? {};
    const route = v.origin && v.destination ? ` de ${v.origin} para ${v.destination}` : "";
    const cargo = v.material ? ` com ${v.material}` : "";
    const qty = v.quantity !== undefined ? `, ${v.quantity}${v.unit ? ` ${v.unit}` : ""}` : "";
    return `Fechado, registrei a viagem${route}${cargo}${qty}.`;
  }
  if (record.kind === "despesa") {
    const d = record.despesa ?? {};
    const name = d.description ? ` com ${d.description}` : "";
    const amount = d.amountBrl !== undefined ? ` de R$ ${d.amountBrl}` : "";
    const pay = d.payment ? ` no ${d.payment}` : "";
    const date = d.date ? ` em ${d.date}` : "";
    return `Fechado, registrei essa despesa${amount}${name}${pay}${date}.`;
  }
  return "Fechado, registrei esse abastecimento.";
}

function reconcileMessage(
  message: string,
  record: OperationalRecord | undefined,
  blocked: Array<{ type: string; reason: string }>,
  fallbackSummary?: string,
): string {
  const text = message.trim();
  if (!text && fallbackSummary) return fallbackSummary;
  if (!text && record) {
    return record.status === "completo" ? naturalRecordAck(record) : "Certo, anotei. Pode completar o que faltou quando puder.";
  }
  if (!record) return text;
  if (record.status === "completo" && looksLikeFollowupQuestion(text)) return naturalRecordAck(record);
  if (record.status === "incompleto" && looksLikeClosingConfirmation(text) && !looksLikeFollowupQuestion(text)) {
    return text;
  }
  if (blocked.length && !text) {
    return "Posso preparar, mas preciso de confirmação antes de executar isso.";
  }
  return text;
}

function dangerousMessage(text: string): boolean {
  return /sk-[a-z0-9_-]{8,}|Bearer\s+\S+|hmac/i.test(text);
}

export async function runAssistant(
  state: AppState,
  inboundRaw: InboundMessage,
  clock: AssistantClock,
): Promise<ProcessResult | undefined> {
  if (!clock.assistant) return undefined;
  const inbound = normalizeInbound(inboundRaw);
  const now = clock.now();
  const duplicate =
    state.messages.some((m) => m.externalId === inbound.externalId) ||
    state.rejected.some((r) => r.externalId === inbound.externalId);
  const conversation = state.conversations.find(
    (c) => c.active && (c.id === inbound.conversationId || c.externalId === inbound.conversationId),
  );
  const authorRole = conversation ? resolveAuthorRole(state, inbound.authorId) : "desconhecido";
  if (duplicate || !conversation || authorRole === "bot" || authorRole === "desconhecido") {
    return undefined;
  }
  if (authorRole === "motorista" && looksLikeAdminCommand(inbound.text ?? "")) return undefined;

  const isAdmin = authorRole === "alana";
  const isDriver = authorRole === "motorista" && isPrincipalDriver(state, conversation.driverId, inbound.authorId);
  if (!isAdmin && !isDriver) return undefined;

  const ctx = buildAssistantContext(state, inbound, {
    authorRole: isAdmin ? "alana" : "motorista",
    isAdmin,
    now,
    driverId: conversation.driverId,
  });

  let interpreted;
  try {
    interpreted = await Promise.resolve(clock.assistant.interpret(ctx));
  } catch {
    return undefined;
  }

  const emit = clock.nluLog;
  emit?.("assistant_response_received", safeAssistantLogFields(interpreted));

  if (!isUsableAssistantResponse(interpreted) || dangerousMessage(interpreted.message)) {
    emit?.("assistant_actions_blocked", { reason: interpreted.notes || "unusable", ...safeAssistantLogFields(interpreted) });
    return undefined;
  }

  const stored: StoredMessage = {
    ...inbound,
    authorRole,
    participantId: inbound.participantId ?? inbound.authorId,
    processedAt: now.toISOString(),
  };
  state.messages.push(stored);

  let pause: ConversationPause | undefined;
  if (isAdmin && conversation.role !== "central" && looksLikeBotPauseRequest(inbound.text ?? "")) {
    pause = {
      conversationId: conversation.id,
      reason: "intervencao_alana",
      silenceUntil: new Date(new Date(inbound.sentAt).getTime() + PAUSE_MS).toISOString(),
      lastAlanaMessageId: inbound.externalId,
    };
    const idx = state.pauses.findIndex((p) => p.conversationId === conversation.id);
    if (idx >= 0) state.pauses[idx] = pause;
    else state.pauses.push(pause);
  }

  const vehicleHint = state.drivers.find((d) => d.id === conversation.driverId)?.vehicleHint;
  const outcome = executeAssistantActions({
    state,
    inbound,
    conversation,
    response: interpreted,
    isAdmin,
    isDriver,
    now,
    vehicleHint,
  });

  if (outcome.applied.length) emit?.("assistant_actions_applied", { applied: outcome.applied });
  if (outcome.blocked.length) emit?.("assistant_actions_blocked", { blocked: outcome.blocked });

  const summaryAction = interpreted.actions.find((action) => action.type === "summary.query");
  const summary =
    summaryAction && !interpreted.message.trim()
      ? localSummaryFallback(state, summaryAction.scope, now)
      : undefined;
  const message = reconcileMessage(interpreted.message, outcome.record, outcome.blocked, summary);
  const allowReply = isAdmin || canSendProactive(state, conversation.id, conversation.driverId, now);
  const replies = allowReply && message ? [pushReply(state, conversation.id, message)] : [];

  return {
    decision: outcome.record ? outcome.decision : "assisted",
    duplicate: false,
    message: stored,
    record: outcome.record,
    replies,
    pause,
  };
}
