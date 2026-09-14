import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyChannelConfig } from "../src/adapters/hermes/config.ts";
import { normalizeOpenWaEnvelope } from "../src/adapters/hermes/normalize.ts";
import type { ChannelConfig, OpenWaEnvelope } from "../src/adapters/hermes/types.ts";
import { seedState } from "../src/config/seed.ts";
import { considerResume, processMessage } from "../src/engine/process.ts";

const GROUP = "grupo-joao@g.us";
const OTHER_GROUP = "grupo-ana@g.us";
const ALANA = "alana-lab@c.us";
const BOT = "bot-lab@c.us";
const JOAO = "joao@c.us";
const ANA = "ana@c.us";
const STRANGER = "visitante@c.us";

const channel: ChannelConfig = {
  sessionId: "sessao-lab-substituivel",
  adminIds: [ALANA],
  botIds: [BOT],
  drivers: [
    { id: "motorista-joao", jids: [JOAO] },
    { id: "motorista-ana", jids: [ANA] },
  ],
  conversations: [
    { conversationId: GROUP, role: "motorista", driverId: "motorista-joao", driverJids: [JOAO] },
    { conversationId: OTHER_GROUP, role: "motorista", driverId: "motorista-ana", driverJids: [ANA] },
    { conversationId: "chat-central@c.us", role: "central" },
  ],
};

const T0 = new Date("2026-09-14T15:00:00.000Z");

function env(data: OpenWaEnvelope["data"]): OpenWaEnvelope {
  return { event: "message.received", sessionId: channel.sessionId, data };
}

function inboundFrom(partial: OpenWaEnvelope["data"]) {
  const normalized = normalizeOpenWaEnvelope(env(partial), channel);
  assert.equal(normalized.ok, true);
  if (!normalized.ok) throw new Error("normalize failed");
  return normalized.inbound;
}

