import { normalizeCargoUnit } from "../domain/units.ts";
import { emptyAssistant, type AssistantAction, type AssistantRecordType, type AssistantResponse } from "./types.ts";

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

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function parseAction(raw: unknown): AssistantAction | undefined {
  const obj = asRecord(raw);
  if (!obj) return undefined;
  const type = asString(obj.type);
  if (type === "record.create") {
    const recordType = asString(obj.recordType) ?? asString(obj.record_type);
    if (recordType !== "abastecimento" && recordType !== "despesa" && recordType !== "viagem") return undefined;
    return {
      type,
      recordType: recordType as AssistantRecordType,
      fields: asFields(obj.fields),
      missingFields: asStringList(obj.missingFields ?? obj.missing_fields),
    };
  }
  if (type === "record.update") {
    const recordId = asString(obj.recordId) ?? asString(obj.record_id);
    if (!recordId) return undefined;
    return {
      type,
      recordId,
      fields: asFields(obj.fields),
      missingFields: asStringList(obj.missingFields ?? obj.missing_fields),
    };
  }
  if (type === "status.create") {
    const text = asString(obj.text);
    if (!text) return undefined;
    return {
      type,
      text,
      driverId: asString(obj.driverId),
      tripRecordId: asString(obj.tripRecordId),
    };
  }
  if (type === "summary.query") {
    const scopeRaw = asString(obj.scope) ?? "general";
    const scope =
      scopeRaw === "fuel" || scopeRaw === "expenses" || scopeRaw === "trips" || scopeRaw === "pending"
        ? scopeRaw
        : "general";
    return { type, scope, period: asString(obj.period) };
  }
  if (type === "sheet.change.request") {
    return { type, description: asString(obj.description) ?? "alteração de planilha" };
  }
  if (type === "broadcast.request") {
    const audience = asString(obj.audience) === "all" ? "all" : "drivers";
    return { type, audience, text: asString(obj.text) ?? "" };
  }
  if (type === "ask_driver.request") {
    return {
      type,
      driverId: asString(obj.driverId),
      question: asString(obj.question) ?? "",
    };
  }
  return undefined;
}

export function parseAssistantResponse(input: unknown): AssistantResponse {
  const obj = typeof input === "string" ? parseJsonObject(input) : asRecord(input);
  if (!obj) return emptyAssistant("invalid_json");
  const message = asString(obj.message) ?? asString(obj.reply) ?? "";
  const confidence = Number(obj.confidence);
  const actions = Array.isArray(obj.actions)
    ? obj.actions.map(parseAction).filter((item): item is AssistantAction => Boolean(item))
    : [];
  return {
    message,
    actions,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    needsConfirmation: obj.needsConfirmation === true,
    notes: asString(obj.notes),
  };
}
