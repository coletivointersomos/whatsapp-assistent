import { normalizeInbound } from "../adapters/inbound.ts";
import {
  ABASTECIMENTO_REQUIRED,
  DESPESA_REQUIRED,
  PAUSE_MS,
  VIAGEM_REQUIRED,
  isPauseActive,
  isSuspensionCovering,
} from "../domain/rules.ts";
import {
  findDriverByAuthor,
  isPrincipalDriver,
  resolveAuthorRole,
} from "../domain/identity.ts";
import type {
  AppState,
  BotReply,
  ConversationPause,
  DriverDeferral,
  InboundMessage,
  OperationalRecord,
  ProcessResult,
  StoredMessage,
} from "../domain/types.ts";
import { confirmationForKind, parseCentralCommand, questionForMissing } from "../extraction/command.ts";
import { matchAdminAssist, matchCentralAssist, matchDriverAssist } from "../extraction/assist.ts";
import {
  extractComplement,
  extractFromText,
  isDeferral,
  isNewOperationalEvent,
  looksLikeAdminCommand,
} from "../extraction/extract.ts";
import { planPendingResume } from "./resume.ts";

export type Clock = { now: () => Date };

function missingFields(record: OperationalRecord): string[] {
  const req =
    record.kind === "abastecimento"
      ? ABASTECIMENTO_REQUIRED
      : record.kind === "despesa"
        ? DESPESA_REQUIRED
        : VIAGEM_REQUIRED;
  const fields =
    record.kind === "abastecimento"
      ? record.abastecimento
      : record.kind === "despesa"
        ? record.despesa
        : record.viagem;
  return req.filter((key) => {
    const value = fields?.[key as keyof typeof fields];
    return value === undefined || value === "";
  });
}

