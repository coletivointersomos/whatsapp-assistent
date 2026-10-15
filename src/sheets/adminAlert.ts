import type { MessageSender } from "../adapters/hermes/openwaSend.ts";
import type { RuntimeConfig } from "../runtime/config.ts";

export type AdminAlertBlock =
  | "live_send_disabled"
  | "missing_admin_jid"
  | "admin_is_group"
  | "not_allowlisted"
  | "empty_text";

export type AdminAlertGate =
  | { allowed: true; chatId: string; text: string }
  | { allowed: false; reason: AdminAlertBlock; pendingEvent: "admin_alert_pending" };

export function decideAdminAlert(input: {
  runtime: { liveSend: boolean; channel: { conversations: Array<{ conversationId: string }> } };
  adminJid: string;
  text: string;
}): AdminAlertGate {
  const text = input.text.trim();
  if (!text) return { allowed: false, reason: "empty_text", pendingEvent: "admin_alert_pending" };
  const chatId = input.adminJid.trim();
  if (!chatId) return { allowed: false, reason: "missing_admin_jid", pendingEvent: "admin_alert_pending" };
  if (chatId.endsWith("@g.us")) {
    return { allowed: false, reason: "admin_is_group", pendingEvent: "admin_alert_pending" };
  }
  const allowlisted = input.runtime.channel.conversations.some((c) => c.conversationId === chatId);
  if (!allowlisted) {
    return { allowed: false, reason: "not_allowlisted", pendingEvent: "admin_alert_pending" };
  }
  if (!input.runtime.liveSend) {
    return { allowed: false, reason: "live_send_disabled", pendingEvent: "admin_alert_pending" };
  }
  return { allowed: true, chatId, text };
}

export async function dispatchAdminAlerts(input: {
  runtime: RuntimeConfig;
  adminJid: string;
  texts: string[];
  sender: MessageSender;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<{ sent: number; pending: number }> {
  let sent = 0;
  let pending = 0;
  for (const text of input.texts) {
    const gate = decideAdminAlert({ runtime: input.runtime, adminJid: input.adminJid, text });
    if (!gate.allowed) {
      pending += 1;
      input.log?.(gate.pendingEvent, { reason: gate.reason, text });
      continue;
    }
    const result = await input.sender.sendText({
      sessionId: input.runtime.sessionId,
      chatId: gate.chatId,
      text: gate.text,
    });
    if (result.ok && !result.skipped) sent += 1;
    else {
      pending += 1;
      input.log?.("admin_alert_pending", { reason: result.reason ?? "send_failed", text });
    }
  }
  return { sent, pending };
}
