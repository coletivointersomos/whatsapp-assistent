import { normalizeInbound } from "../adapters/inbound.ts";
import { isPrincipalDriver, resolveAuthorRole } from "../domain/identity.ts";
import type {
  AppState,
  BotReply,
  InboundMessage,
  ProcessResult,
  StoredMessage,
} from "../domain/types.ts";
import { looksLikeAdminCommand } from "../extraction/extract.ts";
import { previewReply } from "../nlu/audit.ts";
import { buildAssistantV2Context } from "./context.ts";
import { executeAssistantV2Actions, formatSessionSummary } from "./execute.ts";
import {
  V2_MISSING_ACTION_RETRY,
  V2_NEED_TEXT,
  buildV2FallbackActions,
  looksOperationalV2,
  chatUnavailableReply,
} from "./fallback.ts";
import { composeV2Reply } from "./reply.ts";
import { activeOfKind, parseSessionStart, sessionRecords } from "./session.ts";
import {
  emptyAssistantV2,
  isUsableAssistantV2,
  type AssistantV2Provider,
  type AssistantV2Response,
} from "./types.ts";

export type AssistantV2Clock = {
  now: () => Date;
  assistantV2?: AssistantV2Provider;
  assistantV2Enabled?: boolean;
  assistantV2SessionStartedAt?: string;
  nluLog?: (event: string, fields: Record<string, unknown>) => void;
};

function pushReply(state: AppState, conversationId: string, text: string): BotReply {
  const reply = { conversationId, text };
  state.botReplies.push(reply);
  return reply;
}

function logFields(result: AssistantV2Response): Record<string, unknown> {
  const preview = previewReply(result.message);
  return {
    actions_count: result.actions.length,
    action_types: result.actions.map((action) => action.type),
    confidence: result.confidence,
    needsConfirmation: Boolean(result.needsConfirmation),
    message_preview: preview.replyPreview ?? "",
    hasMessage: preview.hasReply,
  };
}

