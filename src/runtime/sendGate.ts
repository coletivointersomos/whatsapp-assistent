import type { BotReply, ProcessResult } from "../domain/types.ts";
import type { RuntimeConfig } from "./config.ts";

export type SendBlockReason =
  | "live_send_disabled"
  | "session_mismatch"
  | "unauthorized_conversation"
  | "not_test_group"
  | "group_never"
  | "missing_admin_jid"
  | "not_admin_private_chat"
  | "duplicate"
  | "no_replies"
  | "silent_resume_only";

export type SendGate =
  | { allowed: false; reason: SendBlockReason }
  | { allowed: true; texts: string[] };

export function outgoingTexts(replies: BotReply[]): string[] {
  return replies
    .filter((r) => r.text.trim())
    .filter((r) => r.purpose === "resume_pending_question" || !r.silentResume)
    .map((r) => r.text);
}

/** Grupo, lista de transmissão, canal ou status: o bot nunca envia para esses destinos. */
export function isGroupLikeJid(jid: string): boolean {
  return /@(g\.us|broadcast|newsletter)$/i.test(jid.trim()) || /^status@/i.test(jid.trim());
}

/** Conversa privada do admin: ADMIN_ALERT_JID, em formato de pessoa (@c.us / @s.whatsapp.net / @lid). */
export function isAdminPrivateChat(conversationId: string, adminJid: string): boolean {
  const admin = adminJid.trim();
  if (!admin || isGroupLikeJid(admin) || !/@(c\.us|s\.whatsapp\.net|lid)$/i.test(admin)) return false;
  return conversationId.trim() === admin;
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
  if (isGroupLikeJid(input.conversationId)) return { allowed: false, reason: "group_never" };
  const allowlisted = input.runtime.channel.conversations.some(
    (c) => c.conversationId === input.conversationId,
  );
  if (!allowlisted) return { allowed: false, reason: "unauthorized_conversation" };
  if (input.process.duplicate) return { allowed: false, reason: "duplicate" };
  if (!input.runtime.liveSend) return { allowed: false, reason: "live_send_disabled" };
  if (!input.runtime.adminAlertJid.trim()) return { allowed: false, reason: "missing_admin_jid" };
  if (!isAdminPrivateChat(input.conversationId, input.runtime.adminAlertJid)) {
    return { allowed: false, reason: "not_admin_private_chat" };
  }
  const texts = outgoingTexts(input.process.replies);
  if (texts.length === 0) {
    const onlySilent = input.process.replies.some((r) => r.silentResume);
    return { allowed: false, reason: onlySilent ? "silent_resume_only" : "no_replies" };
  }
  return { allowed: true, texts };
}
