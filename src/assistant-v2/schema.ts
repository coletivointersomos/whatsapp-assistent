import { normalizeCargoUnit } from "../domain/units.ts";
import {
  emptyAssistantV2,
  type AssistantV2Action,
  type AssistantV2RecordType,
  type AssistantV2Response,
} from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return asRecord(JSON.parse(trimmed.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || item === null) continue;
    if (key === "unit" && (typeof item === "string" || typeof item === "number")) {
      const unit = normalizeCargoUnit(item);
      if (unit) out.unit = unit;
      continue;
    }
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") out[key] = item;
  }
  return out;
}

function asRecordType(value: unknown): AssistantV2RecordType | undefined {
  const type = asString(value);
  if (type === "abastecimento" || type === "despesa" || type === "viagem") return type;
  return undefined;
}

function parseAction(raw: unknown): AssistantV2Action | undefined {
  const obj = asRecord(raw);
  if (!obj) return undefined;
  const type = asString(obj.type);
  if (type === "record.create") {
    const recordType = asRecordType(obj.recordType ?? obj.record_type);
    if (!recordType) return undefined;
    return { type, recordType, fields: asFields(obj.fields) };
  }
  if (type === "record.update") {
    return {
      type,
      recordId: asString(obj.recordId) ?? asString(obj.record_id),
      recordType: asRecordType(obj.recordType ?? obj.record_type),
      fields: asFields(obj.fields),
    };
  }
  if (type === "status.create") {
    const text = asString(obj.text);
    if (!text) return undefined;
    return { type, text, tripRecordId: asString(obj.tripRecordId) };
  }
  if (type === "summary.query") {
    const scopeRaw = asString(obj.scope) ?? "general";
    const scope =
      scopeRaw === "fuel" || scopeRaw === "expenses" || scopeRaw === "trips" || scopeRaw === "pending"
        ? scopeRaw
        : "general";
    return { type, scope };
  }
  if (type === "sheet.change.request") {
    return { type, description: asString(obj.description) ?? "alteração de planilha" };
  }
  if (type === "broadcast.request") {
    return { type, audience: asString(obj.audience) === "all" ? "all" : "drivers", text: asString(obj.text) ?? "" };
  }
  if (type === "ask_driver.request") {
    return { type, driverId: asString(obj.driverId), question: asString(obj.question) ?? "" };
  }
  return undefined;
}

export function parseAssistantV2Response(input: unknown): AssistantV2Response {
  const obj = typeof input === "string" ? parseJsonObject(input) : asRecord(input);
  if (!obj) return emptyAssistantV2("invalid_json");
  const message = asString(obj.message) ?? asString(obj.reply) ?? "";
  const confidence = Number(obj.confidence);
  const actions = Array.isArray(obj.actions)
    ? obj.actions.map(parseAction).filter((item): item is AssistantV2Action => Boolean(item))
    : [];
  return {
    message,
    actions,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    needsConfirmation: obj.needsConfirmation === true,
    notes: asString(obj.notes),
  };
}