export async function runAssistantV2(
  state: AppState,
  inboundRaw: InboundMessage,
  clock: AssistantV2Clock,
): Promise<ProcessResult | undefined> {
  if (!clock.assistantV2Enabled) return undefined;
  const inbound = normalizeInbound(inboundRaw);
  const now = clock.now();
  const duplicate =
    state.messages.some((m) => m.externalId === inbound.externalId) ||
    state.rejected.some((r) => r.externalId === inbound.externalId);
  const conversation = state.conversations.find(
    (c) => c.active && (c.id === inbound.conversationId || c.externalId === inbound.conversationId),
  );
  const authorRole = conversation ? resolveAuthorRole(state, inbound.authorId) : "desconhecido";
  if (duplicate || !conversation || authorRole === "bot") {
    return undefined;
  }
  if (authorRole === "motorista" && looksLikeAdminCommand(inbound.text ?? "")) return undefined;

  const isAdmin = authorRole === "alana";
  const isDriver = authorRole === "motorista" && isPrincipalDriver(state, conversation.driverId, inbound.authorId);
  const v2Role = isAdmin ? "admin" : isDriver ? "motorista" : "participante";
  const emit = clock.nluLog;

  const stored: StoredMessage = {
    ...inbound,
    authorRole,
    participantId: inbound.participantId ?? inbound.authorId,
    processedAt: now.toISOString(),
  };

  if (!(inbound.text ?? "").trim() && inbound.type !== "texto") {
    state.messages.push(stored);
    emit?.("assistant_v2_media_without_text", { type: inbound.type });
    return {
      decision: "assisted",
      duplicate: false,
      message: stored,
      replies: [pushReply(state, conversation.id, V2_NEED_TEXT)],
    };
  }

  const ctx = buildAssistantV2Context({
    state,
    inbound,
    conversation,
    authorRole: v2Role,
    sessionStartedAt: clock.assistantV2SessionStartedAt,
  });

  let interpreted: AssistantV2Response = emptyAssistantV2("no_provider");
  try {
    if (clock.assistantV2) interpreted = await Promise.resolve(clock.assistantV2.interpret(ctx));
  } catch {
    interpreted = emptyAssistantV2("llm_failed");
  }

  emit?.("assistant_v2_response_received", logFields(interpreted));

  state.messages.push(stored);

  const session = sessionRecords(state, conversation, parseSessionStart(clock.assistantV2SessionStartedAt));
  const hasPending = Boolean(
    activeOfKind(session, "viagem") || activeOfKind(session, "despesa") || activeOfKind(session, "abastecimento"),
  );
  const operational = looksOperationalV2(inbound.text ?? "", hasPending);
  let response = isUsableAssistantV2(interpreted) ? interpreted : emptyAssistantV2(interpreted.notes ?? "unusable");

  if (operational && response.actions.length === 0 && clock.assistantV2) {
    emit?.("assistant_v2_action_retry", logFields(response));
    try {
      const retried = await Promise.resolve(
        clock.assistantV2.interpret({ ...ctx, persistHint: "emit_record_actions" }),
      );
      emit?.("assistant_v2_action_retry_received", logFields(retried));
      if (isUsableAssistantV2(retried) && retried.actions.length) {
        interpreted = retried;
        response = retried;
      }
    } catch {
      /* mantém a primeira fala do Hermes */
    }
  }

  if (operational && response.actions.length === 0) {
    const fallbackActions = buildV2FallbackActions({
      state,
      inbound,
      conversation,
      sessionStartedAt: clock.assistantV2SessionStartedAt,
    });
    if (fallbackActions.length) {
      emit?.("assistant_v2_missing_action_fallback", {
        fallback_types: fallbackActions.map((action) => action.type),
        ...logFields(response),
      });
      response = { ...response, actions: fallbackActions, confidence: Math.max(response.confidence, 0.7) };
    }
  }

  const vehicleHint = state.drivers.find((d) => d.id === conversation.driverId)?.vehicleHint;
  let outcome = executeAssistantV2Actions({
    state,
    inbound,
    conversation,
    response,
    isAdmin,
    isDriver,
    now,
    sessionStartedAt: clock.assistantV2SessionStartedAt,
    vehicleHint,
  });

  const sensitiveBlocked = outcome.blocked.some(
    (item) =>
      item.type === "broadcast.request" ||
      item.type === "sheet.change.request" ||
      item.type === "ask_driver.request",
  );
  if (operational && !outcome.record && !outcome.statusCreated && !sensitiveBlocked) {
    const fallbackActions = buildV2FallbackActions({
      state,
      inbound,
      conversation,
      sessionStartedAt: clock.assistantV2SessionStartedAt,
    });
    if (fallbackActions.length && (response.actions.length === 0 || outcome.blocked.some((item) => item.reason === "no_session_target"))) {
      emit?.("assistant_v2_missing_action_fallback", {
        fallback_types: fallbackActions.map((action) => action.type),
        ...logFields(response),
      });
      outcome = executeAssistantV2Actions({
        state,
        inbound,
        conversation,
        response: { ...response, actions: fallbackActions, confidence: 0.7 },
        isAdmin,
        isDriver,
        now,
        sessionStartedAt: clock.assistantV2SessionStartedAt,
        vehicleHint,
      });
    }
  }

  if (outcome.applied.length) emit?.("assistant_v2_actions_applied", { applied: outcome.applied });
  if (outcome.blocked.length) emit?.("assistant_v2_actions_blocked", { blocked: outcome.blocked });

  if (isAdmin && /onde estamos/i.test(inbound.text ?? "") && !outcome.record && !outcome.statusCreated) {
    outcome.summary = formatSessionSummary(state, conversation, clock.assistantV2SessionStartedAt);
  }

  let message = composeV2Reply({
    state,
    conversation,
    outcome,
    llmMessage: interpreted.message,
    sessionStartedAt: clock.assistantV2SessionStartedAt,
  });

  if (operational && !outcome.record && !outcome.statusCreated && !sensitiveBlocked && !interpreted.message.trim()) {
    message = V2_MISSING_ACTION_RETRY;
  } else if (!message.trim()) {
    message = chatUnavailableReply(inbound.text ?? "", interpreted.notes);
  }

  const replies = message ? [pushReply(state, conversation.id, message)] : [];
  return {
    decision: outcome.record ? outcome.decision : "assisted",
    duplicate: false,
    message: stored,
    record: outcome.record,
    replies,
  };
}
