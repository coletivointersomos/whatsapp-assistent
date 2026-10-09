import { questionForMissing } from "../extraction/command.ts";
import { isActivePending } from "../extraction/pending.ts";
import { isPauseActive, isSuspensionCovering } from "../domain/rules.ts";
import type { AppState, Conversation, OperationalRecord } from "../domain/types.ts";

export type ResumeClock = { now: () => Date };

export const RESUME_PURPOSE = "resume_pending_question" as const;

export type ResumePlanReason =
  | "no_conversation"
  | "pause_active"
  | "no_pending"
  | "already_asked"
  | "suspended";

export type ResumePlan =
  | { allowed: false; reason: ResumePlanReason }
  | {
      allowed: true;
      conversationId: string;
      record: OperationalRecord;
      text: string;
      missingKey: string;
    };

export function missingKey(missing: string[]): string {
  return [...missing].sort().join(",");
}

function conversationPause(state: AppState, conversationId: string) {
  return state.pauses.find((p) => p.conversationId === conversationId);
}

function activeSuspension(state: AppState, driverId: string, now: Date) {
  return state.suspensions.find(
    (s) => isSuspensionCovering(s.start, s.end, now, s.status) && s.driverId === driverId,
  );
}

export function wasResumeAsked(
  state: AppState,
  conversationId: string,
  record: OperationalRecord,
): boolean {
  const key = missingKey(record.missing);
  return state.botReplies.some(
    (reply) =>
      reply.purpose === RESUME_PURPOSE &&
      reply.conversationId === conversationId &&
      reply.recordId === record.id &&
      reply.missingKey === key,
  );
}

export function unaskedIncompleteRecords(
  state: AppState,
  conversation: Conversation,
  now: Date,
): OperationalRecord[] {
  if (!conversation.driverId) return [];
  return [...state.records]
    .reverse()
    .filter(
      (record) =>
        record.driverId === conversation.driverId &&
        record.status === "incompleto" &&
        isActivePending(state, record, now) &&
        !wasResumeAsked(state, conversation.id, record),
    );
}

export function planPendingResume(
  state: AppState,
  conversationId: string,
  clock: ResumeClock,
): ResumePlan {
  const now = clock.now();
  const conversation = state.conversations.find(
    (c) => c.active && (c.id === conversationId || c.externalId === conversationId),
  );
  if (!conversation?.driverId) return { allowed: false, reason: "no_conversation" };

  const pause = conversationPause(state, conversation.id);
  if (pause && isPauseActive(pause.silenceUntil, now)) {
    return { allowed: false, reason: "pause_active" };
  }
  if (activeSuspension(state, conversation.driverId, now)) {
    return { allowed: false, reason: "suspended" };
  }

  const pending = unaskedIncompleteRecords(state, conversation, now)[0];
  if (!pending) {
    const anyIncomplete = state.records.some(
      (record) =>
        record.driverId === conversation.driverId &&
        record.status === "incompleto" &&
        isActivePending(state, record, now),
    );
    return { allowed: false, reason: anyIncomplete ? "already_asked" : "no_pending" };
  }

  return {
    allowed: true,
    conversationId: conversation.id,
    record: pending,
    text: questionForMissing(pending.kind, pending.missing, {
      description: pending.despesa?.description,
    }),
    missingKey: missingKey(pending.missing),
  };
}

export function buildResumeReply(plan: Extract<ResumePlan, { allowed: true }>) {
  return {
    conversationId: plan.conversationId,
    text: plan.text,
    purpose: RESUME_PURPOSE,
    recordId: plan.record.id,
    missingKey: plan.missingKey,
  };
}
