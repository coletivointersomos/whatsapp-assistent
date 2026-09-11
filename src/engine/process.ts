import { normalizeInbound } from "../adapters/inbound.ts";
import {
  ABASTECIMENTO_REQUIRED,
  DESPESA_REQUIRED,
  PAUSE_MS,
  VIAGEM_REQUIRED,
  isPauseActive,
  isSuspensionCovering,
} from "../domain/rules.ts";
import type {
  AppState,
  BotReply,
  ConversationPause,
  InboundMessage,
  OperationalRecord,
  ProcessResult,
  StoredMessage,
} from "../domain/types.ts";
import { parseCentralCommand, questionForMissing } from "../extraction/command.ts";
import {
  extractFromText,
  isDeferral,
  looksLikeAdminCommand,
} from "../extraction/extract.ts";

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

  const stored = { ...inbound, processedAt: now.toISOString() };
  state.messages.push(stored);

  if (conversation.role === "central") {
    return handleCentral(state, stored, now);
  }

  if (inbound.authorRole === "alana" || inbound.authorId === state.admin.id) {
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
    return { decision: "pause_updated", duplicate: false, message: stored, replies: [], pause };
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
    return { decision: "deferred", duplicate: false, message: stored, replies: [] };
  }

  if (inbound.type === "anexo_comprovante" && !detectsKind(text)) {
    return { decision: "attachment_stored", duplicate: false, message: stored, replies: [] };
  }

  if (!text) {
    return { decision: "ignored", duplicate: false, message: stored, replies: [] };
  }

  const driver = state.drivers.find((d) => d.id === conversation.driverId);
  const extracted = extractFromText(text, new Date(inbound.sentAt), driver?.vehicleHint);
  if (!extracted || !conversation.driverId) {
    return { decision: "ignored", duplicate: false, message: stored, replies: [] };
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

  const replies: BotReply[] = [];
  if (
    record.status === "incompleto" &&
    canSendProactive(state, conversation.id, conversation.driverId, now)
  ) {
    const reply = {
      conversationId: conversation.id,
      text: questionForMissing(record.kind, record.missing),
    };
    replies.push(reply);
    state.botReplies.push(reply);
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
  const allowed =
    stored.authorRole === "alana" || stored.authorId === state.admin.id;

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
  const now = clock.now();
  const conversation = state.conversations.find((c) => c.id === conversationId);
  if (!conversation?.driverId) return [];
  if (!canSendProactive(state, conversationId, conversation.driverId, now)) return [];

  const pending = [...state.records]
    .reverse()
    .find((r) => r.driverId === conversation.driverId && r.status === "incompleto");
  if (!pending) return [];

  const text = questionForMissing(pending.kind, pending.missing);
  const same = state.botReplies.some(
    (r) => r.conversationId === conversationId && r.text === text,
  );
  if (same) return [];

  const reply: BotReply = { conversationId, text, silentResume: true };
  state.botReplies.push(reply);
  return [reply];
}
