import {
  ABASTECIMENTO_REQUIRED,
  DESPESA_REQUIRED,
  VIAGEM_REQUIRED,
  dayIso,
} from "../domain/rules.ts";
import type {
  AppState,
  Conversation,
  InboundMessage,
  OperationalRecord,
  OperationalStatusUpdate,
  ProcessDecision,
} from "../domain/types.ts";
import { extractComplement } from "../extraction/extract.ts";
import { normalizeCargoUnit } from "../domain/units.ts";
import type { AssistantV2Action, AssistantV2RecordType, AssistantV2Response } from "./types.ts";
import { activeOfKind, lastSessionTrip, parseSessionStart, recordInCurrentSession, sessionRecords } from "./session.ts";

export type AssistantV2Outcome = {
  applied: string[];
  blocked: Array<{ type: string; reason: string }>;
  record?: OperationalRecord;
  decision: ProcessDecision;
  statusCreated?: boolean;
  summary?: string;
};

function missingOf(record: OperationalRecord): string[] {
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

function asScalarMap(fields: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 120);
  }
  if (typeof out.unit === "string") {
    const unit = normalizeCargoUnit(out.unit);
    if (unit) out.unit = unit;
  }
  return out;
}

function mergeFields(
  kind: AssistantV2RecordType,
  text: string,
  sentAt: Date,
  llmFields: Record<string, unknown>,
  vehicleHint?: string,
): Record<string, string | number> {
  const extracted = extractComplement(kind, text, sentAt, vehicleHint);
  const fromText = { ...(extracted.abastecimento ?? extracted.despesa ?? extracted.viagem ?? {}) };
  if (kind === "viagem" && fromText.date === undefined) fromText.date = dayIso(sentAt);
  const suggested = asScalarMap(llmFields);
  for (const key of Object.keys(suggested)) {
    if (fromText[key] === undefined || fromText[key] === "") fromText[key] = suggested[key];
  }
  if (typeof fromText.unit === "string") {
    const unit = normalizeCargoUnit(fromText.unit);
    if (unit) fromText.unit = unit;
  }
  return fromText;
}

function applyInto(record: OperationalRecord, incoming: Record<string, string | number>) {
  const bucket =
    record.kind === "abastecimento"
      ? (record.abastecimento ??= {})
      : record.kind === "despesa"
        ? (record.despesa ??= {})
        : (record.viagem ??= {});
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === "") continue;
    const current = (bucket as Record<string, string | number>)[key];
    if (current === undefined || current === "") (bucket as Record<string, string | number>)[key] = value;
  }
  record.missing = missingOf(record);
  record.status = record.missing.length === 0 ? "completo" : "incompleto";
}

