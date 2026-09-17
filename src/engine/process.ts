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
  OperationalStatusUpdate,
  ProcessResult,
  StoredMessage,
} from "../domain/types.ts";
import { confirmationForRecord, approximateDateFollowup, expenseDateFollowup, parseCentralCommand, questionForMissing } from "../extraction/command.ts";
import { matchCentralAssist, matchDriverAssist } from "../extraction/assist.ts";
import {
  extractFromText,
  extractPendingFill,
  isDeferral,
  isNewOperationalEvent,
  looksLikeAdminCommand,
} from "../extraction/extract.ts";
import { findCompatiblePending, isApproximateDatePhrase, looksLikeBotPauseRequest } from "../extraction/pending.ts";
import { nluRejectReason, safeNluLogFields } from "../nlu/audit.ts";
import { buildNluContext } from "../nlu/context.ts";
import { createFakeProvider } from "../nlu/fakeProvider.ts";
import { gateSensitiveIntent } from "../nlu/gate.ts";
import { lastTripForDriver } from "../nlu/status.ts";
import { isUsableLlmResult, unknownNlu, type NluAuthorRole, type NluProvider, type NluResult } from "../nlu/types.ts";
import { applyLlmInterpretation } from "./nluExecute.ts";
import { planPendingResume } from "./resume.ts";

export type Clock = {
  now: () => Date;
  nluEnabled?: boolean;
  nlu?: NluProvider;
  nluFirst?: boolean;
  nluLog?: (event: string, fields: Record<string, unknown>) => void;
};

function resolveLocalNlu(clock: Clock): NluProvider | undefined {
  if (clock.nluEnabled === false) return undefined;
  return clock.nlu ?? createFakeProvider();
}

function interpretSync(nlu: NluProvider | undefined, ctx: Parameters<NluProvider["interpret"]>[0]): NluResult | undefined {
  if (!nlu) return undefined;
  const out = nlu.interpret(ctx);
  if (out && typeof (out as Promise<NluResult>).then === "function") return undefined;
  return out as NluResult;
}

function interpretLocal(
  state: AppState,
  inbound: InboundMessage,
  opts: {
    authorRole: NluAuthorRole;
    isAdmin: boolean;
    now: Date;
    driverId?: string;
    pending?: OperationalRecord;
    clock: Clock;
  },
): NluResult | undefined {
  const nlu = resolveLocalNlu(opts.clock);
  if (!nlu) return undefined;
  const ctx = buildNluContext(state, inbound, {
    authorRole: opts.authorRole,
    isAdmin: opts.isAdmin,
    now: opts.now,
    driverId: opts.driverId,
  });
  const raw = interpretSync(nlu, ctx);
  if (!raw) return undefined;
  return gateSensitiveIntent(raw, opts.isAdmin);
}

function expenseHint(record: OperationalRecord | undefined) {
  return {
    description: record?.despesa?.description,
    amountBrl: record?.despesa?.amountBrl,
    payment: record?.despesa?.payment,
  };
}

function engineRecordReply(record: OperationalRecord): string {
  if (record.status === "completo") return confirmationForRecord(record.kind, record);
  if (record.kind === "despesa" && record.missing.includes("date") && !record.missing.includes("amountBrl")) {
    return expenseDateFollowup(record.despesa?.description, record.despesa?.amountBrl, record.despesa?.payment);
  }
  return questionForMissing(record.kind, record.missing, expenseHint(record));
}

function applyFirstNlu(
  state: AppState,
  inbound: InboundMessage,
  conversation: { id: string; externalId: string; driverId?: string },
  nlu: NluResult | undefined,
  opts: {
    isAdmin: boolean;
    isDriver: boolean;
    allowReply: boolean;
    vehicleHint?: string;
    stored?: StoredMessage;
  },
): ProcessResult | undefined {
  if (!nlu || !isUsableLlmResult(nlu)) return undefined;
  const applied = applyLlmInterpretation({
    state,
    inbound,
    conversation,
    nlu,
    isAdmin: opts.isAdmin,
    isDriver: opts.isDriver,
    allowReply: opts.allowReply,
    vehicleHint: opts.vehicleHint,
  });
  if (!applied) return undefined;
  return { ...applied, message: opts.stored };
}

