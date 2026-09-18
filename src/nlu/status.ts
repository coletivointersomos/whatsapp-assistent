import type { AppState, OperationalRecord, OperationalStatusUpdate } from "../domain/types.ts";
import { isArchivedForDemo, isBeforeDemoCutoff } from "../extraction/pending.ts";

export function lastTripForDriver(
  state: AppState,
  driverId: string | undefined,
): OperationalRecord | undefined {
  if (!driverId) return undefined;
  const trips = state.records.filter(
    (r) =>
      r.kind === "viagem" &&
      r.driverId === driverId &&
      !isArchivedForDemo(r) &&
      !isBeforeDemoCutoff(state, r),
  );
  return trips[trips.length - 1];
}

export function lastStatusForConversation(
  state: AppState,
  conversationId: string,
): OperationalStatusUpdate | undefined {
  const updates = (state.statusUpdates ?? []).filter((u) => u.conversationId === conversationId);
  return updates[updates.length - 1];
}

export function lastBotText(state: AppState, conversationId: string): string | undefined {
  const replies = state.botReplies.filter((r) => r.conversationId === conversationId);
  const last = replies[replies.length - 1];
  return last?.text;
}
