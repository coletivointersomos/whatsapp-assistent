import type { BotReply, ProcessResult } from "../domain/types.ts";
import type { RuntimeConfig } from "./config.ts";

export type SendBlockReason =
  | "live_send_disabled"
  | "session_mismatch"
  | "unauthorized_conversation"
  | "not_test_group"
  | "duplicate"
  | "no_replies"
  | "silent_resume_only";

export type SendGate =
  | { allowed: false; reason: SendBlockReason }
  | { allowed: true; texts: string[] };

export function outgoingTexts(replies: BotReply[]): string[] {
  return replies.filter((r) => !r.silentResume && r.text.trim()).map((r) => r.text);
}

export function decideSend(input: {
  runtime: RuntimeConfig;
  conversationId: string;
  sessionId?: string;
  process: ProcessResult;
}): SendGate {
  if (input.sessionId && input.sessionId !== input.runtime.sessionId) {
    return { allowed: false, reason: "session_mismatch" };
  }
  const allowlisted = input.runtime.channel.conversations.some(
    (c) => c.conversationId === input.conversationId,
  );
  if (!allowlisted) return { allowed: false, reason: "unauthorized_conversation" };
  if (input.process.duplicate) return { allowed: false, reason: "duplicate" };
  if (!input.runtime.liveSend) return { allowed: false, reason: "live_send_disabled" };
  if (input.conversationId !== input.runtime.testGroupJid) {
    return { allowed: false, reason: "not_test_group" };
  }
  const texts = outgoingTexts(input.process.replies);
  if (texts.length === 0) {
    const onlySilent = input.process.replies.some((r) => r.silentResume);
    return { allowed: false, reason: onlySilent ? "silent_resume_only" : "no_replies" };
  }
  return { allowed: true, texts };
}
