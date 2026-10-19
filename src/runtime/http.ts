import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { applyChannelConfig } from "../adapters/hermes/config.ts";
import { createOpenWaSender, disabledSender } from "../adapters/hermes/openwaSend.ts";
import { seedState } from "../config/seed.ts";
import { loadState, saveState } from "../persistence/store.ts";
import { maskStateRecordsPii } from "../privacy/records.ts";
import { loadSheetsWriteConfig, sheetsWriteSkipReason } from "../sheets/config.ts";
import { runGroupSweep } from "../sheets/sweep.ts";
import { writeSessionToSheet } from "../sheets/write.ts";
import { describeSendMode, type RuntimeConfig } from "./config.ts";
import { verifyWebhookHmac, verifyResumeAuth } from "./hmac.ts";
import { handleInboundPayload } from "./pipeline.ts";
import { createAutoFill, factCompetencia, loadAutoFillConfig } from "../sheets/autoFill.ts";
import { loadAppendTarget, runAppendExisting } from "../sheets/appendExisting.ts";
import { loadModeloConfig } from "../sheets/modeloWriter.ts";
import { createAppendSheetsApi } from "../sheets/appendExisting.ts";
import { loadConversaConfig, runConversaFill } from "../sheets/conversaSheet.ts";
import { serviceAccountSheetsToken } from "../cli/conversaFill.ts";
import { driveTokenProvider } from "../drive/auth.ts";
import { loadDriveConfig } from "../drive/config.ts";
import { createDriveClient } from "../drive/googleDrive.ts";
import { handleResume } from "./resume.ts";

function readHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function log(event: string, fields?: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), event, ...fields };
  console.log(JSON.stringify(line));
}

/**
 * Grava o store (sempre, com PII dos registros mascarada) e, só se `syncSheets`, sincroniza a planilha.
 * Inbound bloqueado/rejeitado/duplicado chega aqui com `syncSheets: false`.
 */
async function persistState(
  runtime: RuntimeConfig,
  state: ReturnType<typeof seedState>,
  options: { syncSheets: boolean },
): Promise<void> {
  maskStateRecordsPii(state);
  saveState(runtime.storePath, state);
  if (!options.syncSheets) return;
  const sheets = loadSheetsWriteConfig();
  const skip = sheetsWriteSkipReason(sheets);
  if (skip) {
    if (sheets.enabled) log("sheets_sync_skipped", { reason: skip });
    return;
  }
  const synced = await writeSessionToSheet({ state, config: sheets });
  if (synced.ok) {
    log("sheets_sync_ok", { rowCount: synced.rowCount });
    if ("oficialWritten" in synced && synced.oficialWritten === false) {
      log("sheets_oficial_skipped", { reason: "rascunho_nao_limpo" });
    }
    if ("alerts" in synced && Array.isArray(synced.alerts)) {
      for (const text of synced.alerts) log("admin_alert_pending", { text });
    }
  } else log("sheets_sync_failed", { reason: synced.reason });
}

