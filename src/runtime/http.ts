import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { applyChannelConfig } from "../adapters/hermes/config.ts";
import { createOpenWaSender, disabledSender } from "../adapters/hermes/openwaSend.ts";
import { seedState } from "../config/seed.ts";
import { loadState, saveState } from "../persistence/store.ts";
import { describeSendMode, type RuntimeConfig } from "./config.ts";
import { verifyWebhookHmac } from "./hmac.ts";
import { handleInboundPayload } from "./pipeline.ts";

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

export function createAppServer(runtime: RuntimeConfig) {
  let state = applyChannelConfig(loadState(runtime.storePath), runtime.channel);
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
      saveState(runtime.storePath, state);
      json(res, result.httpStatus, result.body);
    } catch (error) {
      log("webhook_error", { message: error instanceof Error ? error.message : "unknown" });
      json(res, 500, { ok: false, reason: "internal_error" });
    }
  });

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
  });
}
