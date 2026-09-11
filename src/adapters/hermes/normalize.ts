import type { AuthorRole, InboundMessage, MessageType } from "../../domain/types.ts";
import type { ChannelConfig, OpenWaEnvelope } from "./types.ts";

export type NormalizeOk = { ok: true; inbound: InboundMessage };
export type NormalizeFail = {
  ok: false;
  reason:
    | "invalid_payload"
    | "ignored_event"
    | "session_mismatch"
    | "unauthorized_conversation"
    | "self_or_status";
};
export type NormalizeResult = NormalizeOk | NormalizeFail;

function isJid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function messageType(kind: string | undefined, mimetype?: string): MessageType {
  const k = (kind ?? "chat").toLowerCase();
  if (k === "image" || (mimetype ?? "").startsWith("image/")) return "anexo_comprovante";
  if (k === "audio" || k === "ptt" || k === "voice" || (mimetype ?? "").startsWith("audio/")) {
    return "audio_info";
  }
  return "texto";
}

function sentAtIso(timestamp: number | string | undefined): string {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
    return new Date(ms).toISOString();
  }
  if (typeof timestamp === "string" && timestamp.trim()) {
    const n = Number(timestamp);
    if (Number.isFinite(n)) return sentAtIso(n);
    const parsed = Date.parse(timestamp);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function authorRole(authorId: string, channel: ChannelConfig, chatRole: "motorista" | "central"): AuthorRole {
  if (channel.botIds.includes(authorId)) return "bot";
  if (channel.adminIds.includes(authorId)) return "alana";
  if (chatRole === "motorista") return "motorista";
  if (chatRole === "central") return "desconhecido";
  return "desconhecido";
}

export function normalizeOpenWaEnvelope(
  envelope: OpenWaEnvelope,
  channel: ChannelConfig,
): NormalizeResult {
  if (!envelope || typeof envelope !== "object") {
    return { ok: false, reason: "invalid_payload" };
  }
  if (envelope.event && envelope.event !== "message.received") {
    return { ok: false, reason: "ignored_event" };
  }
  if (envelope.sessionId !== channel.sessionId) {
    return { ok: false, reason: "session_mismatch" };
  }
  const data = envelope.data;
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "invalid_payload" };
  }
  const chatId = data.chatId;
  if (!isJid(chatId)) return { ok: false, reason: "invalid_payload" };

  const allowed = channel.conversations.find((c) => c.conversationId === chatId);
  if (!allowed) {
    return { ok: false, reason: "unauthorized_conversation" };
  }

  if (data.fromMe === true || data.isStatusBroadcast === true) {
    return { ok: false, reason: "self_or_status" };
  }

  const group = chatId.endsWith("@g.us");
  const authorId = group ? data.author : data.from ?? data.author;
  if (!isJid(authorId)) return { ok: false, reason: "invalid_payload" };

  const mid = data.id || data.messageId;
  if (!isJid(mid)) return { ok: false, reason: "invalid_payload" };

  const text = (data.body || data.caption || "").trim() || undefined;
  const mimetype = data.media?.mimetype;
  const type = messageType(data.type, mimetype);

  const inbound: InboundMessage = {
    externalId: mid,
    conversationId: chatId,
    authorId,
    authorRole: authorRole(authorId, channel, allowed.role),
    sentAt: sentAtIso(data.timestamp),
    type,
    text,
    attachmentRef: type === "texto" ? undefined : mimetype || type,
    raw: envelope,
  };
  return { ok: true, inbound };
}