export async function processMessageAsync(
  state: AppState,
  inboundRaw: InboundMessage,
  clock: Clock,
): Promise<ProcessResult> {
  if (!clock.nluFirst || !clock.nlu) {
    return processMessage(state, inboundRaw, { ...clock, nluFirst: false });
  }

  const inbound = normalizeInbound(inboundRaw);
  const duplicate =
    state.messages.some((m) => m.externalId === inbound.externalId) ||
    state.rejected.some((r) => r.externalId === inbound.externalId);
  const conversation = state.conversations.find(
    (c) => c.active && (c.id === inbound.conversationId || c.externalId === inbound.conversationId),
  );
  const authorRole = conversation ? resolveAuthorRole(state, inbound.authorId) : "desconhecido";
  if (duplicate || !conversation || authorRole === "bot" || authorRole === "desconhecido") {
    return processMessage(state, inboundRaw, { ...clock, nluFirst: false });
  }

  const ctx = buildNluContext(state, inbound, {
    authorRole: authorRole === "alana" ? "alana" : authorRole === "motorista" ? "motorista" : "desconhecido",
    isAdmin: authorRole === "alana",
    now: clock.now(),
    driverId: conversation.driverId,
  });

  let interpreted: NluResult;
  try {
    interpreted = gateSensitiveIntent(
      await Promise.resolve(clock.nlu.interpret(ctx)),
      authorRole === "alana",
    );
  } catch {
    interpreted = unknownNlu("llm_failed");
  }

  const rejectReason = nluRejectReason(interpreted);
  const emit = clock.nluLog;
  emit?.("nlu_result", safeNluLogFields({
    provider: clock.nlu.name,
    result: interpreted,
    rejectReason,
    applied: !rejectReason,
  }));

  if (rejectReason) {
    emit?.("nlu_rejected", { rejectReason, provider: clock.nlu.name, intent: interpreted.intent, action: interpreted.action });
    return processMessage(state, inboundRaw, { ...clock, nluFirst: false, nlu: createFakeProvider() });
  }

  const cached: NluProvider = {
    name: clock.nlu.name,
    interpret: () => interpreted,
  };
  return processMessage(state, inboundRaw, {
    ...clock,
    nluFirst: true,
    nlu: cached,
    nluEnabled: true,
  });
}

