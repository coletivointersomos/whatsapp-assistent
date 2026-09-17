import { extractFromText } from "../extraction/extract.ts";
import { CARGO_MATERIAL_QTY_RE, CARGO_QTY_UNIT_RE } from "../domain/units.ts";
import type { AppState, Conversation, InboundMessage } from "../domain/types.ts";
import type { AssistantV2Action, AssistantV2RecordType } from "./types.ts";
import { activeOfKind, lastSessionTrip, parseSessionStart, sessionRecords } from "./session.ts";

export const V2_MISSING_ACTION_RETRY =
  "Não consegui registrar isso com segurança. Pode repetir em uma frase?";
export const V2_GREETING =
  "Opa, estou aqui. Pode me mandar abastecimento, despesa, viagem ou atualização da rota.";

export function looksOperationalV2(text: string, hasSessionPending: boolean): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (/\bviagem\b/i.test(raw)) return true;
  if (/\bde\s+.+\s+(para|pra)\s+.+/i.test(raw)) return true;
  if (/\babasteci\b/i.test(raw) || /\blitros?\b/i.test(raw)) return true;
  if (/\b(gastei|gasto|despesa)\b/i.test(raw)) return true;
  if (/\bm3\b/i.test(raw) || /m³/i.test(raw)) return true;
  if (CARGO_MATERIAL_QTY_RE.test(raw) || CARGO_QTY_UNIT_RE.test(raw)) return true;
  if (/\b(parei|cheguei|atrasou)\b/i.test(raw)) return true;
  if (hasSessionPending && /^(ontem|hoje|foi ontem|foi hoje)\b/i.test(raw)) return true;
  if (hasSessionPending && /\b\d+([.,]\d+)?\b/.test(raw) && /\b(pix|pago|assinada)\b/i.test(raw)) return true;
  return false;
}

export function looksLikeGreeting(text: string): boolean {
  return /^(al[oô]|oi|ola|olá|eai|e ai|bom dia|boa tarde|boa noite)[.!?]*$/i.test(text.trim());
}

export function buildV2FallbackActions(input: {
  state: AppState;
  inbound: InboundMessage;
  conversation: Conversation;
  sessionStartedAt?: string;
}): AssistantV2Action[] {
  const text = input.inbound.text ?? "";
  const records = sessionRecords(input.state, input.conversation, parseSessionStart(input.sessionStartedAt));
  if (/\b(parei|cheguei|atrasou)\b/i.test(text)) {
    const trip = lastSessionTrip(records);
    return [{ type: "status.create", text, tripRecordId: trip?.id }];
  }
  const extracted = extractFromText(text, new Date(input.inbound.sentAt));
  if (extracted) {
    const pending = activeOfKind(records, extracted.kind);
    const fields = extracted.abastecimento ?? extracted.despesa ?? extracted.viagem ?? {};
    if (pending) {
      return [{ type: "record.update", recordId: pending.id, recordType: extracted.kind, fields }];
    }
    return [{ type: "record.create", recordType: extracted.kind as AssistantV2RecordType, fields }];
  }
  const tripPending = activeOfKind(records, "viagem");
  if (tripPending && (CARGO_MATERIAL_QTY_RE.test(text) || CARGO_QTY_UNIT_RE.test(text) || /m³|\bm3\b/i.test(text))) {
    return [{ type: "record.update", recordId: tripPending.id, recordType: "viagem", fields: {} }];
  }
  const expensePending = activeOfKind(records, "despesa");
  if (expensePending) {
    if (/^(ontem|hoje|foi ontem|foi hoje)\b/i.test(text.trim()) || /\b\d+/.test(text)) {
      return [{ type: "record.update", recordId: expensePending.id, recordType: "despesa", fields: {} }];
    }
  }
  return [];
}
