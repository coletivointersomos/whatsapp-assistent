import type { AppState, OperationalRecord, RecordKind } from "../domain/types.ts";

function fold(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function inConversation(
  state: AppState,
  record: OperationalRecord,
  conversation: { id: string; externalId: string },
): boolean {
  return record.sourceMessageIds.some((id) => {
    const message = state.messages.find((item) => item.externalId === id);
    if (!message) return false;
    return (
      message.conversationId === conversation.id || message.conversationId === conversation.externalId
    );
  });
}

export function descriptionsSimilar(a: string | undefined, b: string | undefined): boolean {
  const left = fold(a ?? "");
  const right = fold(b ?? "");
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/** Pendência aberta do mesmo tipo (e descrição, se despesa) na mesma conversa. */
export function findCompatiblePending(
  state: AppState,
  conversation: { id: string; externalId: string; driverId?: string },
  kind?: RecordKind,
  description?: string,
): OperationalRecord | undefined {
  if (!conversation.driverId) return undefined;
  const matches = state.records.filter((record) => {
    if (record.status !== "incompleto" || record.driverId !== conversation.driverId) return false;
    if (kind && record.kind !== kind) return false;
    return inConversation(state, record, conversation);
  });
  if (kind === "despesa" && description) {
    const named = matches.filter((record) => descriptionsSimilar(record.despesa?.description, description));
    if (named.length) return named[named.length - 1];
  }
  return matches[matches.length - 1];
}

export function isApproximateDatePhrase(text: string): boolean {
  const n = fold(text);
  if (!n) return false;
  return (
    /\boutro dia\b/.test(n) ||
    /\bsemana passada\b/.test(n) ||
    /\bfaz uns dias\b/.test(n) ||
    /\bunh?a?s dias\b/.test(n) ||
    /\bdias atras\b/.test(n)
  );
}

export function looksLikeBotPauseRequest(text: string): boolean {
  const n = fold(text);
  return (
    /\bdeixa comigo\b/.test(n) ||
    /\bpausa(r)? o bot\b/.test(n) ||
    /\bnao responde agora\b/.test(n) ||
    /\bvou falar com ele\b/.test(n) ||
    /\bestou falando com (ele|o motorista)\b/.test(n) ||
    /\bja estou falando com (ele|o motorista)\b/.test(n) ||
    /\bpara de responder\b/.test(n)
  );
}