describe("grupo autorizado com Alana + motorista + bot", () => {
  it("identifies roles from participant JIDs, not from the message text", () => {
    const state = applyChannelConfig(seedState(), channel);
    const alana = processMessage(
      state,
      inboundFrom({
        id: "g-alana",
        chatId: GROUP,
        participant: ALANA,
        isGroup: true,
        body: "eu não sou motorista, sou a Alana no texto",
        type: "chat",
        timestamp: T0.toISOString(),
      }),
      { now: () => T0 },
    );
    assert.equal(alana.decision, "pause_updated");
    assert.equal(alana.message?.authorRole, "alana");
    assert.equal(alana.message?.participantId, ALANA);
    assert.equal(state.records.length, 0);

    const driver = processMessage(
      state,
      inboundFrom({
        id: "g-joao",
        chatId: GROUP,
        participantId: JOAO,
        isGroup: true,
        body: "hoje abasteci 200 litros no posto X deu 1200 pago",
        type: "chat",
        timestamp: new Date(T0.getTime() + 16 * 60 * 1000).toISOString(),
      }),
      { now: () => new Date(T0.getTime() + 16 * 60 * 1000) },
    );
    assert.equal(driver.decision, "record_created");
    assert.equal(driver.record?.driverId, "motorista-joao");
  });

  it("records the driver during Alana's pause in that group only, without replying", () => {
    const state = applyChannelConfig(seedState(), channel);
    processMessage(
      state,
      inboundFrom({
        id: "pause",
        chatId: GROUP,
        author: ALANA,
        isGroup: true,
        body: "já vi o comprovante",
        type: "chat",
        timestamp: T0.toISOString(),
      }),
      { now: () => T0 },
    );

    const during = processMessage(
      state,
      inboundFrom({
        id: "during",
        chatId: GROUP,
        author: JOAO,
        isGroup: true,
        body: "abasteci 150 litros, deu 980, assinada",
        type: "chat",
        timestamp: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
      }),
      { now: () => new Date(T0.getTime() + 5 * 60 * 1000) },
    );
    assert.equal(during.decision, "record_incomplete");
    assert.equal(during.replies.length, 0);
    assert.equal(state.records.length, 1);

    const otherGroup = processMessage(
      state,
      inboundFrom({
        id: "ana-free",
        chatId: OTHER_GROUP,
        author: ANA,
        isGroup: true,
        body: "abasteci 150 litros, deu 980, assinada",
        type: "chat",
        timestamp: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
      }),
      { now: () => new Date(T0.getTime() + 5 * 60 * 1000) },
    );
    assert.equal(otherGroup.decision, "record_incomplete");
    assert.equal(otherGroup.replies.length, 1);

    const tooSoon = considerResume(state, GROUP, {
      now: () => new Date(T0.getTime() + 10 * 60 * 1000),
    });
    assert.equal(tooSoon.length, 0);

    const after = considerResume(state, GROUP, {
      now: () => new Date(T0.getTime() + 16 * 60 * 1000),
    });
    assert.equal(after.length, 1);
    assert.equal(after[0].silentResume, true);
  });

  it("ignores a stranger in the authorized group and does not attribute the record to João", () => {
    const state = applyChannelConfig(seedState(), channel);
    const result = processMessage(
      state,
      inboundFrom({
        id: "stranger",
        chatId: GROUP,
        author: STRANGER,
        isGroup: true,
        body: "hoje abasteci 200 litros no posto X deu 1200 pago",
        type: "chat",
        timestamp: T0.toISOString(),
      }),
      { now: () => T0 },
    );
    assert.equal(result.decision, "ignored");
    assert.equal(result.message?.authorRole, "desconhecido");
    assert.equal(state.records.length, 0);
    assert.equal(state.pauses.length, 0);
  });

  it("does not let a driver change rules from the group; only Alana in central can", () => {
    const state = applyChannelConfig(seedState(), channel);
    const refused = processMessage(
      state,
      inboundFrom({
        id: "drv-cmd",
        chatId: GROUP,
        author: JOAO,
        isGroup: true,
        body: "suspender motorista Ana de 2026-09-10 até 2026-09-15",
        type: "chat",
        timestamp: T0.toISOString(),
      }),
      { now: () => T0 },
    );
    assert.equal(refused.decision, "command_refused");
    assert.equal(state.suspensions.length, 0);

    const applied = processMessage(
      state,
      inboundFrom({
        id: "central-cmd",
        chatId: "chat-central@c.us",
        from: ALANA,
        body: "suspender motorista Ana de 2026-09-10 até 2026-09-15",
        type: "chat",
        timestamp: T0.toISOString(),
      }),
      { now: () => T0 },
    );
    assert.equal(applied.decision, "command_applied");
    assert.equal(state.suspensions.length, 1);
  });

  it("after the pause, asks again only if the pending record still exists", () => {
    const state = applyChannelConfig(seedState(), channel);
    processMessage(
      state,
      inboundFrom({
        id: "p1",
        chatId: GROUP,
        author: ALANA,
        isGroup: true,
        body: "já vi",
        type: "chat",
        timestamp: T0.toISOString(),
      }),
      { now: () => T0 },
    );
    processMessage(
      state,
      inboundFrom({
        id: "inc",
        chatId: GROUP,
        author: JOAO,
        isGroup: true,
        body: "abasteci 150 litros, deu 980, assinada",
        type: "chat",
        timestamp: new Date(T0.getTime() + 60 * 1000).toISOString(),
      }),
      { now: () => new Date(T0.getTime() + 60 * 1000) },
    );

    const later = new Date(T0.getTime() + 16 * 60 * 1000);
    const ping = processMessage(
      state,
      inboundFrom({
        id: "ping",
        chatId: GROUP,
        author: JOAO,
        isGroup: true,
        body: "oi",
        type: "chat",
        timestamp: later.toISOString(),
      }),
      { now: () => later },
    );
    assert.equal(ping.decision, "ignored");
    assert.equal(ping.replies.length, 1);
    assert.match(ping.replies[0].text, /data|local/i);

    const none = considerResume(applyChannelConfig(seedState(), channel), GROUP, {
      now: () => later,
    });
    assert.equal(none.length, 0);
  });
});
