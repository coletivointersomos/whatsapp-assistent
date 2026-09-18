import { fingerprint, maskJid } from "../inspect/mask.ts";
import type { NluResult } from "./types.ts";

export type NluRejectReason =
  | "json_invalid"
  | "http_error"
  | "confidence_low"
  | "action_unknown"
  | "schema_invalid"
  | "permission_denied"
  | "no_applicable_action"
  | "llm_failed";

const SECRET_MARK = /sk-[a-z0-9_-]{8,}|Bearer\s+\S+|hmac|api[_-]?key/i;

export function nluRejectReason(result: NluResult): NluRejectReason | undefined {
  const why = result.reasoning_summary ?? "";
  if (result.unsafeReason === "sensitive_not_admin") return "permission_denied";
  if (why === "invalid_json") return "json_invalid";
  if (why === "llm_http" || why.startsWith("llm_http:")) return "http_error";
  if (why === "llm_empty_content" || why === "unknown_intent") return "schema_invalid";
  if (why === "llm_failed" || why === "llm_disabled") return "llm_failed";
  if (result.action === "unknown" || result.action === "none") return "action_unknown";
  if (result.intent === "unknown") return "action_unknown";
  if (result.confidence < 0.45) return "confidence_low";
  return undefined;
}

export function previewReply(text: string | undefined): {
  hasReply: boolean;
  replyLen: number;
  replyPreview?: string;
} {
  if (!text?.trim()) return { hasReply: false, replyLen: 0 };
  let clean = text.replace(/\d{10,}@(?:g\.us|lid|c\.us|s\.whatsapp\.net)/gi, "…jid");
  clean = clean.replace(/https?:\/\/[^\s]+/gi, "…url");
  if (SECRET_MARK.test(clean)) clean = "[redacted]";
  return { hasReply: true, replyLen: text.length, replyPreview: clean.slice(0, 80) };
}

export function safeNluLogFields(input: {
  provider: string;
  result: NluResult;
  rejectReason?: NluRejectReason;
  applied?: boolean;
}): Record<string, unknown> {
  const preview = previewReply(input.result.reply);
  return {
    provider: input.provider,
    intent: input.result.intent,
    action: input.result.action,
    confidence: input.result.confidence,
    requiresConfirmation: Boolean(input.result.requiresConfirmation),
    unsafeReason: input.result.unsafeReason ?? "",
    hasReply: preview.hasReply,
    replyLen: preview.replyLen,
    replyPreview: preview.replyPreview,
    rejectReason: input.rejectReason ?? "",
    applied: input.applied ?? false,
    reasoning: (input.result.reasoning_summary ?? "").slice(0, 80),
  };
}

export function maskLogValue(value: string): string {
  if (value.includes("@")) return `${maskJid(value)} fp=${fingerprint(value)}`;
  return value;
}