function findDriverByName(state: AppState, name: string) {
  const n = name.trim().toLowerCase();
  const exact = state.drivers.filter((d) => d.name.toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const partial = state.drivers.filter((d) => d.name.toLowerCase().includes(n));
  if (partial.length === 1) return partial[0];
  return undefined;
}

function activeSuspension(state: AppState, driverId: string, now: Date) {
  return state.suspensions.find((s) =>
    isSuspensionCovering(s.start, s.end, now, s.status) && s.driverId === driverId,
  );
}

function conversationPause(state: AppState, conversationId: string) {
  return state.pauses.find((p) => p.conversationId === conversationId);
}

function recordInConversation(
  state: AppState,
  record: OperationalRecord,
  conversation: { id: string; externalId: string },
): boolean {
  return record.sourceMessageIds.some((id) => {
    const message = state.messages.find((item) => item.externalId === id);
    if (!message) return false;
    return (
      message.conversationId === conversation.id ||
      message.conversationId === conversation.externalId
    );
  });
}

function findOpenIncomplete(
  state: AppState,
  conversation: { id: string; externalId: string; driverId?: string },
): OperationalRecord | undefined {
  if (!conversation.driverId) return undefined;
  const matches = state.records.filter(
    (record) =>
      record.status === "incompleto" &&
      record.driverId === conversation.driverId &&
      recordInConversation(state, record, conversation),
  );
  return matches[matches.length - 1];
}

function pendingFields(record: OperationalRecord) {
  return record.kind === "abastecimento"
    ? record.abastecimento
    : record.kind === "despesa"
      ? record.despesa
      : record.viagem;
}

function applyComplement(record: OperationalRecord, incoming: Record<string, string | number> | undefined) {
  if (!incoming) return [] as string[];
  const bucket =
    record.kind === "abastecimento"
      ? (record.abastecimento ??= {})
      : record.kind === "despesa"
        ? (record.despesa ??= {})
        : (record.viagem ??= {});
  const filled: string[] = [];
  for (const key of record.missing) {
    const value = incoming[key];
    if (value === undefined || value === "") continue;
    (bucket as Record<string, string | number>)[key] = value;
    filled.push(key);
  }
  return filled;
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

function clearDeferral(state: AppState, conversationId: string) {
  state.deferrals = state.deferrals.filter((item) => item.conversationId !== conversationId);
}

function pushReply(
  state: AppState,
  conversationId: string,
  text: string,
): BotReply {
  const reply = { conversationId, text };
  state.botReplies.push(reply);
  return reply;
}

function snapshotReplies(replies: BotReply[]): BotReply[] {
  return replies.map((r) => ({ ...r }));
}

export function processMessage(
  state: AppState,
  inboundRaw: InboundMessage,
  clock: Clock,
): ProcessResult {
  const inbound = normalizeInbound(inboundRaw);
  const now = clock.now();

  const existing = state.messages.find((m) => m.externalId === inbound.externalId);
  if (existing) {
    const record = state.records.find((r) =>
      r.sourceMessageIds.includes(inbound.externalId),
    );
    const command = state.commands.find((c) => c.messageId === inbound.externalId);
    return {
      decision: "duplicate",
      duplicate: true,
      message: existing,
      record,
      command,
      replies: [],
    };
  }

  const rejectedExisting = state.rejected.find((r) => r.externalId === inbound.externalId);
  if (rejectedExisting) {
    return {
      decision: "duplicate",
      duplicate: true,
      replies: [],
      rejected: rejectedExisting,
    };
  }

  const conversation = state.conversations.find(
    (c) =>
      c.active &&
      (c.id === inbound.conversationId || c.externalId === inbound.conversationId),
  );

  if (!conversation) {
    const rejected = {
      externalId: inbound.externalId,
      conversationId: inbound.conversationId,
      reason: "unauthorized_conversation" as const,
      receivedAt: now.toISOString(),
    };
    state.rejected.push(rejected);
    return { decision: "rejected_unauthorized", duplicate: false, replies: [], rejected };
  }

  const authorRole = resolveAuthorRole(state, inbound.authorId);
  const stored = {
    ...inbound,
    authorRole,
    participantId: inbound.participantId ?? inbound.authorId,
    processedAt: now.toISOString(),
  };
  state.messages.push(stored);

  if (authorRole === "bot") {
    return { decision: "ignored", duplicate: false, message: stored, replies: [] };
  }

  if (conversation.role === "central") {
    return handleCentral(state, stored, now);
  }

  if (authorRole === "alana") {
    const existingPause = conversationPause(state, conversation.id);
    const alreadyPaused = Boolean(existingPause && isPauseActive(existingPause.silenceUntil, now));
    const sentAt = new Date(inbound.sentAt);
    const silenceUntil = new Date(sentAt.getTime() + PAUSE_MS).toISOString();
    const pause: ConversationPause = {
      conversationId: conversation.id,
      reason: "intervencao_alana",
      silenceUntil,
      lastAlanaMessageId: inbound.externalId,
    };
    const idx = state.pauses.findIndex((p) => p.conversationId === conversation.id);
    if (idx >= 0) state.pauses[idx] = pause;
    else state.pauses.push(pause);
    const assist = !alreadyPaused ? matchAdminAssist(inbound.text ?? "") : undefined;
    const replies: BotReply[] = assist ? [pushReply(state, conversation.id, assist)] : [];
    return {
      decision: assist ? "assisted" : "pause_updated",
      duplicate: false,
      message: stored,
      replies: snapshotReplies(replies),
      pause,
    };
  }

  if (authorRole !== "motorista" || !isPrincipalDriver(state, conversation.driverId, inbound.authorId)) {
    return { decision: "ignored", duplicate: false, message: stored, replies: [] };
  }

  const text = inbound.text?.trim() ?? "";

  if (looksLikeAdminCommand(text)) {
    const command = {
      id: `cmd-${inbound.externalId}`,
      messageId: inbound.externalId,
      interpretation: "comando administrativo em conversa de motorista",
      status: "recusada" as const,
      detail: "Somente a Alana na central de comando pode alterar regras.",
    };
    state.commands.push(command);
    const replies: BotReply[] = canSendProactive(
      state,
      conversation.id,
      conversation.driverId,
      now,
    )
      ? [{ conversationId: conversation.id, text: command.detail }]
      : [];
    state.botReplies.push(...replies);
    return {
      decision: "command_refused",
      duplicate: false,
      message: stored,
      command,
      replies: snapshotReplies(replies),
    };
  }

  if (text && isDeferral(text)) {
    const pending = findOpenIncomplete(state, conversation);
    const deferral: DriverDeferral = {
      conversationId: conversation.id,
      recordId: pending?.id,
      reason: "motorista_adiou",
      messageId: inbound.externalId,
      deferredAt: now.toISOString(),
    };
    const idx = state.deferrals.findIndex((item) => item.conversationId === conversation.id);
    if (idx >= 0) state.deferrals[idx] = deferral;
    else state.deferrals.push(deferral);
    const replies: BotReply[] = canSendProactive(
      state,
      conversation.id,
      conversation.driverId,
      now,
    )
      ? [pushReply(state, conversation.id, "Beleza, te pergunto depois.")]
      : [];
    return {
      decision: "deferred",
      duplicate: false,
      message: stored,
      record: pending,
      deferral,
      replies: snapshotReplies(replies),
    };
  }

  if (inbound.type === "anexo_comprovante" && !detectsKind(text)) {
    return { decision: "attachment_stored", duplicate: false, message: stored, replies: [] };
  }

  if (!text) {
    const replies = considerResume(state, conversation.id, { now: () => now });
    return {
      decision: "ignored",
      duplicate: false,
      message: stored,
      replies: snapshotReplies(replies),
    };
  }

  const driver =
    findDriverByAuthor(state, inbound.authorId) ??
    state.drivers.find((d) => d.id === conversation.driverId);
  const sentAt = new Date(inbound.sentAt);
  const extracted = extractFromText(text, sentAt, driver?.vehicleHint);
  const pending = findOpenIncomplete(state, conversation);

  if (pending && !isNewOperationalEvent(extracted, pending.kind, pendingFields(pending))) {
    const complement = extractComplement(pending.kind, text, sentAt, driver?.vehicleHint);
    const incoming =
      pending.kind === "abastecimento"
        ? complement.abastecimento
        : pending.kind === "despesa"
          ? complement.despesa
          : complement.viagem;
    const filled = applyComplement(pending, incoming);
    if (filled.length > 0) {
      pending.sourceMessageIds.push(inbound.externalId);
      pending.missing = missingFields(pending);
      pending.status = pending.missing.length === 0 ? "completo" : "incompleto";
      clearDeferral(state, conversation.id);
      const replies: BotReply[] = [];
      if (canSendProactive(state, conversation.id, conversation.driverId, now)) {
        if (pending.status === "completo") {
          replies.push(pushReply(state, conversation.id, confirmationForKind(pending.kind)));
        } else {
          replies.push(
            pushReply(state, conversation.id, questionForMissing(pending.kind, pending.missing)),
          );
        }
      }
      return {
        decision: pending.status === "completo" ? "record_created" : "record_incomplete",
        duplicate: false,
        message: stored,
        record: pending,
        replies: snapshotReplies(replies),
      };
    }
  }

  if (!extracted || !conversation.driverId) {
    const assist = matchDriverAssist(text);
    if (assist && canSendProactive(state, conversation.id, conversation.driverId, now)) {
      return {
        decision: "assisted",
        duplicate: false,
        message: stored,
        replies: snapshotReplies([pushReply(state, conversation.id, assist)]),
      };
    }
    const replies = considerResume(state, conversation.id, { now: () => now });
    return {
      decision: "ignored",
      duplicate: false,
      message: stored,
      replies: snapshotReplies(replies),
    };
  }

  const record: OperationalRecord = {
    id: `reg-${inbound.externalId}`,
    kind: extracted.kind,
    driverId: conversation.driverId,
    status: "incompleto",
    sourceMessageIds: [inbound.externalId],
    missing: [],
    abastecimento: extracted.abastecimento,
    despesa: extracted.despesa,
    viagem: extracted.viagem,
  };
  record.missing = missingFields(record);
  record.status = record.missing.length === 0 ? "completo" : "incompleto";
  state.records.push(record);
  clearDeferral(state, conversation.id);

  const replies: BotReply[] = [];
  if (
    record.status === "incompleto" &&
    canSendProactive(state, conversation.id, conversation.driverId, now)
  ) {
    replies.push(pushReply(state, conversation.id, questionForMissing(record.kind, record.missing)));
  }

  return {
    decision: record.status === "completo" ? "record_created" : "record_incomplete",
    duplicate: false,
    message: stored,
    record,
    replies: snapshotReplies(replies),
  };
}

function detectsKind(text: string): boolean {
  return Boolean(extractFromText(text, new Date(), undefined));
}

function handleCentral(state: AppState, stored: StoredMessage, now: Date): ProcessResult {
  const allowed = resolveAuthorRole(state, stored.authorId) === "alana";

  if (!allowed) {
    const command = {
      id: `cmd-${stored.externalId}`,
      messageId: stored.externalId,
      interpretation: "tentativa de comando por não-admin",
      status: "recusada" as const,
      detail: "Somente a Alana pode aplicar comandos na central.",
    };
    state.commands.push(command);
    return {
      decision: "command_refused",
      duplicate: false,
      message: stored,
      command,
      replies: [],
    };
  }

  const parsed = parseCentralCommand(stored.text ?? "");

  if (parsed.type === "none") {
    const assist = matchCentralAssist(stored.text ?? "");
    if (assist) {
      return {
        decision: "assisted",
        duplicate: false,
        message: stored,
        replies: snapshotReplies([pushReply(state, stored.conversationId, assist)]),
      };
    }
    return { decision: "ignored", duplicate: false, message: stored, replies: [] };
  }

  if (parsed.ambiguous) {
    const command = {
      id: `cmd-${stored.externalId}`,
      messageId: stored.externalId,
      interpretation: parsed.reason,
      status: "ambigua" as const,
      detail: parsed.reason,
    };
    state.commands.push(command);
    const reply = { conversationId: stored.conversationId, text: parsed.reason };
    state.botReplies.push(reply);
    return {
      decision: "command_ambiguous",
      duplicate: false,
      message: stored,
      command,
      replies: [reply],
    };
  }

  if (parsed.type === "list") {
    const active = state.suspensions.filter((s) =>
      isSuspensionCovering(s.start, s.end, now, s.status),
    );
    const text =
      active.length === 0
        ? "Nenhuma suspensão ativa."
        : active
            .map((s) => {
              const driver = state.drivers.find((d) => d.id === s.driverId);
              return `${driver?.name ?? s.driverId}: ${s.start} até ${s.end}`;
            })
            .join("; ");
    const command = {
      id: `cmd-${stored.externalId}`,
      messageId: stored.externalId,
      interpretation: "listar suspensões",
      status: "aplicada" as const,
      detail: text,
    };
    state.commands.push(command);
    const reply = { conversationId: stored.conversationId, text };
    state.botReplies.push(reply);
    return {
      decision: "command_applied",
      duplicate: false,
      message: stored,
      command,
      replies: [reply],
    };
  }

  const driver = findDriverByName(state, parsed.driverName);
  if (!driver) {
    const command = {
      id: `cmd-${stored.externalId}`,
      messageId: stored.externalId,
      interpretation: `motorista não encontrado: ${parsed.driverName}`,
      status: "ambigua" as const,
      detail: `Qual motorista? Não encontrei "${parsed.driverName}".`,
    };
    state.commands.push(command);
    const reply = { conversationId: stored.conversationId, text: command.detail };
    state.botReplies.push(reply);
    return {
      decision: "command_ambiguous",
      duplicate: false,
      message: stored,
      command,
      replies: [reply],
    };
  }

  const suspension = {
    id: `sus-${stored.externalId}`,
    driverId: driver.id,
    start: parsed.start,
    end: parsed.end,
    authorId: state.admin.id,
    status: "aplicada" as const,
    commandText: stored.text ?? "",
    messageId: stored.externalId,
  };
  state.suspensions.push(suspension);
  const command = {
    id: `cmd-${stored.externalId}`,
    messageId: stored.externalId,
    interpretation: `suspender ${driver.name} ${parsed.start}..${parsed.end}`,
    status: "aplicada" as const,
  };
  state.commands.push(command);
  const reply = {
    conversationId: stored.conversationId,
    text: `Suspensão aplicada: ${driver.name} de ${parsed.start} até ${parsed.end}.`,
  };
  state.botReplies.push(reply);
  return {
    decision: "command_applied",
    duplicate: false,
    message: stored,
    command,
    suspension,
    replies: [reply],
  };
}

export function considerResume(state: AppState, conversationId: string, clock: Clock): BotReply[] {
  if (state.deferrals.some((item) => item.conversationId === conversationId)) return [];
  const plan = planPendingResume(state, conversationId, clock);
  if (!plan.allowed) return [];
  const alreadySilent = state.botReplies.some(
    (reply) =>
      reply.silentResume &&
      reply.conversationId === plan.conversationId &&
      reply.text === plan.text,
  );
  if (alreadySilent) return [];
  const reply: BotReply = {
    conversationId: plan.conversationId,
    text: plan.text,
    silentResume: true,
  };
  state.botReplies.push(reply);
  return [reply];
}