function applyNluResult(
  state: AppState,
  conversation: { id: string; driverId?: string },
  inbound: InboundMessage,
  nlu: NluResult,
  allowReply: boolean,
): BotReply[] {
  if (nlu.intent === "driver_status_update" && nlu.action === "store_status_update") {
    const trip = lastTripForDriver(state, conversation.driverId);
    const text = String(nlu.fields?.text ?? inbound.text ?? "").trim();
    if (text) {
      if (!state.statusUpdates) state.statusUpdates = [];
      const update: OperationalStatusUpdate = {
        id: `st-${inbound.externalId}`,
        conversationId: conversation.id,
        driverId: conversation.driverId,
        tripRecordId: trip?.id,
        text,
        sentAt: inbound.sentAt,
        sourceMessageId: inbound.externalId,
      };
      state.statusUpdates.push(update);
    }
  }
  if (
    nlu.intent === "sheet_change_request" ||
    nlu.action === "block_sheets" ||
    nlu.intent === "broadcast_request" ||
    nlu.action === "block_broadcast"
  ) {
    // engine validates: reply only, never extra conversations / Sheets
  }
  if (allowReply && nlu.reply) {
    return [pushReply(state, conversation.id, nlu.reply)];
  }
  return [];
}

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
    return handleCentral(state, stored, now, clock);
  }

  if (authorRole === "alana") {
    const sentAt = new Date(inbound.sentAt);
    const pauseRequested = looksLikeBotPauseRequest(inbound.text ?? "");
    let pause: ConversationPause | undefined;
    if (pauseRequested) {
      pause = {
        conversationId: conversation.id,
        reason: "intervencao_alana",
        silenceUntil: new Date(sentAt.getTime() + PAUSE_MS).toISOString(),
        lastAlanaMessageId: inbound.externalId,
      };
      const idx = state.pauses.findIndex((p) => p.conversationId === conversation.id);
      if (idx >= 0) state.pauses[idx] = pause;
      else state.pauses.push(pause);
    }
    const nlu = interpretLocal(state, inbound, {
      authorRole: "alana",
      isAdmin: true,
      now,
      driverId: conversation.driverId,
      clock,
    });
    if (clock.nluFirst) {
      const applied = applyFirstNlu(state, inbound, conversation, nlu, {
        isAdmin: true,
        isDriver: false,
        allowReply: true,
        stored,
      });
      if (applied) {
        return { ...applied, pause };
      }
    }
    const replies = nlu ? applyNluResult(state, conversation, inbound, nlu, true) : [];
    return {
      decision: replies.length ? "assisted" : pauseRequested ? "pause_updated" : "ignored",
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
  const pending = extracted
    ? findCompatiblePending(
        state,
        conversation,
        extracted.kind,
        typeof extracted.despesa?.description === "string" ? extracted.despesa.description : undefined,
      )
    : isApproximateDatePhrase(text)
      ? (findCompatiblePending(state, conversation, "despesa") ?? findOpenIncomplete(state, conversation))
      : findOpenIncomplete(state, conversation);
  const allowReply = canSendProactive(state, conversation.id, conversation.driverId, now);

  if (clock.nluFirst) {
    const nlu = interpretLocal(state, inbound, {
      authorRole: "motorista",
      isAdmin: false,
      now,
      driverId: conversation.driverId,
      pending,
      clock,
    });
    const applied = applyFirstNlu(state, inbound, conversation, nlu, {
      isAdmin: false,
      isDriver: true,
      allowReply,
      vehicleHint: driver?.vehicleHint,
      stored,
    });
    if (applied) return applied;
    clock.nluLog?.("nlu_rejected", {
      rejectReason: "no_applicable_action",
      provider: clock.nlu?.name ?? "llm",
      intent: nlu?.intent ?? "unknown",
      action: nlu?.action ?? "none",
    });
  }

  if (pending?.kind === "despesa" && isApproximateDatePhrase(text)) {
    pending.despesa ??= {};
    pending.despesa.note = `data aproximada: ${text.trim().slice(0, 80)}`;
    if (!pending.sourceMessageIds.includes(inbound.externalId)) {
      pending.sourceMessageIds.push(inbound.externalId);
    }
    const replies: BotReply[] = allowReply
      ? [pushReply(state, conversation.id, approximateDateFollowup(pending.despesa.description))]
      : [];
    return {
      decision: "record_incomplete",
      duplicate: false,
      message: stored,
      record: pending,
      replies: snapshotReplies(replies),
    };
  }

  if (pending && !isNewOperationalEvent(extracted, pending.kind, pendingFields(pending))) {
    const incoming = extractPendingFill(
      pending.kind,
      pending.missing,
      text,
      sentAt,
      driver?.vehicleHint,
    );
    const filled = applyComplement(pending, incoming);
    if (filled.length > 0) {
      pending.sourceMessageIds.push(inbound.externalId);
      pending.missing = missingFields(pending);
      pending.status = pending.missing.length === 0 ? "completo" : "incompleto";
      clearDeferral(state, conversation.id);
      const replies: BotReply[] = [];
      if (canSendProactive(state, conversation.id, conversation.driverId, now)) {
        replies.push(pushReply(state, conversation.id, engineRecordReply(pending)));
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
    const nlu = interpretLocal(state, inbound, {
      authorRole: "motorista",
      isAdmin: false,
      now,
      driverId: conversation.driverId,
      pending,
      clock,
    });
    if (nlu && nlu.intent !== "unknown") {
      const allowReply = canSendProactive(state, conversation.id, conversation.driverId, now);
      const nluReplies = applyNluResult(state, conversation, inbound, nlu, allowReply);
      if (nlu.intent === "driver_status_update" || nluReplies.length) {
        return {
          decision: "assisted",
          duplicate: false,
          message: stored,
          record: pending,
          replies: snapshotReplies(nluReplies),
        };
      }
    }
    const replies = considerResume(state, conversation.id, { now: () => now });
    return {
      decision: "ignored",
      duplicate: false,
      message: stored,
      replies: snapshotReplies(replies),
    };
  }

  const compatible = findCompatiblePending(
    state,
    conversation,
    extracted.kind,
    typeof extracted.despesa?.description === "string" ? extracted.despesa.description : undefined,
  );
  if (
    compatible &&
    compatible.kind === extracted.kind &&
    !isNewOperationalEvent(extracted, compatible.kind, pendingFields(compatible))
  ) {
    const incoming = extracted.abastecimento ?? extracted.despesa ?? extracted.viagem ?? {};
    applyComplement(compatible, incoming);
    if (!compatible.sourceMessageIds.includes(inbound.externalId)) {
      compatible.sourceMessageIds.push(inbound.externalId);
    }
    compatible.missing = missingFields(compatible);
    compatible.status = compatible.missing.length === 0 ? "completo" : "incompleto";
    clearDeferral(state, conversation.id);
    const replies: BotReply[] = [];
    if (compatible.status === "incompleto" && canSendProactive(state, conversation.id, conversation.driverId, now)) {
      replies.push(pushReply(state, conversation.id, engineRecordReply(compatible)));
    } else if (compatible.status === "completo" && canSendProactive(state, conversation.id, conversation.driverId, now)) {
      replies.push(pushReply(state, conversation.id, engineRecordReply(compatible)));
    }
    return {
      decision: compatible.status === "completo" ? "record_created" : "record_incomplete",
      duplicate: false,
      message: stored,
      record: compatible,
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
    replies.push(pushReply(state, conversation.id, engineRecordReply(record)));
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

function handleCentral(
  state: AppState,
  stored: StoredMessage,
  now: Date,
  clock: Clock,
): ProcessResult {
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
    const nlu = interpretLocal(state, stored, {
      authorRole: "alana",
      isAdmin: true,
      now,
      clock,
    });
    if (clock.nluFirst) {
      const conversation = state.conversations.find((c) => c.id === stored.conversationId);
      const applied = applyFirstNlu(
        state,
        stored,
        conversation ?? { id: stored.conversationId, externalId: stored.conversationId },
        nlu,
        { isAdmin: true, isDriver: false, allowReply: true, stored },
      );
      if (applied) return applied;
    }
    const nluReplies = nlu ? applyNluResult(state, { id: stored.conversationId }, stored, nlu, true) : [];
    if (nluReplies.length) {
      return {
        decision: "assisted",
        duplicate: false,
        message: stored,
        replies: snapshotReplies(nluReplies),
      };
    }
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
