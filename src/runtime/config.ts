import { readFileSync, existsSync } from "node:fs";
import type { ChannelConfig } from "../adapters/hermes/types.ts";

/** Só a string exata `true` liga envio real. Qualquer outro valor permanece desligado. */
export function isLiveSendEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function parseCsv(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export type RuntimeConfig = {
  serviceName: string;
  liveSend: boolean;
  hmacRequired: boolean;
  hmacSecret: string;
  sessionId: string;
  testGroupJid: string;
  channel: ChannelConfig;
  openwaBaseUrl: string;
  openwaApiKey: string;
  openwaApiKeyHeader: string;
  openwaSendPath: string;
  port: number;
  storePath: string;
  channelFile?: string;
};

export type StartupIssue = { code: string; message: string };

export function loadChannelFile(filePath: string): ChannelConfig {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ChannelConfig;
  if (!parsed?.sessionId || !Array.isArray(parsed.conversations)) {
    throw new Error(`channel config inválido: ${filePath}`);
  }
  return parsed;
}

export function overlayChannelFromEnv(
  channel: ChannelConfig,
  env: NodeJS.Dict<string>,
): ChannelConfig {
  const sessionId = env.SESSION_ID?.trim() || channel.sessionId;
  const testGroupJid = env.TEST_GROUP_JID?.trim() || channel.testGroupJid || "";
  const adminIds = parseCsv(env.ADMIN_IDS);
  const botIds = parseCsv(env.BOT_IDS);
  const allowed = parseCsv(env.ALLOWED_JIDS);
  const driverJids = parseCsv(env.DRIVER_JIDS);
  const byId = new Map(channel.conversations.map((c) => [c.conversationId, c]));
  let conversations = allowed.length
    ? allowed.map(
        (conversationId) =>
          byId.get(conversationId) ?? {
            conversationId,
            role: conversationId === env.CENTRAL_JID ? ("central" as const) : ("motorista" as const),
          },
      )
    : channel.conversations;
  if (driverJids.length) {
    conversations = conversations.map((c) => {
      const matchesTest = Boolean(testGroupJid) && c.conversationId === testGroupJid;
      if (!matchesTest) return c;
      return {
        ...c,
        driverJids: [...new Set([...(c.driverJids ?? []), ...driverJids])],
      };
    });
  }
  return {
    ...channel,
    sessionId,
    testGroupJid: testGroupJid || undefined,
    adminIds: adminIds.length ? adminIds : channel.adminIds,
    botIds: botIds.length ? botIds : channel.botIds,
    conversations,
  };
}

export function loadRuntimeConfig(
  env: NodeJS.Dict<string>,
  options?: { defaultChannelFile?: string },
): RuntimeConfig {
  const channelFile = env.CHANNEL_FILE || options?.defaultChannelFile;
  const baseChannel =
    channelFile && existsSync(channelFile)
      ? loadChannelFile(channelFile)
      : {
          sessionId: env.SESSION_ID?.trim() || "unset",
          adminIds: parseCsv(env.ADMIN_IDS),
          botIds: parseCsv(env.BOT_IDS),
          conversations: parseCsv(env.ALLOWED_JIDS).map((conversationId) => ({
            conversationId,
            role:
              conversationId === env.CENTRAL_JID
                ? ("central" as const)
                : ("motorista" as const),
          })),
        };
  const channel = overlayChannelFromEnv(baseChannel, env);
  const liveSend = isLiveSendEnabled(env.LIVE_SEND);
  const hmacRequired = env.HMAC_REQUIRED !== "false";
  return {
    serviceName: env.SERVICE_NAME?.trim() || "hermes-arnaldo-transportadora",
    liveSend,
    hmacRequired,
    hmacSecret: env.OPENWA_HMAC_SECRET ?? "",
    sessionId: channel.sessionId,
    testGroupJid: channel.testGroupJid ?? "",
    channel,
    openwaBaseUrl: (env.OPENWA_BASE_URL ?? "").replace(/\/$/, ""),
    openwaApiKey: env.OPENWA_API_KEY ?? "",
    openwaApiKeyHeader: env.OPENWA_API_KEY_HEADER?.trim() || "X-Api-Key",
    openwaSendPath: env.OPENWA_SEND_PATH?.trim() || "/api/sessions/{sessionId}/messages/text",
    port: Number(env.PORT || 8791),
    storePath: env.STORE_PATH?.trim() || "data/store.json",
    channelFile,
  };
}

export function startupIssues(runtime: RuntimeConfig): StartupIssue[] {
  const issues: StartupIssue[] = [];
  if (!runtime.sessionId || runtime.sessionId === "unset") {
    issues.push({ code: "missing_session", message: "SESSION_ID (ou channel.sessionId) é obrigatório." });
  }
  if (runtime.channel.conversations.length === 0) {
    issues.push({ code: "empty_allowlist", message: "Allowlist vazia: defina ALLOWED_JIDS ou CHANNEL_FILE." });
  }
  if (runtime.hmacRequired && !runtime.hmacSecret) {
    issues.push({
      code: "hmac_secret_missing",
      message: "HMAC_REQUIRED=true exige OPENWA_HMAC_SECRET. Não invente o segredo.",
    });
  }
  if (runtime.liveSend && !runtime.testGroupJid) {
    issues.push({ code: "missing_test_group", message: "LIVE_SEND=true exige TEST_GROUP_JID." });
  }
  if (
    runtime.liveSend &&
    runtime.testGroupJid &&
    !runtime.channel.conversations.some((c) => c.conversationId === runtime.testGroupJid)
  ) {
    issues.push({
      code: "test_group_not_allowlisted",
      message: "TEST_GROUP_JID precisa estar na allowlist.",
    });
  }
  if (runtime.liveSend && !runtime.openwaBaseUrl) {
    issues.push({ code: "missing_openwa_base", message: "LIVE_SEND=true exige OPENWA_BASE_URL." });
  }
  return issues;
}

export function describeSendMode(runtime: RuntimeConfig): string {
  if (runtime.liveSend) {
    return `LIVE_SEND=true — envio real permitido somente para o grupo de teste configurado (${runtime.testGroupJid}).`;
  }
  return "LIVE_SEND=false — envio WhatsApp desligado; o engine processa, mas não envia.";
}
