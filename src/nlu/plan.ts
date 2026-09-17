import { ABASTECIMENTO_REQUIRED, DESPESA_REQUIRED, VIAGEM_REQUIRED } from "../domain/rules.ts";
import type { OperationalRecord } from "../domain/types.ts";
import { normalizeCargoUnit } from "../domain/units.ts";
import { confirmationForRecord, questionForMissing } from "../extraction/command.ts";
import type { NluRecordType, NluResult } from "./types.ts";

export function looksLikeClosingConfirmation(reply: string): boolean {
  const t = reply.trim();
  if (!t) return false;
  if (t.includes("?")) return false;
  const n = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  return (
    /\bfechado\b/.test(n) ||
    /\bregistrei\b/.test(n) ||
    /\bviagem registrada\b/.test(n) ||
    /\bdespesa registrada\b/.test(n) ||
    /\babastecimento registrado\b/.test(n)
  );
}

export function looksLikeFollowupQuestion(reply: string): boolean {
  const t = reply.trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  const n = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  return /\b(informe|qual foi|quais foram|por favor|unidade da carga|o que falt)\b/.test(n);
}

function replyAsksAlreadyFilled(reply: string, missing: string[]): boolean {
  if (!reply.trim()) return false;
  const n = reply
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (/\bunidade\b/.test(n) && !missing.includes("unit")) return true;
  if (/\b(material|carga)\b/.test(n) && !missing.includes("material") && !missing.includes("quantity")) {
    return true;
  }
  return false;
}

export function requiredKeysForKind(kind: NluRecordType): readonly string[] {
  if (kind === "abastecimento") return ABASTECIMENTO_REQUIRED;
  if (kind === "despesa") return DESPESA_REQUIRED;
  return VIAGEM_REQUIRED;
}

export function domainMissingKeys(kind: NluRecordType, fields: Record<string, string | number> | undefined): string[] {
  const bucket = fields ?? {};
  return requiredKeysForKind(kind).filter((key) => {
    const value = bucket[key];
    return value === undefined || value === "";
  });
}

export function mapPlannerFields(raw: Record<string, string | number> | undefined): Record<string, string | number> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "amount_brl") {
      out.amountBrl = value;
      if (out.totalBrl === undefined) out.totalBrl = value;
      continue;
    }
    if (key === "status_text") {
      out.text = value;
      continue;
    }
    if (key === "approximate_date_text") {
      out.approximate_date_text = value;
      out.note = typeof value === "string" ? `data aproximada: ${value}` : value;
      continue;
    }
    if (key === "unit") {
      const unit = normalizeCargoUnit(value);
      if (unit) out.unit = unit;
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function recordHint(record: OperationalRecord) {
  return {
    description: record.despesa?.description,
    amountBrl: record.despesa?.amountBrl,
    payment: record.despesa?.payment,
    origin: record.viagem?.origin,
    destination: record.viagem?.destination,
  };
}

/** Engine validator: never confirm an incomplete record as closed; never ask for fields already filled. */
export function coercePlanForRecord(nlu: NluResult, record: OperationalRecord): NluResult {
  const next = { ...nlu };
  const missing = record.missing;
  const recordAction =
    next.action === "create_record" ||
    next.action === "update_record" ||
    next.action === "complete_record" ||
    next.intent === "record_event" ||
    next.intent === "complete_record";

  if (!recordAction) return next;

  if (missing.length > 0) {
    next.missingFields = missing;
    if (next.isComplete) {
      next.isComplete = false;
      next.planCorrection = next.planCorrection ?? "incomplete_marked_complete";
    } else {
      next.isComplete = false;
    }
    const reply = next.reply?.trim() ?? "";
    if (!reply || looksLikeClosingConfirmation(reply) || replyAsksAlreadyFilled(reply, missing)) {
      next.reply = questionForMissing(record.kind, missing, recordHint(record));
      next.planCorrection =
        next.planCorrection ??
        (replyAsksAlreadyFilled(reply, missing)
          ? "reply_asks_filled_fields"
          : reply
            ? "blocked_closing_reply"
            : "missing_reply_filled");
    }
  } else {
    next.isComplete = true;
    next.missingFields = [];
    const reply = next.reply?.trim() ?? "";
    if (!reply || looksLikeFollowupQuestion(reply)) {
      next.reply = confirmationForRecord(record.kind, record);
      next.planCorrection = next.planCorrection ?? (reply ? "blocked_followup_on_complete" : "missing_reply_filled");
    }
  }
  return next;
}

export function safePlanLogFields(nlu: NluResult): Record<string, unknown> {
  return {
    intent: nlu.intent,
    action: nlu.action,
    confidence: nlu.confidence,
    record_type: nlu.recordType ?? "",
    missing_fields: nlu.missingFields ?? [],
    is_complete: nlu.isComplete ?? null,
    hasReply: Boolean(nlu.reply?.trim()),
    field_keys: nlu.fields ? Object.keys(nlu.fields) : [],
    has_unit: nlu.fields?.unit !== undefined && nlu.fields.unit !== "",
  };
}
