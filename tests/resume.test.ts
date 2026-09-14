import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { applyChannelConfig } from "../src/adapters/hermes/config.ts";
import type { MessageSender, SendTextInput, SendTextResult } from "../src/adapters/hermes/openwaSend.ts";
import type { ChannelConfig } from "../src/adapters/hermes/types.ts";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessage } from "../src/engine/process.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../src/runtime/http.ts";
import { hmacSha256Hex, verifyResumeAuth } from "../src/runtime/hmac.ts";
import type { RuntimeConfig } from "../src/runtime/config.ts";
import { handleResume } from "../src/runtime/resume.ts";

const TEST_GROUP = "grupo-lab-teste@g.us";
const OTHER = "chat-motorista-1@c.us";
const T0 = new Date("2026-09-14T12:00:00.000Z");

const channel: ChannelConfig = {
  sessionId: "sessao-lab-substituivel",
  testGroupJid: TEST_GROUP,
  adminIds: ["alana-lab@c.us"],
  botIds: ["bot-lab@c.us"],
  drivers: [{ id: "motorista-joao", jids: [OTHER] }],
  conversations: [
    { conversationId: TEST_GROUP, role: "motorista", driverId: "motorista-joao", driverJids: [OTHER] },
    { conversationId: OTHER, role: "motorista", driverId: "motorista-joao" },
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

class RecordingSender implements MessageSender {
  calls: SendTextInput[] = [];
  async sendText(input: SendTextInput): Promise<SendTextResult> {
    this.calls.push(input);
    return { ok: true, status: 201 };
  }
}

function msg(partial: Partial<InboundMessage> & Pick<InboundMessage, "externalId" | "text">): InboundMessage {
  return {
    conversationId: TEST_GROUP,
    authorId: OTHER,
    authorRole: "motorista",
    sentAt: T0.toISOString(),
    type: "texto",
    ...partial,
  };
}

function withIncomplete(state: AppState, id: string, sentAt = T0) {
  processMessage(
    state,
    msg({
      externalId: id,
      text: "abasteci 150 litros, deu 980, assinada",
      sentAt: sentAt.toISOString(),
    }),
    { now: () => sentAt },
  );
}

function pauseAlana(state: AppState, sentAt = T0) {
  processMessage(
    state,
    msg({
      externalId: "alana-pause",
      authorId: "alana-lab@c.us",
      authorRole: "alana",
      text: "já estou falando com o motorista",
      sentAt: sentAt.toISOString(),
    }),
    { now: () => sentAt },
  );
}

describe("POST /resume pending question", () => {
  it("sends one resume question when the pause expired and a pending record exists", async () => {
    const state = applyChannelConfig(seedState(), channel);
    pauseAlana(state);
    withIncomplete(state, "inc-after-pause", new Date(T0.getTime() + 60 * 1000));
    const sender = new RecordingSender();
    const result = await handleResume({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      clock: { now: () => new Date(T0.getTime() + 16 * 60 * 1000) },
    });
    assert.equal(result.body.decision, "resume_pending_question");
    assert.equal(sender.calls.length, 1);
    assert.equal(sender.calls[0].chatId, TEST_GROUP);
    assert.equal(sender.calls[0].text, "Faltam data e local/posto. Pode informar?");
    assert.equal((result.body.send as { attempted: boolean }).attempted, true);
  });

  it("does not send while the pause is still active", async () => {
    const state = applyChannelConfig(seedState(), channel);
    pauseAlana(state);
    withIncomplete(state, "inc-during", new Date(T0.getTime() + 60 * 1000));
    const sender = new RecordingSender();
    const result = await handleResume({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      clock: { now: () => new Date(T0.getTime() + 5 * 60 * 1000) },
    });
    assert.equal(result.body.reason, "pause_active");
    assert.equal(sender.calls.length, 0);
  });

  it("does not send when there is no incomplete pending record", async () => {
    const state = applyChannelConfig(seedState(), channel);
    const sender = new RecordingSender();
    const result = await handleResume({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      clock: { now: () => T0 },
    });
    assert.equal(result.body.reason, "no_pending");
    assert.equal(sender.calls.length, 0);
  });

  it("does not send to a conversation other than TEST_GROUP_JID", async () => {
    const state = applyChannelConfig(seedState(), channel);
    processMessage(
      state,
      msg({
        externalId: "inc-other",
        conversationId: OTHER,
        text: "abasteci 150 litros, deu 980, assinada",
      }),
      { now: () => T0 },
    );
    const sender = new RecordingSender();
    const result = await handleResume({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      requestedConversationId: OTHER,
      clock: { now: () => T0 },
    });
    assert.equal(result.body.reason, "not_test_group");
    assert.equal(sender.calls.length, 0);
  });

  it("does not send twice for the same pending record", async () => {
    const state = applyChannelConfig(seedState(), channel);
    withIncomplete(state, "inc-once");
    const sender = new RecordingSender();
    const cfg = runtime({ liveSend: true });
    const first = await handleResume({ runtime: cfg, state, sender, clock: { now: () => T0 } });
    const second = await handleResume({ runtime: cfg, state, sender, clock: { now: () => T0 } });
    assert.equal(first.body.decision, "resume_pending_question");
    assert.equal(second.body.reason, "already_asked");
    assert.equal(sender.calls.length, 1);
  });

  it("can resume two different records that share the same question text", async () => {
    const state = applyChannelConfig(seedState(), channel);
    withIncomplete(state, "inc-a", T0);
    withIncomplete(state, "inc-b", new Date(T0.getTime() + 1000));
    const sender = new RecordingSender();
    const cfg = runtime({ liveSend: true });
    const first = await handleResume({ runtime: cfg, state, sender, clock: { now: () => T0 } });
    const second = await handleResume({ runtime: cfg, state, sender, clock: { now: () => T0 } });
    assert.equal(first.body.decision, "resume_pending_question");
    assert.equal(second.body.decision, "resume_pending_question");
    assert.notEqual(first.body.recordId, second.body.recordId);
    assert.equal(sender.calls.length, 2);
    assert.equal(sender.calls[0].text, sender.calls[1].text);
    assert.equal(sender.calls[0].chatId, TEST_GROUP);
    assert.equal(sender.calls[1].chatId, TEST_GROUP);
  });

  it("calculates the question when LIVE_SEND=false but does not send", async () => {
    const state = applyChannelConfig(seedState(), channel);
    withIncomplete(state, "inc-dry");
    const sender = new RecordingSender();
    const result = await handleResume({
      runtime: runtime({ liveSend: false }),
      state,
      sender,
      clock: { now: () => T0 },
    });
    assert.equal(result.body.decision, "resume_pending_question");
    assert.equal((result.body.send as { reason: string }).reason, "live_send_disabled");
    assert.equal(sender.calls.length, 0);
    const later = await handleResume({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      clock: { now: () => T0 },
    });
    assert.equal(later.body.decision, "resume_pending_question");
    assert.equal(sender.calls.length, 1);
  });

  it("with LIVE_SEND=true still refuses a group that is not TEST_GROUP_JID even if allowlisted", async () => {
    const state = applyChannelConfig(seedState(), channel);
    withIncomplete(state, "inc-gate");
    const sender = new RecordingSender();
    const result = await handleResume({
      runtime: runtime({ liveSend: true }),
      state,
      sender,
      requestedConversationId: OTHER,
      clock: { now: () => T0 },
    });
    assert.equal(result.body.reason, "not_test_group");
    assert.equal(sender.calls.length, 0);
  });

  it("with LIVE_SEND=true does not send if TEST_GROUP_JID is not on the allowlist", async () => {
    const state = applyChannelConfig(seedState(), channel);
    withIncomplete(state, "inc-allow");
    const sender = new RecordingSender();
    const result = await handleResume({
      runtime: runtime({ liveSend: true, testGroupJid: "grupo-ausente@g.us" }),
      state,
      sender,
      clock: { now: () => T0 },
    });
    assert.equal(result.body.reason, "unauthorized_conversation");
    assert.equal(sender.calls.length, 0);
  });

  it("accepts x-resume-secret or webhook HMAC and rejects a bad secret", () => {
    const body = Buffer.from("{}");
    const secret = "test-secret";
    const headerOk = verifyResumeAuth({
      required: true,
      secret,
      rawBody: body,
      headers: { "x-resume-secret": secret },
    });
    assert.equal(headerOk.ok, true);
    const hmacOk = verifyResumeAuth({
      required: true,
      secret,
      rawBody: body,
      headers: { "x-openwa-signature": hmacSha256Hex(secret, body) },
    });
    assert.equal(hmacOk.ok, true);
    const bad = verifyResumeAuth({
      required: true,
      secret,
      rawBody: body,
      headers: { "x-resume-secret": "nope" },
    });
    assert.equal(bad.ok, false);
    const missing = verifyResumeAuth({
      required: true,
      secret,
      rawBody: body,
      headers: {},
    });
    assert.equal(missing.ok, false);
    const prefixed = verifyResumeAuth({
      required: true,
      secret,
      rawBody: body,
      headers: { "x-hub-signature-256": `sha256=${hmacSha256Hex(secret, body)}` },
    });
    assert.equal(prefixed.ok, true);
    assert.equal(createHmac("sha256", secret).update(body).digest("hex"), hmacSha256Hex(secret, body));
  });

  it("serves POST /resume locally with HMAC secret and does not send when LIVE_SEND=false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-http-"));
    const storePath = join(dir, "store.json");
    const app = createAppServer(runtime({ liveSend: false, storePath }));
    withIncomplete(app.getState(), "http-inc");
    await new Promise<void>((resolve) => {
      app.server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = app.server.address();
    assert.ok(addr && typeof addr === "object");
    const body = Buffer.from("{}");
    try {
      const denied = await fetch(`http://127.0.0.1:${addr.port}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(denied.status, 401);
      const allowed = await fetch(`http://127.0.0.1:${addr.port}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-resume-secret": "test-secret" },
        body,
      });
      assert.equal(allowed.status, 200);
      const json = (await allowed.json()) as { decision?: string; send?: { attempted?: boolean; reason?: string } };
      assert.equal(json.decision, "resume_pending_question");
      assert.equal(json.send?.attempted, false);
      assert.equal(json.send?.reason, "live_send_disabled");
    } finally {
      await new Promise<void>((resolve, reject) => {
        app.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
