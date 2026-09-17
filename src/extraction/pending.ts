import type { AppState, OperationalRecord, RecordKind } from "../domain/types.ts";

export const ACTIVE_PENDING_MS = 30 * 60 * 1000;

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

export function recordLastActivity(state: AppState, record: OperationalRecord): Date | undefined {
  let latest: Date | undefined;
  for (const id of record.sourceMessageIds) {
    const message = state.messages.find((item) => item.externalId === id);
    if (!message) continue;
    const at = new Date(message.sentAt);
    if (!Number.isNaN(at.getTime()) && (!latest || at > latest)) latest = at;
  }
  return latest;
}

export function isArchivedForDemo(record: OperationalRecord): boolean {
  return Boolean(record.archivedForDemo);
}

export function isBeforeDemoCutoff(state: AppState, record: OperationalRecord): boolean {
  const demo = state.demoSession;
  if (!demo?.startedAt) return false;
  const last = recordLastActivity(state, record);
  if (!last) return true;
  return last.getTime() < Date.parse(demo.startedAt);
}

export function isActivePending(
  state: AppState,
  record: OperationalRecord,
  now: Date,
  maxAgeMs = ACTIVE_PENDING_MS,
): boolean {
  if (record.status !== "incompleto" || isArchivedForDemo(record) || isBeforeDemoCutoff(state, record)) {
    return false;
  }
  const last = recordLastActivity(state, record);
  if (!last) return false;
  return now.getTime() - last.getTime() <= maxAgeMs;
}

export type PendingMatchOpts = {
  now?: Date;
  maxAgeMs?: number;
  /** When true (default if `now` is set), ignore stale/archived pendings. */
  activeOnly?: boolean;
};

/** Pendência aberta do mesmo tipo (e descrição, se despesa) na mesma conversa. */
export function findCompatiblePending(
  state: AppState,
  conversation: { id: string; externalId: string; driverId?: string },
  kind?: RecordKind,
  description?: string,
  opts: PendingMatchOpts = {},
): OperationalRecord | undefined {
  if (!conversation.driverId) return undefined;
  const activeOnly = opts.activeOnly ?? Boolean(opts.now);
  const matches = state.records.filter((record) => {
    if (record.status !== "incompleto" || record.driverId !== conversation.driverId) return false;
    if (kind && record.kind !== kind) return false;
    if (!inConversation(state, record, conversation)) return false;
    if (activeOnly && opts.now && !isActivePending(state, record, opts.now, opts.maxAgeMs)) return false;
    if (activeOnly && isArchivedForDemo(record)) return false;
    return true;
  });
  if (kind === "despesa" && description) {
    const named = matches.filter((record) => descriptionsSimilar(record.despesa?.description, description));
    if (named.length) return named[named.length - 1];
  }
  return matches[matches.length - 1];
}

export function looksLikeNewOperationalEvent(text: string): boolean {
  const n = fold(text);
  if (!n) return false;
  if (/\bnova viagem\b/.test(n) || /\bfiz (uma )?viagem\b/.test(n)) return true;
  if (/\bviagem de\b/.test(n) && /\b(para|pra)\b/.test(n)) return true;
  if (/\babasteci\b/.test(n)) return true;
  if (/\bnova despesa\b/.test(n)) return true;
  if (/\bteve (um )?gasto\b/.test(n) || /\bgasto extra\b/.test(n)) return true;
  if (/\bgastei\b/.test(n)) return true;
  return false;
}

export function looksLikeComplementOnly(text: string): boolean {
  if (looksLikeNewOperationalEvent(text)) return false;
  const n = fold(text);
  if (!n || n.length > 120) return false;
  if (/\b(onde|quem e voce|o que voce|como assim)\b/.test(n)) return false;
  if (/\b(estou|parei|cheguei|descarregando)\b/.test(n)) return false;
  if (isApproximateDatePhrase(text)) return true;
  if (/^(hoje|ontem)(\b.*)?$/.test(n) && n.split(/\s+/).length <= 10) return true;
  if (/\bposto\b/.test(n) && n.split(/\s+/).length <= 10) return true;
  if (/^\d+([.,]\d+)?(\s+(no\s+)?(pix|pago|paga|assinada))?$/.test(n)) return true;
  if (/\b\d+([.,]\d+)?\b/.test(n) && /\b(pix|pago|paga|assinada)\b/.test(n) && !/\bteve\b/.test(n)) {
    return true;
  }
  if (/^(foi\s+)?(pago|paga|assinada|pix)$/.test(n)) return true;
  if (/^\d+([.,]\d+)?\s*(m3|m³|toneladas?|t|kg)$/.test(n)) return true;
  if (/^(soja|milho|algodao|farelo|arroz)$/.test(n)) return true;
  if (/\beletricista\b/.test(n) && /\b\d+/.test(n) && !/\bteve\b/.test(n) && !/\bgastei\b/.test(n)) {
    return true;
  }
  if (n.split(/\s+/).length <= 5 && !/\b(viagem|abastec|despesa|gastei|nova|frete)\b/.test(n)) {
    return true;
  }
  return false;
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

export function pendingAgeLabel(state: AppState, record: OperationalRecord, now: Date): string {
  const last = recordLastActivity(state, record);
  if (!last) return "idade desconhecida";
  const mins = Math.max(0, Math.round((now.getTime() - last.getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return `${hours} h`;
}
