import type { MessageSender } from "../adapters/hermes/openwaSend.ts";
import { applyChannelConfig } from "../adapters/hermes/config.ts";
import type { AppState } from "../domain/types.ts";
import { buildResumeReply, planPendingResume, type ResumeClock } from "../engine/resume.ts";
import type { RuntimeConfig } from "./config.ts";
import { decideSend, type SendBlockReason } from "./sendGate.ts";

export type ResumeLog = (event: string, fields?: Record<string, unknown>) => void;

export type ResumeResult = {
  httpStatus: number;
  body: Record<string, unknown>;
};

function targetConversationId(runtime: RuntimeConfig, requested?: string): string {
  const wanted = requested?.trim();
  if (!wanted) return runtime.testGroupJid;
  return wanted;
}

export async function handleResume(input: {
  runtime: RuntimeConfig;
  state: AppState;
  sender: MessageSender;
  requestedConversationId?: string;
  clock?: ResumeClock;
  log?: ResumeLog;
}): Promise<ResumeResult> {
  const { runtime, sender } = input;
  const log = input.log ?? (() => undefined);
  const clock = input.clock ?? { now: () => new Date() };
  const hydrated = applyChannelConfig(input.state, runtime.channel);
  Object.assign(input.state, hydrated);
  const state = input.state;

  if (!runtime.testGroupJid) {
    return {
      httpStatus: 200,
      body: { ok: false, processed: false, reason: "missing_test_group", send: { attempted: false } },
    };
  }

  const conversationId = targetConversationId(runtime, input.requestedConversationId);
  if (conversationId !== runtime.testGroupJid) {
    log("resume_blocked", { reason: "not_test_group", conversationId });
    return {
      httpStatus: 200,
      body: {
        ok: false,
        processed: false,
        reason: "not_test_group",
        send: { attempted: false, reason: "not_test_group" },
      },
    };
  }

  const allowlisted = runtime.channel.conversations.some((c) => c.conversationId === conversationId);
  if (!allowlisted) {
    log("resume_blocked", { reason: "unauthorized_conversation", conversationId });
    return {
      httpStatus: 200,
      body: {
        ok: false,
        processed: false,
        reason: "unauthorized_conversation",
        send: { attempted: false, reason: "unauthorized_conversation" },
      },
    };
  }

  const plan = planPendingResume(state, conversationId, clock);
  if (!plan.allowed) {
    log("resume_blocked", { reason: plan.reason, conversationId });
    return {
      httpStatus: 200,
      body: {
        ok: true,
        processed: true,
        decision: "resume_skipped",
        reason: plan.reason,
        send: { attempted: false, reason: plan.reason },
      },
    };
  }

  const reply = buildResumeReply(plan);
  const gate = decideSend({
    runtime,
    conversationId: plan.conversationId,
    process: {
      decision: "ignored",
      duplicate: false,
      replies: [reply],
    },
  });

  if (!gate.allowed) {
    log("send_blocked", {
      reason: gate.reason,
      liveSend: runtime.liveSend,
      purpose: reply.purpose,
      recordId: reply.recordId,
    });
    return {
      httpStatus: 200,
      body: {
        ok: true,
        processed: true,
        decision: "resume_pending_question",
        recordId: plan.record.id,
        missing: plan.record.missing,
        replies: [reply],
        send: { attempted: false, reason: gate.reason as SendBlockReason },
      },
    };
  }

  const text = gate.texts[0];
  if (!text || gate.texts.length !== 1) {
    return {
      httpStatus: 200,
      body: {
        ok: true,
        processed: true,
        decision: "resume_pending_question",
        send: { attempted: false, reason: "no_replies" },
      },
    };
  }

  const result = await sender.sendText({
    sessionId: runtime.sessionId,
    chatId: plan.conversationId,
    text,
  });
  log(result.ok ? "send_ok" : "send_failed", {
    chatId: plan.conversationId,
    status: result.status,
    purpose: reply.purpose,
    recordId: reply.recordId,
  });

  if (result.ok) {
    state.botReplies.push(reply);
  }

  return {
    httpStatus: result.ok ? 200 : 502,
    body: {
      ok: result.ok,
      processed: true,
      decision: "resume_pending_question",
      recordId: plan.record.id,
      missing: plan.record.missing,
      replies: [reply],
      send: {
        attempted: true,
        deliveries: [{ chatId: plan.conversationId, ok: result.ok, status: result.status }],
      },
    },
  };
}