export function createAppServer(runtime: RuntimeConfig) {
  let state = applyChannelConfig(loadState(runtime.storePath), runtime.channel);
  const autoFill = createAutoFill({
    config: loadAutoFillConfig(process.env),
    log,
    run: async (competencia) => {
      const target = loadAppendTarget(process.env);
      if (!target) throw new Error("sem MODELO_TARGET_SPREADSHEET_ID");
      let failure: unknown;
      if (process.env.MODELO_AUTO_FILL_ENABLED === "true") {
        try {
          const res = await runAppendExisting({ state, competencia, config: loadModeloConfig(process.env), target, log });
          log("auto_fill_result", { competencia, status: res.status, cells: res.plan?.writes.length ?? 0, rows: res.plan?.appended.length ?? 0, skipped: res.plan?.skipped.length ?? 0 });
        } catch (error) {
          failure = error;
        }
      }
      const conversa = loadConversaConfig(process.env);
      if (conversa.enabled) {
        // aba "Conversa WhatsApp": independe da competência do fato (usa o mês da planilha-alvo); falha só loga
        try {
          const drive = loadDriveConfig(process.env);
          await runConversaFill({
            state,
            spreadsheetId: target.spreadsheetId,
            config: conversa,
            sheets: createAppendSheetsApi(serviceAccountSheetsToken(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "")),
            drive: createDriveClient({ token: driveTokenProvider(drive) }),
            rootFolderId: drive.rootFolderId,
            log,
          });
        } catch (error) {
          log("conversa_failed", { reason: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
        }
      }
      if (failure) throw failure;
    },
  });
  const sender = runtime.liveSend
    ? createOpenWaSender({
        baseUrl: runtime.openwaBaseUrl,
        apiKey: runtime.openwaApiKey,
        apiKeyHeader: runtime.openwaApiKeyHeader,
        sendPath: runtime.openwaSendPath,
      })
    : disabledSender();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          service: runtime.serviceName,
          liveSend: runtime.liveSend,
          hmacRequired: runtime.hmacRequired,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/resume") {
        const rawBody = await readBody(req);
        const headers = readHeaders(req);
        const auth = verifyResumeAuth({
          required: runtime.hmacRequired,
          secret: runtime.hmacSecret,
          rawBody,
          headers,
        });
        if (!auth.ok) {
          log("resume_auth_rejected", { reason: auth.reason });
          json(res, 401, { ok: false, reason: auth.reason });
          return;
        }
        let requestedConversationId: string | undefined;
        if (rawBody.length) {
          try {
            const parsed = JSON.parse(rawBody.toString("utf8")) as { conversationId?: unknown };
            if (typeof parsed.conversationId === "string") requestedConversationId = parsed.conversationId;
          } catch {
            json(res, 400, { ok: false, reason: "invalid_json" });
            return;
          }
        }
        const result = await handleResume({
          runtime,
          state,
          sender,
          requestedConversationId,
          log,
        });
        await persistState(runtime, state, { syncSheets: true });
        json(res, result.httpStatus, result.body);
        return;
      }

      if (req.method !== "POST" || url.pathname !== "/webhook") {
        json(res, 404, { ok: false, reason: "not_found" });
        return;
      }

      const rawBody = await readBody(req);
      const headers = readHeaders(req);
      const hmac = verifyWebhookHmac({
        required: runtime.hmacRequired,
        secret: runtime.hmacSecret,
        rawBody,
        headers,
      });
      if (!hmac.ok) {
        log("hmac_rejected", { reason: hmac.reason });
        json(res, 401, { ok: false, reason: hmac.reason });
        return;
      }

      let envelope: unknown;
      try {
        envelope = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
      } catch {
        json(res, 400, { ok: false, reason: "invalid_json" });
        return;
      }

      const result = await handleInboundPayload({
        runtime,
        state,
        envelope,
        sender,
        log,
      });
      await persistState(runtime, state, { syncSheets: result.sheetsSync });
      if (result.sheetsSync) {
        const data = (envelope as { data?: { chatId?: unknown; id?: unknown } } | null)?.data;
        const chatId = typeof data?.chatId === "string" ? data.chatId : undefined;
        const msgId = typeof data?.id === "string" ? data.id : undefined;
        autoFill.trigger(chatId, factCompetencia(state, msgId));
      }
      json(res, result.httpStatus, result.body);
    } catch (error) {
      log("webhook_error", { message: error instanceof Error ? error.message : "unknown" });
      json(res, 500, { ok: false, reason: "internal_error" });
    }
  });

  const sheets = loadSheetsWriteConfig();
  if (sheets.sweepIntervalMs > 0) {
    setInterval(() => {
      void runGroupSweep({
        runtime,
        state,
        sheets,
        sender: runtime.liveSend ? sender : disabledSender(),
        log,
      }).catch((error) => {
        log("sheets_sweep_failed", { message: error instanceof Error ? error.message : "unknown" });
      });
    }, sheets.sweepIntervalMs).unref();
  }

  return { server, getState: () => state, resetState: () => { state = applyChannelConfig(seedState(), runtime.channel); } };
}

export function logStartup(runtime: RuntimeConfig): void {
  log("startup", {
    service: runtime.serviceName,
    port: runtime.port,
    liveSend: runtime.liveSend,
    hmacRequired: runtime.hmacRequired,
    sessionConfigured: Boolean(runtime.sessionId && runtime.sessionId !== "unset"),
    allowlistSize: runtime.channel.conversations.length,
    sendMode: describeSendMode(runtime),
    resumePath: "/resume",
  });
}
