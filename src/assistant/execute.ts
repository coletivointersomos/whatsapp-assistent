import {
  ABASTECIMENTO_REQUIRED,
  DESPESA_REQUIRED,
  VIAGEM_REQUIRED,
  dayIso,
} from "../domain/rules.ts";
import type {
  AppState,
  InboundMessage,
  OperationalRecord,
  OperationalStatusUpdate,
  ProcessDecision,
} from "../domain/types.ts";
import { extractComplement } from "../extraction/extract.ts";
import {
  findCompatiblePending,
  isActivePending,
  looksLikeNewOperationalEvent,
} from "../extraction/pending.ts";
import { lastTripForDriver } from "../nlu/status.ts";
import { formatFuelToday, formatPendings, localTotals } from "../nlu/totals.ts";
import { normalizeCargoUnit } from "../domain/units.ts";
import type { AssistantAction, AssistantRecordType, AssistantResponse } from "./types.ts";

export type ActionOutcome = {
  applied: string[];
  blocked: Array<{ type: string; reason: string }>;
  record?: OperationalRecord;
  decision: ProcessDecision;
  statusCreated?: boolean;
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
  if (typeof out.amount_brl === "number") {
    out.amountBrl = out.amount_brl;
    if (out.totalBrl === undefined) out.totalBrl = out.amount_brl;
  }
  if (typeof out.unit === "string") {
    const unit = normalizeCargoUnit(out.unit);
    if (unit) out.unit = unit;
  }
  return out;
}

function mergeFields(
  kind: AssistantRecordType,
  text: string,
  sentAt: Date,
  llmFields: Record<string, unknown>,
  vehicleHint?: string,
): Record<string, string | number> {
  const extracted = extractComplement(kind, text, sentAt, vehicleHint);
  const fromText = { ...(extracted.abastecimento ?? extracted.despesa ?? extracted.viagem ?? {}) };
  if (kind === "viagem" && fromText.date === undefined) fromText.date = dayIso(sentAt);
  const suggested = asScalarMap(llmFields);
  for (const key of ["description", "place", "origin", "destination", "material", "payment", "note"] as const) {
    if (fromText[key] === undefined && typeof suggested[key] === "string") fromText[key] = suggested[key];
  }
  if (fromText.unit === undefined && typeof suggested.unit === "string") fromText.unit = suggested.unit;
  else if (fromText.unit !== undefined) {
    const unit = normalizeCargoUnit(String(fromText.unit));
    if (unit) fromText.unit = unit;
  }
  if (fromText.quantity === undefined && typeof suggested.quantity === "number" && text.includes(String(suggested.quantity))) {
    fromText.quantity = suggested.quantity;
  }
  if (fromText.liters === undefined && typeof suggested.liters === "number" && text.includes(String(suggested.liters))) {
    fromText.liters = suggested.liters;
  }
  if (fromText.amountBrl === undefined && typeof suggested.amountBrl === "number" && text.includes(String(suggested.amountBrl))) {
    fromText.amountBrl = suggested.amountBrl;
  }
  if (fromText.totalBrl === undefined && typeof suggested.totalBrl === "number" && text.includes(String(suggested.totalBrl))) {
    fromText.totalBrl = suggested.totalBrl;
  }
  if (fromText.date === undefined && typeof suggested.date === "string") fromText.date = suggested.date;
  if (fromText.note === undefined && typeof suggested.approximate_date_text === "string") {
    fromText.note = `data aproximada: ${suggested.approximate_date_text}`;
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

function attachSource(record: OperationalRecord, externalId: string) {
  if (!record.sourceMessageIds.includes(externalId)) record.sourceMessageIds.push(externalId);
}

export function executeAssistantActions(input: {
  state: AppState;
  inbound: InboundMessage;
  conversation: { id: string; externalId: string; driverId?: string };
  response: AssistantResponse;
  isAdmin: boolean;
  isDriver: boolean;
  now: Date;
  vehicleHint?: string;
}): ActionOutcome {
  const { state, inbound, conversation, response, isAdmin, isDriver, now, vehicleHint } = input;
  const text = inbound.text ?? "";
  const sentAt = new Date(inbound.sentAt);
  const applied: string[] = [];
  const blocked: Array<{ type: string; reason: string }> = [];
  let record: OperationalRecord | undefined;
  let decision: ProcessDecision = "assisted";
  let statusCreated = false;

  for (const action of response.actions) {
    if (action.type === "broadcast.request" || action.type === "sheet.change.request" || action.type === "ask_driver.request") {
      blocked.push({ type: action.type, reason: isAdmin ? "needs_confirmation" : "permission_denied" });
      continue;
    }

    if (action.type === "summary.query") {
      applied.push(action.type);
      continue;
    }

    if (action.type === "status.create") {
      if (!isDriver && !isAdmin) {
        blocked.push({ type: action.type, reason: "permission_denied" });
        continue;
      }
      if (!state.statusUpdates) state.statusUpdates = [];
      const trip = lastTripForDriver(state, conversation.driverId);
      const update: OperationalStatusUpdate = {
        id: `st-${inbound.externalId}`,
        conversationId: conversation.id,
        driverId: action.driverId ?? conversation.driverId,
        tripRecordId: action.tripRecordId ?? trip?.id,
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
      if (!isDriver || !conversation.driverId) {
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
      if (!isDriver || !conversation.driverId) {
        blocked.push({ type: action.type, reason: "permission_denied" });
        continue;
      }
      const hit = state.records.find((item) => item.id === action.recordId && item.status === "incompleto");
      const kind = hit?.kind;
      const target =
        hit && isActivePending(state, hit, now)
          ? hit
          : looksLikeNewOperationalEvent(text)
            ? undefined
            : findCompatiblePending(state, conversation, kind, undefined, { now, activeOnly: true });
      if (!target) {
        blocked.push({ type: action.type, reason: "no_active_target" });
        continue;
      }
      const fields = mergeFields(target.kind, text, sentAt, action.fields, vehicleHint);
      applyInto(target, fields);
      attachSource(target, inbound.externalId);
      record = target;
      decision = target.status === "completo" ? "record_created" : "record_incomplete";
      applied.push(action.type);
    }
  }

  return { applied, blocked, record, decision, statusCreated };
}

export function localSummaryFallback(state: AppState, scope: string, now: Date): string {
  const date = dayIso(now);
  const totals = localTotals(state, { date });
  if (scope === "fuel") return formatFuelToday(totals, date);
  if (scope === "pending") return formatPendings(totals);
  return formatFuelToday(
    { ...totals, combinedBrl: totals.fuelBrl + totals.expenseBrl },
    date,
  );
}
