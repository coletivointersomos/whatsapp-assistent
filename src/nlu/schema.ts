import { mapPlannerFields } from "./plan.ts";
import { NLU_ACTIONS, NLU_INTENTS, defaultActionForIntent, unknownNlu, type NluActionName, type NluIntentName, type NluResult } from "./types.ts";

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

function sanitizeSummary(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "ok";
  return text.slice(0, 240);
}

function resolveAction(intent: NluIntentName, actionRaw: string): NluActionName {
  if (actionRaw === "block") {
    if (intent === "broadcast_request") return "block_broadcast";
    if (intent === "sheet_change_request") return "block_sheets";
    return "request_confirmation";
  }
  if (NLU_ACTIONS.includes(actionRaw as NluActionName)) return actionRaw as NluActionName;
  return defaultActionForIntent(intent);
}

export function validateNluResult(input: unknown): NluResult {
  const obj = typeof input === "string" ? parseJsonObject(input) : asRecord(input);
  if (!obj) return unknownNlu("invalid_json");

  const intentRaw = String(obj.intent ?? "");
  if (!NLU_INTENTS.includes(intentRaw as NluIntentName)) return unknownNlu("unknown_intent");
  const intent = intentRaw as NluIntentName;

  const action = resolveAction(intent, String(obj.action ?? ""));
  const confidence = Number(obj.confidence);
  const result: NluResult = {
    intent,
    action,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    reasoning_summary: sanitizeSummary(obj.reasoning_summary ?? obj.reason),
  };

  if (obj.fields && typeof obj.fields === "object" && !Array.isArray(obj.fields)) {
    const fields: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(obj.fields as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number") fields[key] = value;
    }
    const mapped = mapPlannerFields(fields);
    if (mapped) result.fields = mapped;
  }
  const recordTypeRaw = String(obj.record_type ?? obj.recordType ?? "");
  if (recordTypeRaw === "abastecimento" || recordTypeRaw === "despesa" || recordTypeRaw === "viagem") {
    result.recordType = recordTypeRaw;
  }
  if (typeof obj.target === "string" && obj.target.trim()) result.target = obj.target.trim();
  const targetId = obj.target_record_id ?? obj.targetRecordId;
  if (typeof targetId === "string" && targetId.trim()) result.targetRecordId = targetId.trim();
  if (typeof obj.reply === "string" && obj.reply.trim()) result.reply = obj.reply.trim();
  if (Array.isArray(obj.missing_fields)) {
    result.missingFields = obj.missing_fields.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  } else if (Array.isArray(obj.missingFields)) {
    result.missingFields = obj.missingFields.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  }
  if (typeof obj.is_complete === "boolean") result.isComplete = obj.is_complete;
  else if (typeof obj.isComplete === "boolean") result.isComplete = obj.isComplete;
  if (obj.requiresConfirmation === true) result.requiresConfirmation = true;
  if (typeof obj.unsafeReason === "string" && obj.unsafeReason.trim()) {
    result.unsafeReason = obj.unsafeReason.trim();
  }
  return result;
}
