import type { AppState, InboundMessage, OperationalRecord } from "../domain/types.ts";
import { extractFromText } from "../extraction/extract.ts";
import {
  findCompatiblePending,
  looksLikeComplementOnly,
  looksLikeNewOperationalEvent,
} from "../extraction/pending.ts";
import { CARGO_MATERIAL_QTY_RE, CARGO_QTY_UNIT_RE } from "../domain/units.ts";
import type { AssistantAction, AssistantRecordType } from "./types.ts";

export const MISSING_ACTION_RETRY =
  "Não consegui registrar isso com segurança. Pode repetir em uma frase?";
export const ALREADY_RECORDED_REPLY = "Já está registrado.";

function fold(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export function isConfirmationAck(text: string): boolean {
  const n = fold(text).replace(/[.!?]+$/g, "").trim();
  return /^(pode|pode sim|sim|ok|blz|isso|confirmo|registra|pode registrar|pode fechar|fechou|confirma)$/.test(
    n,
  );
}

function hasCargoHint(text: string): boolean {
  return Boolean(CARGO_MATERIAL_QTY_RE.test(text) || CARGO_QTY_UNIT_RE.test(text) || /\b(soja|milho|algodao|farelo|arroz)\b/i.test(text) && /\d/.test(text));
}

export function looksOperationalUserText(text: string, hasActivePending: boolean): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (looksLikeNewOperationalEvent(raw)) return true;
  if (/\bde\s+.+\s+(para|pra)\s+.+/i.test(raw)) return true;
  if (extractFromText(raw, new Date())) return true;
  if (hasCargoHint(raw)) return true;
  if (hasActivePending && (looksLikeComplementOnly(raw) || isConfirmationAck(raw))) return true;
  if (isConfirmationAck(raw)) return true;
  return false;
}

function recentDriverTexts(
  state: AppState,
  conversationId: string,
  currentExternalId: string,
): string[] {
  return state.messages
    .filter(
      (item) =>
        item.authorRole === "motorista" &&
        item.externalId !== currentExternalId &&
        (item.conversationId === conversationId || item.text) &&
        (item.conversationId === conversationId),
    )
    .map((item) => item.text ?? "")
    .filter((text) => text.trim());
}

export function activePendingForConversation(
  state: AppState,
  conversation: { id: string; externalId: string; driverId?: string },
  now: Date,
): OperationalRecord | undefined {
  return findCompatiblePending(state, conversation, undefined, undefined, { now, activeOnly: true });
}

export function workTextForFallback(
  text: string,
  previous: string[],
): string {
  if (isConfirmationAck(text)) {
    return previous.filter((item) => !isConfirmationAck(item)).slice(-2).join("\n");
  }
  if (!looksLikeNewOperationalEvent(text)) {
    const lastNew = [...previous].reverse().find((item) => looksLikeNewOperationalEvent(item));
    if (lastNew && (looksLikeComplementOnly(text) || hasCargoHint(text))) {
      return `${lastNew}\n${text}`;
    }
  }
  return text;
}

export function buildMissingActionFallback(input: {
  state: AppState;
  inbound: InboundMessage;
  conversation: { id: string; externalId: string; driverId?: string };
  now: Date;
}): { actions: AssistantAction[]; workText: string } {
  const text = input.inbound.text ?? "";
  const previous = recentDriverTexts(input.state, input.conversation.id, input.inbound.externalId);
  const workText = workTextForFallback(text, previous);
  const pending = activePendingForConversation(input.state, input.conversation, input.now);
  if (pending) {
    return {
      workText: workText || text,
      actions: [
        {
          type: "record.update",
          recordId: pending.id,
          fields: {},
          missingFields: pending.missing,
        },
      ],
    };
  }
  if (isConfirmationAck(text)) {
    const lastTrip = [...input.state.records]
      .reverse()
      .find((item) => item.driverId === input.conversation.driverId && item.kind === "viagem");
    if (lastTrip?.status === "completo") return { actions: [], workText: workText || text };
  }
  const extracted = extractFromText(workText || text, new Date(input.inbound.sentAt));
  if (extracted) {
    const fields = extracted.abastecimento ?? extracted.despesa ?? extracted.viagem ?? {};
    return {
      workText: workText || text,
      actions: [
        {
          type: "record.create",
          recordType: extracted.kind as AssistantRecordType,
          fields,
          missingFields: [],
        },
      ],
    };
  }
  return { actions: [], workText: workText || text };
}
