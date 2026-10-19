import { createOpenWaSender } from "../adapters/hermes/openwaSend.ts";
import { loadRuntimeConfig } from "../runtime/config.ts";
import { isAdminPrivateChat, isGroupLikeJid } from "../runtime/sendGate.ts";

/** 2g: envia UMA mensagem de teste só para o privado ADMIN_ALERT_JID. Uso: [--send] (sem --send = dry-run). */
const TEXT = "Hermes Arnaldo: teste de aviso ao administrador";
const runtime = loadRuntimeConfig(process.env, { defaultChannelFile: process.env.CHANNEL_FILE || "config/channel.json" });
const admin = runtime.adminAlertJid.trim();
const tail = admin.replace(/^.*(\d{4}@)/, "…$1");
const ok = !!admin && !isGroupLikeJid(admin) && isAdminPrivateChat(admin, admin) && runtime.liveSend;
const send = process.argv.includes("--send");
if (!ok) {
  console.log(JSON.stringify({ event: "admin_test_blocked", liveSend: runtime.liveSend, admin: tail }));
  process.exit(2);
}
if (!send) {
  console.log(JSON.stringify({ event: "admin_test_dry_run", to: tail, text: TEXT }));
  process.exit(0);
}
const sender = createOpenWaSender({
  baseUrl: runtime.openwaBaseUrl,
  apiKey: runtime.openwaApiKey,
  apiKeyHeader: runtime.openwaApiKeyHeader,
  sendPath: runtime.openwaSendPath,
});
const r = await sender.sendText({ sessionId: runtime.sessionId, chatId: admin, text: TEXT });
console.log(JSON.stringify({ event: r.ok && !r.skipped ? "send_ok" : "send_failed", to: tail, status: r.status, reason: r.reason }));
process.exit(r.ok && !r.skipped ? 0 : 1);
