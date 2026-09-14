import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import type { SendTextInput, SendTextResult, MessageSender } from "../src/adapters/hermes/openwaSend.ts";
import { buildOpenWaSendUrl } from "../src/adapters/hermes/openwaSend.ts";
import type { ChannelConfig } from "../src/adapters/hermes/types.ts";
import { seedState } from "../src/config/seed.ts";
import {
  isLiveSendEnabled,
  loadRuntimeConfig,
  overlayChannelFromEnv,
  startupIssues,
  type RuntimeConfig,
} from "../src/runtime/config.ts";
import { hmacSha256Hex, verifyWebhookHmac } from "../src/runtime/hmac.ts";
import { handleInboundPayload } from "../src/runtime/pipeline.ts";
import { applyChannelConfig } from "../src/adapters/hermes/config.ts";

const TEST_GROUP = "grupo-lab-teste@g.us";
const OTHER = "chat-motorista-1@c.us";

const channel: ChannelConfig = {
  sessionId: "sessao-lab-substituivel",
  testGroupJid: TEST_GROUP,
  adminIds: ["alana-lab@c.us"],
  botIds: ["bot-lab@c.us"],
  conversations: [
    { conversationId: TEST_GROUP, role: "motorista", driverId: "motorista-joao", driverJids: [OTHER] },
    { conversationId: OTHER, role: "motorista", driverId: "motorista-joao" },
    { conversationId: "chat-central@c.us", role: "central" },
  ],
};

function runtime(partial: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    serviceName: "hermes-arnaldo-transportadora",
    liveSend: false,
    hmacRequired: true,
    hmacSecret: "test-secret",
    sessionId: channel.sessionId,
    testGroupJid: TEST_GROUP,
    channel,
    openwaBaseUrl: "http://openwa-api:2785",
    openwaApiKey: "",
    openwaApiKeyHeader: "X-Api-Key",
    openwaSendPath: "/api/sessions/{sessionId}/messages/text",
    port: 8791,
    storePath: "data/store.json",
    ...partial,
  };
}

function envelope(opts: {
  id: string;
  chatId: string;
  body: string;
  sessionId?: string;
  author?: string;
}) {
  const group = opts.chatId.endsWith("@g.us");
  return {
    event: "message.received",
    sessionId: opts.sessionId ?? channel.sessionId,
    data: {
      id: opts.id,
      chatId: opts.chatId,
      author: opts.author ?? "chat-motorista-1@c.us",
      from: opts.author ?? "chat-motorista-1@c.us",
      fromMe: false,
      isGroup: group,
      body: opts.body,
      type: "chat",
      timestamp: 1757520000,
    },
  };
}

const INCOMPLETE = "abasteci 150 litros, deu 980, assinada";
const COMPLETE = "hoje abasteci 200 litros no posto X deu 1200 pago";

class RecordingSender implements MessageSender {
  calls: SendTextInput[] = [];
  async sendText(input: SendTextInput): Promise<SendTextResult> {
    this.calls.push(input);
    return { ok: true, status: 200 };
  }
}

