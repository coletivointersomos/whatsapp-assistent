import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ChannelConfig } from "../src/adapters/hermes/types.ts";
import type { RuntimeConfig } from "../src/runtime/config.ts";
import { hmacSha256Hex } from "../src/runtime/hmac.ts";
import { createAppServer } from "../src/runtime/http.ts";
import { shouldSyncSheetsAfter } from "../src/runtime/pipeline.ts";

const TEST_GROUP = "grupo-lab-teste@g.us";
const OTHER = "chat-motorista-1@c.us";
const SHEETS_URL = "http://sheets-fake.invalid/exec";

const channel: ChannelConfig = {
  sessionId: "sessao-lab-substituivel",
  testGroupJid: TEST_GROUP,
  adminIds: ["alana-lab@c.us"],
  botIds: ["bot-lab@c.us"],
  conversations: [{ conversationId: TEST_GROUP, role: "motorista", driverId: "motorista-joao", driverJids: [OTHER] }],
};

function runtime(storePath: string): RuntimeConfig {
  return {
    serviceName: "hermes-arnaldo-transportadora",
    liveSend: false,
    hmacRequired: true,
    hmacSecret: "test-secret",
    sessionId: channel.sessionId,
    testGroupJid: TEST_GROUP,
    channel,
    openwaBaseUrl: "",
    openwaApiKey: "",
    openwaApiKeyHeader: "X-Api-Key",
    openwaSendPath: "/api/sessions/{sessionId}/messages/text",
    openwaMediaPath: "/api/sessions/{sessionId}/messages/{chatId}/{messageId}/media",
    port: 0,
    storePath,
    adminAlertJid: "",
  };
}

function envelope(id: string, chatId: string, body: string, author = OTHER) {
  return {
    event: "message.received",
    sessionId: channel.sessionId,
    data: { id, chatId, author, from: author, fromMe: false, isGroup: chatId.endsWith("@g.us"), body, type: "chat", timestamp: 1757520000 },
  };
}

describe("sync da planilha só para inbound processado de conversa autorizada", () => {
  it("decisão pura: bloqueado/rejeitado/duplicado/bot não sincroniza", () => {
    assert.equal(shouldSyncSheetsAfter({ decision: "record_created", duplicate: false }), true);
    assert.equal(shouldSyncSheetsAfter({ decision: "assisted", duplicate: false }), true);
    assert.equal(shouldSyncSheetsAfter({ decision: "duplicate", duplicate: true }), false);
    assert.equal(shouldSyncSheetsAfter({ decision: "rejected_unauthorized", duplicate: false }), false);
    assert.equal(
      shouldSyncSheetsAfter({
        decision: "ignored",
        duplicate: false,
        message: {
          externalId: "x",
          conversationId: TEST_GROUP,
          authorId: "bot-lab@c.us",
          authorRole: "bot",
          sentAt: "2026-10-19T12:00:00.000Z",
          processedAt: "2026-10-19T12:00:00.000Z",
          type: "texto",
        },
      }),
      false,
    );
  });

  it("POST /webhook: grupo não autorizado e duplicata não chamam a planilha; mensagem autorizada chama", async () => {
    const saved = {
      enabled: process.env.SHEETS_SYNC_ENABLED,
      url: process.env.SHEETS_APPS_SCRIPT_URL,
      token: process.env.SHEETS_APPS_SCRIPT_TOKEN,
      mode: process.env.SHEETS_TAB_MODE,
      sweep: process.env.SHEETS_SWEEP_INTERVAL_MS,
    };
    process.env.SHEETS_SYNC_ENABLED = "true";
    process.env.SHEETS_APPS_SCRIPT_URL = SHEETS_URL;
    process.env.SHEETS_APPS_SCRIPT_TOKEN = "fake-token";
    delete process.env.SHEETS_TAB_MODE;
    delete process.env.SHEETS_SWEEP_INTERVAL_MS;
    const realFetch = globalThis.fetch;
    const sheetCalls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(SHEETS_URL)) {
        sheetCalls.push(url);
        return new Response(JSON.stringify({ ok: true, rowCount: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const storePath = join(mkdtempSync(join(tmpdir(), "sheets-gate-")), "store.json");
    const app = createAppServer(runtime(storePath));
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
    const addr = app.server.address();
    assert.ok(addr && typeof addr === "object");
    const post = async (payload: unknown) => {
      const body = Buffer.from(JSON.stringify(payload));
      const res = await realFetch(`http://127.0.0.1:${addr.port}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-openwa-signature": hmacSha256Hex("test-secret", body) },
        body,
      });
      return (await res.json()) as Record<string, unknown>;
    };
    try {
      const blocked = await post(envelope("u-1", "000000000000-0000@g.us", "abasteci 200 litros deu 1200"));
      assert.equal(blocked.processed, false);
      assert.equal(sheetCalls.length, 0);
      // store continua sendo gravado
      assert.ok(readFileSync(storePath, "utf8").length > 0);

      const first = await post(envelope("a-1", TEST_GROUP, "hoje abasteci 200 litros no posto X deu 1200 pago, pix 11987654321"));
      assert.equal(first.processed, true);
      assert.equal(sheetCalls.length, 1);

      const dup = await post(envelope("a-1", TEST_GROUP, "hoje abasteci 200 litros no posto X deu 1200 pago, pix 11987654321"));
      assert.equal(dup.duplicate, true);
      assert.equal(sheetCalls.length, 1);

      // store gravado sem o telefone completo nos registros
      const store = JSON.parse(readFileSync(storePath, "utf8")) as { records: unknown[] };
      assert.doesNotMatch(JSON.stringify(store.records), /11987654321/);
    } finally {
      await new Promise<void>((resolve, reject) => app.server.close((err) => (err ? reject(err) : resolve())));
      globalThis.fetch = realFetch;
      for (const [key, value] of [
        ["SHEETS_SYNC_ENABLED", saved.enabled],
        ["SHEETS_APPS_SCRIPT_URL", saved.url],
        ["SHEETS_APPS_SCRIPT_TOKEN", saved.token],
        ["SHEETS_TAB_MODE", saved.mode],
        ["SHEETS_SWEEP_INTERVAL_MS", saved.sweep],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