export function executeAssistantV2Actions(input: {
  state: AppState;
  inbound: InboundMessage;
  conversation: Conversation;
  response: AssistantV2Response;
  isAdmin: boolean;
  isDriver: boolean;
  now: Date;
  sessionStartedAt?: string;
  vehicleHint?: string;
}): AssistantV2Outcome {
  const { state, inbound, conversation, response, sessionStartedAt, vehicleHint } = input;
  const text = inbound.text ?? "";
  const sentAt = new Date(inbound.sentAt);
  const sessionStartedAtMs = parseSessionStart(sessionStartedAt);
  const applied: string[] = [];
  const blocked: Array<{ type: string; reason: string }> = [];
  let record: OperationalRecord | undefined;
  let decision: ProcessDecision = "assisted";
  let statusCreated = false;
  let summary: string | undefined;
  const session = () => sessionRecords(state, conversation, sessionStartedAtMs);

  for (const action of response.actions) {
    if (action.type === "broadcast.request" || action.type === "sheet.change.request" || action.type === "ask_driver.request") {
      blocked.push({ type: action.type, reason: "needs_confirmation" });
      continue;
    }
    if (action.type === "summary.query") {
      applied.push(action.type);
      const records = session();
      const trip = lastSessionTrip(records);
      const lastStatus = [...(state.statusUpdates ?? [])]
        .reverse()
        .find((item) => item.conversationId === conversation.id || item.tripRecordId === trip?.id);
      if (action.scope === "pending") {
        const open = records.filter((item) => item.status === "incompleto");
        summary = open.length
          ? `Há ${open.length} pendência(s) na sessão atual.`
          : "Não há pendências na sessão atual.";
      } else if (trip) {
        const origin = trip.viagem?.origin ?? "?";
        const destination = trip.viagem?.destination ?? "?";
        summary = lastStatus
          ? `Viagem ${origin} → ${destination}. Última atualização: ${lastStatus.text}.`
          : `Viagem ativa da sessão: ${origin} → ${destination}.`;
      } else {
        summary = "Não há viagem na sessão atual.";
      }
      continue;
    }
    if (action.type === "status.create") {
      if (!state.statusUpdates) state.statusUpdates = [];
      const trip =
        (action.tripRecordId &&
          session().find((item) => item.id === action.tripRecordId && item.kind === "viagem")) ||
        lastSessionTrip(session());
      const update: OperationalStatusUpdate = {
        id: `st-${inbound.externalId}`,
        conversationId: conversation.id,
        driverId: conversation.driverId,
        tripRecordId: trip?.id,
        text: action.text,
        sentAt: inbound.sentAt,
        sourceMessageId: inbound.externalId,
      };
      state.statusUpdates.push(update);
      applied.push(action.type);
      statusCreated = true;
      continue;
    }
    if (action.type === "record.create") {
      if (!conversation.driverId) {
        blocked.push({ type: action.type, reason: "permission_denied" });
        continue;
      }
      const fields = mergeFields(action.recordType, text, sentAt, action.fields, vehicleHint);
      const created: OperationalRecord = {
        id: `reg-${inbound.externalId}`,
        kind: action.recordType,
        driverId: conversation.driverId,
        status: "incompleto",
        sourceMessageIds: [inbound.externalId],
        missing: [],
        abastecimento: action.recordType === "abastecimento" ? fields : undefined,
        despesa: action.recordType === "despesa" ? fields : undefined,
        viagem: action.recordType === "viagem" ? fields : undefined,
      };
      created.missing = missingOf(created);
      created.status = created.missing.length === 0 ? "completo" : "incompleto";
      state.records.push(created);
      record = created;
      decision = created.status === "completo" ? "record_created" : "record_incomplete";
      applied.push(action.type);
      continue;
    }
    if (action.type === "record.update") {
      if (!conversation.driverId) {
        blocked.push({ type: action.type, reason: "permission_denied" });
        continue;
      }
      const records = session();
      let target: OperationalRecord | undefined;
      if (action.recordId) {
        const hit = state.records.find((item) => item.id === action.recordId);
        if (hit && recordInCurrentSession(state, hit, conversation, sessionStartedAtMs)) target = hit;
      }
      if (!target) {
        const kind = action.recordType ?? (records.length === 1 ? records[0]?.kind : undefined);
        target = kind ? activeOfKind(records, kind) : undefined;
        if (!target && action.recordType === "viagem") target = activeOfKind(records, "viagem");
        if (!target && !action.recordType) {
          target =
            activeOfKind(records, "viagem") ??
            activeOfKind(records, "despesa") ??
            activeOfKind(records, "abastecimento");
        }
      }
      if (!target) {
        blocked.push({ type: action.type, reason: "no_session_target" });
        continue;
      }
      const fields = mergeFields(target.kind, text, sentAt, action.fields, vehicleHint);
      applyInto(target, fields);
      if (!target.sourceMessageIds.includes(inbound.externalId)) target.sourceMessageIds.push(inbound.externalId);
      record = target;
      decision = target.status === "completo" ? "record_created" : "record_incomplete";
      applied.push(action.type);
    }
  }

  return { applied, blocked, record, decision, statusCreated, summary };
}

export function formatSessionSummary(state: AppState, conversation: Conversation, sessionStartedAt?: string): string {
  const records = sessionRecords(state, conversation, parseSessionStart(sessionStartedAt));
  const trip = lastSessionTrip(records);
  if (!trip) return "Não há viagem na sessão atual.";
  const origin = trip.viagem?.origin ?? "?";
  const destination = trip.viagem?.destination ?? "?";
  const lastStatus = [...(state.statusUpdates ?? [])]
    .reverse()
    .find((item) => item.tripRecordId === trip.id || item.conversationId === conversation.id);
  if (lastStatus) return `Viagem ${origin} → ${destination}. Última atualização: ${lastStatus.text}.`;
  return `Viagem ativa da sessão: ${origin} → ${destination}.`;
}