describe("controlled live send", () => {
  it("treats only the exact string true as LIVE_SEND enabled", () => {
    assert.equal(isLiveSendEnabled("true"), true);
    assert.equal(isLiveSendEnabled("TRUE"), false);
    assert.equal(isLiveSendEnabled("1"), false);
    assert.equal(isLiveSendEnabled("yes"), false);
    assert.equal(isLiveSendEnabled(undefined), false);
    assert.equal(isLiveSendEnabled("false"), false);
  });

  it("does not send when LIVE_SEND=false even if the engine replies", async () => {
    const sender = new RecordingSender();
    const state = applyChannelConfig(seedState(), channel);
    const result = await handleInboundPayload({
      runtime: runtime({ liveSend: false }),
      state,
      sender,
      envelope: envelope({ id: "inc-1", chatId: TEST_GROUP, body: INCOMPLETE }),
    });
    assert.equal(result.body.decision, "record_incomplete");
    assert.equal((result.body.send as { attempted: boolean }).attempted, false);
    assert.equal((result.body.send as { reason: string }).reason, "live_send_disabled");
    assert.equal(sender.calls.length, 0);
  });

  it("sends only to the allowlisted test group when LIVE_SEND=true", async () => {
    const sender = new RecordingSender();
    const state = applyChannelConfig(seedState(), channel);
    const result = await handleInboundPayload({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      envelope: envelope({ id: "inc-2", chatId: TEST_GROUP, body: INCOMPLETE }),
    });
    assert.equal(result.body.decision, "record_incomplete");
    assert.equal(sender.calls.length, 1);
    assert.equal(sender.calls[0].chatId, TEST_GROUP);
    assert.match(sender.calls[0].text, /data|local/i);
  });

  it("processes another allowlisted chat but does not send outside the test group", async () => {
    const sender = new RecordingSender();
    const state = applyChannelConfig(seedState(), channel);
    const result = await handleInboundPayload({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      envelope: envelope({ id: "inc-other", chatId: OTHER, body: INCOMPLETE }),
    });
    assert.equal(result.body.decision, "record_incomplete");
    assert.equal((result.body.send as { reason: string }).reason, "not_test_group");
    assert.equal(sender.calls.length, 0);
  });

  it("blocks a wrong sessionId before send", async () => {
    const sender = new RecordingSender();
    const state = applyChannelConfig(seedState(), channel);
    const result = await handleInboundPayload({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      envelope: envelope({
        id: "bad-sess",
        chatId: TEST_GROUP,
        body: INCOMPLETE,
        sessionId: "outro-numero",
      }),
    });
    assert.equal(result.body.reason, "session_mismatch");
    assert.equal(result.body.processed, false);
    assert.equal(sender.calls.length, 0);
    assert.equal(state.records.length, 0);
  });

  it("blocks a JID outside the allowlist", async () => {
    const sender = new RecordingSender();
    const state = applyChannelConfig(seedState(), channel);
    const result = await handleInboundPayload({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      envelope: envelope({
        id: "unauth",
        chatId: "grupo-nao-autorizado@g.us",
        body: INCOMPLETE,
      }),
    });
    assert.equal(result.body.reason, "unauthorized_conversation");
    assert.equal(sender.calls.length, 0);
  });

  it("does not send again on duplicate externalId", async () => {
    const sender = new RecordingSender();
    const state = applyChannelConfig(seedState(), channel);
    const payload = envelope({ id: "dup-1", chatId: TEST_GROUP, body: INCOMPLETE });
    const first = await handleInboundPayload({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      envelope: payload,
    });
    const second = await handleInboundPayload({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      envelope: payload,
    });
    assert.equal(first.body.decision, "record_incomplete");
    assert.equal(second.body.decision, "duplicate");
    assert.equal(sender.calls.length, 1);
    assert.equal((second.body.send as { reason: string }).reason, "duplicate");
  });

  it("does not send when the engine has no reply", async () => {
    const sender = new RecordingSender();
    const state = applyChannelConfig(seedState(), channel);
    const result = await handleInboundPayload({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      envelope: envelope({ id: "complete-1", chatId: TEST_GROUP, body: COMPLETE }),
    });
    assert.equal(result.body.decision, "record_created");
    assert.equal((result.body.send as { reason: string }).reason, "no_replies");
    assert.equal(sender.calls.length, 0);
  });

  it("changes sessionId via config overlay, not the engine", () => {
    const next = overlayChannelFromEnv(channel, { SESSION_ID: "sessao-definitiva" });
    assert.equal(channel.sessionId, "sessao-lab-substituivel");
    assert.equal(next.sessionId, "sessao-definitiva");
    const loaded = loadRuntimeConfig(
      {
        SESSION_ID: "sessao-definitiva",
        ALLOWED_JIDS: `${TEST_GROUP},${OTHER},chat-3@c.us,chat-4@c.us,chat-5@c.us,chat-central@c.us`,
        TEST_GROUP_JID: TEST_GROUP,
        LIVE_SEND: "false",
        HMAC_REQUIRED: "false",
      },
      {},
    );
    assert.equal(loaded.sessionId, "sessao-definitiva");
    assert.equal(loaded.channel.conversations.length, 6);
  });

  it("overlays DRIVER_JIDS only onto TEST_GROUP_JID", () => {
    const next = overlayChannelFromEnv(channel, { DRIVER_JIDS: "joao-real@c.us" });
    const group = next.conversations.find((c) => c.conversationId === TEST_GROUP);
    const other = next.conversations.find((c) => c.conversationId === OTHER);
    assert.ok(group?.driverJids?.includes("joao-real@c.us"));
    assert.equal(other?.driverJids?.includes("joao-real@c.us") ?? false, false);
  });

  it("accepts multiple authorized chats from config without sending to them", async () => {
    const sender = new RecordingSender();
    const state = applyChannelConfig(seedState(), channel);
    const cfg = runtime({ liveSend: true });
    assert.ok(cfg.channel.conversations.length >= 2);
    await handleInboundPayload({
      runtime: cfg,
      state,
      sender,
      envelope: envelope({ id: "m-a", chatId: OTHER, body: COMPLETE }),
    });
    await handleInboundPayload({
      runtime: cfg,
      state,
      sender,
      envelope: envelope({ id: "m-b", chatId: TEST_GROUP, body: COMPLETE }),
    });
    assert.equal(state.records.length, 2);
    assert.equal(sender.calls.length, 0);
  });

  it("refuses LIVE_SEND startup without test group on the allowlist", () => {
    const issues = startupIssues(
      runtime({
        liveSend: true,
        testGroupJid: "grupo-ausente@g.us",
      }),
    );
    assert.ok(issues.some((i) => i.code === "test_group_not_allowlisted"));
  });

  it("verifies OpenWA HMAC hex and rejects mismatch", () => {
    const body = Buffer.from('{"event":"message.received"}');
    const secret = "unit-hmac";
    const hex = hmacSha256Hex(secret, body);
    const ok = verifyWebhookHmac({
      required: true,
      secret,
      rawBody: body,
      headers: { "x-openwa-signature": hex },
    });
    assert.equal(ok.ok, true);
    const prefixed = verifyWebhookHmac({
      required: true,
      secret,
      rawBody: body,
      headers: { "x-hub-signature-256": `sha256=${hex}` },
    });
    assert.equal(prefixed.ok, true);
    const bad = verifyWebhookHmac({
      required: true,
      secret,
      rawBody: body,
      headers: { "x-openwa-signature": createHmac("sha256", "other").update(body).digest("hex") },
    });
    assert.equal(bad.ok, false);
    const missing = verifyWebhookHmac({
      required: true,
      secret,
      rawBody: body,
      headers: {},
    });
    assert.equal(missing.ok, false);
  });

  it("builds the OpenWA send URL from session config", () => {
    const url = buildOpenWaSendUrl(
      "http://openwa-api:2785",
      "/api/sessions/{sessionId}/messages/text",
      "sessao-lab-substituivel",
    );
    assert.equal(url, "http://openwa-api:2785/api/sessions/sessao-lab-substituivel/messages/text");
  });
});
