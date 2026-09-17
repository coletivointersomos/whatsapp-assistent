import {
  ABASTECIMENTO_REQUIRED,
  DESPESA_REQUIRED,
  VIAGEM_REQUIRED,
} from "../domain/rules.ts";
import type {
  AppState,
  BotReply,
  InboundMessage,
  OperationalRecord,
  OperationalStatusUpdate,
  ProcessResult,
} from "../domain/types.ts";
import {
  approximateDateFollowup,
  confirmationForRecord,
  expenseDateFollowup,
  questionForMissing,
} from "../extraction/command.ts";
import { extractComplement, extractFromText } from "../extraction/extract.ts";
import { findCompatiblePending, isApproximateDatePhrase } from "../extraction/pending.ts";
import { lastTripForDriver } from "../nlu/status.ts";
import type { NluRecordType, NluResult } from "../nlu/types.ts";

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

/** LLM can suggest fields; numbers/dates only stick if the extractor also sees them in the text. */
function trustedFields(
  kind: NluRecordType,
  text: string,
  sentAt: Date,
  llmFields: Record<string, string | number> | undefined,
  vehicleHint?: string,
): Record<string, string | number> {
  const extracted = extractComplement(kind, text, sentAt, vehicleHint);
  const fromText = { ...(extracted.abastecimento ?? extracted.despesa ?? extracted.viagem ?? {}) };
  if (!llmFields) return fromText;
  for (const key of ["description", "place", "origin", "destination", "material", "payment", "note", "unit"] as const) {
    const suggested = llmFields[key];
    if (fromText[key] === undefined && typeof suggested === "string" && suggested.trim()) {
      fromText[key] = suggested.trim().slice(0, 80);
    }
  }
  return fromText;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveKind(nlu: NluResult, text: string, sentAt: Date): NluRecordType | undefined {
  if (nlu.recordType) return nlu.recordType;
  const extracted = extractFromText(text, sentAt);
  return extracted?.kind;
}

function findPending(
  state: AppState,
  conversation: { id: string; externalId: string; driverId?: string },
  nlu: NluResult,
  kind?: NluRecordType,
  description?: string,
): OperationalRecord | undefined {
  const target = nlu.targetRecordId ?? nlu.target;
  if (target) {
    const hit = state.records.find((r) => r.id === target && r.status === "incompleto");
    if (hit) return hit;
  }
  return findCompatiblePending(state, conversation, kind, description);
}

function pushReply(state: AppState, conversationId: string, text: string): BotReply {
  const reply = { conversationId, text };
  state.botReplies.push(reply);
  return reply;
}

function pickRecordReply(record: OperationalRecord, nluReply?: string): string {
  if (nluReply?.trim()) return nluReply.trim();
  if (record.status === "completo") return confirmationForRecord(record.kind, record);
  if (record.kind === "despesa" && record.missing.includes("date") && !record.missing.includes("amountBrl")) {
    return expenseDateFollowup(record.despesa?.description, record.despesa?.amountBrl, record.despesa?.payment);
  }
  return questionForMissing(record.kind, record.missing, {
    description: record.despesa?.description,
    amountBrl: record.despesa?.amountBrl,
    payment: record.despesa?.payment,
  });
}

function finishRecord(
  state: AppState,
  conversationId: string,
  inbound: InboundMessage,
  record: OperationalRecord,
  allowReply: boolean,
  nluReply?: string,
): ProcessResult {
  record.missing = missingFields(record);
  record.status = record.missing.length === 0 ? "completo" : "incompleto";
  if (!record.sourceMessageIds.includes(inbound.externalId)) {
    record.sourceMessageIds.push(inbound.externalId);
  }
  const replies: BotReply[] = [];
  if (allowReply) {
    replies.push(pushReply(state, conversationId, pickRecordReply(record, nluReply)));
  }
  return {
    decision: record.status === "completo" ? "record_created" : "record_incomplete",
    duplicate: false,
    replies,
    record,
  };
}

export function applyLlmInterpretation(input: {
  state: AppState;
  inbound: InboundMessage;
  conversation: { id: string; externalId: string; driverId?: string };
  nlu: NluResult;
  isAdmin: boolean;
  isDriver: boolean;
  allowReply: boolean;
  vehicleHint?: string;
}): ProcessResult | undefined {
  const { state, inbound, conversation, nlu, isAdmin, isDriver, allowReply, vehicleHint } = input;
  const text = inbound.text ?? "";
  const sentAt = new Date(inbound.sentAt);
  const action = nlu.action;

  if (action === "block_sheets" || action === "sheet_change_request" || nlu.intent === "sheet_change_request") {
    if (!isAdmin) return undefined;
    const reply =
      nlu.reply ??
      "Isso entra como solicitação de alteração da planilha. Não altero o Sheets real daqui; precisa confirmação.";
    return {
      decision: "assisted",
      duplicate: false,
      replies: allowReply ? [pushReply(state, conversation.id, reply)] : [],
    };
  }

  if (action === "block_broadcast" || action === "broadcast_request" || nlu.intent === "broadcast_request") {
    if (!isAdmin) return undefined;
    const reply =
      nlu.reply ??
      "Posso preparar um pedido, mas não envio mensagem em massa. Precisa confirmação e ativação explícita.";
    return {
      decision: "assisted",
      duplicate: false,
      replies: allowReply ? [pushReply(state, conversation.id, reply)] : [],
    };
  }

  if (action === "store_status_update" || nlu.intent === "driver_status_update") {
    if (!isDriver) return undefined;
    const body = String(nlu.fields?.text ?? text).trim();
    if (!body) return undefined;
    if (!state.statusUpdates) state.statusUpdates = [];
    const trip = lastTripForDriver(state, conversation.driverId);
    const update: OperationalStatusUpdate = {
      id: `st-${inbound.externalId}`,
      conversationId: conversation.id,
      driverId: conversation.driverId,
      tripRecordId: trip?.id,
      text: body,
      sentAt: inbound.sentAt,
      sourceMessageId: inbound.externalId,
    };
    state.statusUpdates.push(update);
    const reply = nlu.reply ?? (trip ? `Anotei sua atualização na viagem ${trip.viagem?.origin ?? ""} → ${trip.viagem?.destination ?? ""}.`.replace(" → .", ".") : "Anotei sua atualização operacional da viagem.");
    return {
      decision: "assisted",
      duplicate: false,
      replies: allowReply ? [pushReply(state, conversation.id, reply)] : [],
    };
  }

  const kindGuess = resolveKind(nlu, text, sentAt) ?? (isApproximateDatePhrase(text) ? "despesa" : undefined);
  const descriptionGuess =
    asText(nlu.fields?.description) ?? asText(extractFromText(text, sentAt, vehicleHint)?.despesa?.description);
  const pending = findPending(state, conversation, nlu, kindGuess, descriptionGuess);

  if (isDriver && pending?.kind === "despesa" && isApproximateDatePhrase(text)) {
    pending.missing = missingFields(pending);
    if (pending.missing.includes("date")) {
      pending.despesa ??= {};
      pending.despesa.note = `data aproximada: ${text.trim().slice(0, 80)}`;
      if (!pending.sourceMessageIds.includes(inbound.externalId)) {
        pending.sourceMessageIds.push(inbound.externalId);
      }
      const reply = nlu.reply?.trim() || approximateDateFollowup(pending.despesa.description);
      return {
        decision: "record_incomplete",
        duplicate: false,
        replies: allowReply ? [pushReply(state, conversation.id, reply)] : [],
        record: pending,
      };
    }
  }

  const recordActions = new Set(["create_record", "update_record", "complete_record"]);
  const extractedKind = extractFromText(text, sentAt, vehicleHint)?.kind;
  if (
    recordActions.has(action) ||
    nlu.intent === "record_event" ||
    nlu.intent === "complete_record" ||
    (isDriver && extractedKind && (action === "reply" || action === "answer_question"))
  ) {
    if (!isDriver || !conversation.driverId) return undefined;
    const kind = resolveKind(nlu, text, sentAt) ?? extractedKind;
    if (!kind) return undefined;
    const fields = trustedFields(kind, text, sentAt, nlu.fields, vehicleHint);
    const open =
      pending?.kind === kind
        ? pending
        : findPending(state, conversation, nlu, kind, asText(fields.description) ?? descriptionGuess);
    const updating =
      open &&
      (action === "update_record" ||
        action === "complete_record" ||
        nlu.intent === "complete_record" ||
        open.kind === kind ||
        action === "reply" ||
        action === "answer_question");

    if (updating && open) {
      if (open.missing.length === 0) open.missing = missingFields(open);
      applyComplement(open, fields);
      return finishRecord(state, conversation.id, inbound, open, allowReply, nlu.reply);
    }

    const record: OperationalRecord = {
      id: `reg-${inbound.externalId}`,
      kind,
      driverId: conversation.driverId,
      status: "incompleto",
      sourceMessageIds: [inbound.externalId],
      missing: [],
      abastecimento: kind === "abastecimento" ? fields : undefined,
      despesa: kind === "despesa" ? fields : undefined,
      viagem: kind === "viagem" ? fields : undefined,
    };
    record.missing = missingFields(record);
    record.status = record.missing.length === 0 ? "completo" : "incompleto";
    state.records.push(record);
    return finishRecord(state, conversation.id, inbound, record, allowReply, nlu.reply);
  }

  if (
    action === "answer_question" ||
    action === "sheet_summary" ||
    action === "reply" ||
    action === "ask_driver_followup" ||
    action === "request_confirmation"
  ) {
    if (!nlu.reply) return undefined;
    if ((action === "ask_driver_followup" || nlu.intent === "ask_driver_followup") && !isAdmin) return undefined;
    return {
      decision: "assisted",
      duplicate: false,
      replies: allowReply ? [pushReply(state, conversation.id, nlu.reply)] : [],
    };
  }

  return undefined;
}
