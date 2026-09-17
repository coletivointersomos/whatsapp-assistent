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

export function validateNluResult(input: unknown): NluResult {
  const obj = typeof input === "string" ? parseJsonObject(input) : asRecord(input);
  if (!obj) return unknownNlu("invalid_json");

  const intentRaw = String(obj.intent ?? "");
  if (!NLU_INTENTS.includes(intentRaw as NluIntentName)) return unknownNlu("unknown_intent");
  const intent = intentRaw as NluIntentName;

  const actionRaw = String(obj.action ?? "");
  const action: NluActionName = NLU_ACTIONS.includes(actionRaw as NluActionName)
    ? (actionRaw as NluActionName)
    : defaultActionForIntent(intent);

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
    if (Object.keys(fields).length) result.fields = fields;
  }
  const recordTypeRaw = String(obj.record_type ?? obj.recordType ?? "");
  if (recordTypeRaw === "abastecimento" || recordTypeRaw === "despesa" || recordTypeRaw === "viagem") {
    result.recordType = recordTypeRaw;
  }
  if (typeof obj.target === "string" && obj.target.trim()) result.target = obj.target.trim();
  const targetId = obj.target_record_id ?? obj.targetRecordId;
  if (typeof targetId === "string" && targetId.trim()) result.targetRecordId = targetId.trim();
  if (typeof obj.reply === "string" && obj.reply.trim()) result.reply = obj.reply.trim();
  if (obj.requiresConfirmation === true) result.requiresConfirmation = true;
  if (typeof obj.unsafeReason === "string" && obj.unsafeReason.trim()) {
    result.unsafeReason = obj.unsafeReason.trim();
  }
  return result;
}
