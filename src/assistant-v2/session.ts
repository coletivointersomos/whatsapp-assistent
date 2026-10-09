import type { AppState, Conversation, OperationalRecord, OperationalStatusUpdate, StoredMessage } from "../domain/types.ts";
import type { AssistantV2RecordType, AssistantV2SessionRecord } from "./types.ts";

export function parseSessionStart(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function conversationKeys(conversation: Conversation): Set<string> {
  return new Set([conversation.id, conversation.externalId].filter(Boolean));
}

export function isAfterSessionStart(iso: string | undefined, sessionStartedAtMs: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  return ms >= sessionStartedAtMs;
}

export function sessionMessages(
  state: AppState,
  conversation: Conversation,
  sessionStartedAtMs: number,
): StoredMessage[] {
  const keys = conversationKeys(conversation);
  return state.messages.filter(
    (item) =>
      keys.has(item.conversationId) &&
      item.authorRole !== "bot" &&
      isAfterSessionStart(item.sentAt, sessionStartedAtMs),
  );
}

export function recordInCurrentSession(
  state: AppState,
  record: OperationalRecord,
  conversation: Conversation,
  sessionStartedAtMs: number,
): boolean {
  if (record.archivedForDemo) return false;
  const keys = conversationKeys(conversation);
  return record.sourceMessageIds.some((id) => {
    const message = state.messages.find((item) => item.externalId === id);
    if (!message || !keys.has(message.conversationId)) return false;
    return isAfterSessionStart(message.sentAt, sessionStartedAtMs);
  });
}

export function sessionRecords(
  state: AppState,
  conversation: Conversation,
  sessionStartedAtMs: number,
): OperationalRecord[] {
  return state.records.filter((record) => recordInCurrentSession(state, record, conversation, sessionStartedAtMs));
}

export function toSessionView(record: OperationalRecord): AssistantV2SessionRecord {
  return {
    recordId: record.id,
    kind: record.kind as AssistantV2RecordType,
    status: record.status,
    origin: record.viagem?.origin,
    destination: record.viagem?.destination,
    material: record.viagem?.material,
    quantity: record.viagem?.quantity,
    unit: record.viagem?.unit,
    description: record.despesa?.description,
    amountBrl: record.despesa?.amountBrl,
    payment: record.despesa?.payment,
    missing: record.missing,
  };
}

export function activeOfKind(
  records: OperationalRecord[],
  kind: AssistantV2RecordType,
): OperationalRecord | undefined {
  return [...records].reverse().find((item) => item.kind === kind && item.status === "incompleto");
}

export function lastSessionTrip(records: OperationalRecord[]): OperationalRecord | undefined {
  return [...records].reverse().find((item) => item.kind === "viagem");
}

export function lastSessionStatus(
  state: AppState,
  conversation: Conversation,
  sessionStartedAtMs: number,
  sessionTripIds: Set<string>,
): OperationalStatusUpdate | undefined {
  const keys = conversationKeys(conversation);
  return [...(state.statusUpdates ?? [])].reverse().find((item) => {
    if (!keys.has(item.conversationId)) return false;
    if (!isAfterSessionStart(item.sentAt, sessionStartedAtMs)) return false;
    if (item.tripRecordId && sessionTripIds.size && !sessionTripIds.has(item.tripRecordId)) return false;
    return true;
  });
}
