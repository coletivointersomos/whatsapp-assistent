import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyChannelConfig } from "../src/adapters/hermes/config.ts";
import { normalizeOpenWaEnvelope } from "../src/adapters/hermes/normalize.ts";
import type { ChannelConfig, OpenWaEnvelope } from "../src/adapters/hermes/types.ts";
import { seedState } from "../src/config/seed.ts";
import { processMessage } from "../src/engine/process.ts";

const channel: ChannelConfig = {
  sessionId: "sessao-lab-substituivel",
  adminIds: ["alana-lab@c.us"],
  botIds: ["bot-lab@c.us"],
  drivers: [{ id: "motorista-joao", jids: ["chat-motorista-1@c.us"] }],
  conversations: [
    {
      conversationId: "grupo-lab-teste@g.us",
      role: "motorista",
      driverId: "motorista-joao",
      driverJids: ["chat-motorista-1@c.us"],
    },
    {
      conversationId: "chat-motorista-1@c.us",
      role: "motorista",
      driverId: "motorista-joao",
    },
    { conversationId: "chat-central@c.us", role: "central" },
  ],
};

function env(data: OpenWaEnvelope["data"], extra: Partial<OpenWaEnvelope> = {}): OpenWaEnvelope {
  return { event: "message.received", sessionId: channel.sessionId, data, ...extra };
}

describe("hermes/openwa adapter", () => {
  it("normalizes a test-group text payload to InboundMessage", () => {
    const result = normalizeOpenWaEnvelope(
      env({
        id: "g1",
        chatId: "grupo-lab-teste@g.us",
        author: "chat-motorista-1@c.us",
        fromMe: false,
        isGroup: true,
        body: "hoje abasteci 200 litros no posto X deu 1200 pago",
        type: "chat",
        timestamp: 1757520000,
      }),
      channel,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.inbound.conversationId, "grupo-lab-teste@g.us");
    assert.equal(result.inbound.authorId, "chat-motorista-1@c.us");
    assert.equal(result.inbound.authorRole, "motorista");
    assert.equal(result.inbound.participantId, "chat-motorista-1@c.us");
    assert.equal(result.inbound.type, "texto");
    assert.equal(result.inbound.externalId, "g1");
    assert.match(result.inbound.sentAt, /T/);
  });

  it("maps image to anexo and audio/ptt to audio_info", () => {
    const image = normalizeOpenWaEnvelope(
      env({
        id: "img-1",
        chatId: "chat-motorista-1@c.us",
        from: "chat-motorista-1@c.us",
        type: "image",
        caption: "comprovante",
        timestamp: 1757520000,
        media: { mimetype: "image/jpeg" },
      }),
      channel,
    );
    assert.equal(image.ok, true);
    if (image.ok) {
      assert.equal(image.inbound.type, "anexo_comprovante");
      assert.equal(image.inbound.attachmentRef, "image/jpeg");
    }

    const audio = normalizeOpenWaEnvelope(
      env({
        id: "aud-1",
        chatId: "chat-motorista-1@c.us",
        from: "chat-motorista-1@c.us",
        type: "ptt",
        body: "hoje gastei 150 com almoço pago",
        timestamp: 1757520000,
      }),
      channel,
    );
    assert.equal(audio.ok, true);
    if (audio.ok) assert.equal(audio.inbound.type, "audio_info");
  });

  it("rejects unauthorized conversation before the engine", () => {
    const result = normalizeOpenWaEnvelope(
      env({
        id: "x1",
        chatId: "grupo-nao-autorizado@g.us",
        author: "fulano@c.us",
        body: "hoje abasteci 200 litros no posto X deu 1200 pago",
        type: "chat",
        timestamp: 1757520000,
      }),
      channel,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "unauthorized_conversation");
  });

  it("rejects a different WhatsApp session without touching the engine", () => {
    const result = normalizeOpenWaEnvelope(
      env(
        {
          id: "s1",
          chatId: "grupo-lab-teste@g.us",
          author: "chat-motorista-1@c.us",
          body: "hoje abasteci 200 litros no posto X deu 1200 pago",
          type: "chat",
          timestamp: 1757520000,
        },
        { sessionId: "outro-numero" },
      ),
      channel,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "session_mismatch");
  });

  it("marks Alana by adminIds, not by human group name", () => {
    const result = normalizeOpenWaEnvelope(
      env({
        id: "a1",
        chatId: "grupo-lab-teste@g.us",
        author: "alana-lab@c.us",
        isGroup: true,
        body: "já vi aqui",
        type: "chat",
        timestamp: 1757520000,
      }),
      channel,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.inbound.authorRole, "alana");
  });

  it("feeds the engine for one test group and multiple authorized chats", () => {
    const state = applyChannelConfig(seedState(), channel);
    assert.equal(state.conversations.length, 3);
    assert.equal(state.admin.id, "alana-lab@c.us");

    const group = normalizeOpenWaEnvelope(
      env({
        id: "ok-g",
        chatId: "grupo-lab-teste@g.us",
        author: "chat-motorista-1@c.us",
        body: "hoje abasteci 200 litros no posto X deu 1200 pago",
        type: "chat",
        timestamp: 1757520000,
      }),
      channel,
    );
    assert.equal(group.ok, true);
    if (!group.ok) return;
    const g = processMessage(state, group.inbound, { now: () => new Date(group.inbound.sentAt) });
    assert.equal(g.decision, "record_created");

    const dm = normalizeOpenWaEnvelope(
      env({
        id: "ok-dm",
        chatId: "chat-motorista-1@c.us",
        from: "chat-motorista-1@c.us",
        body: "hoje gastei 150 com almoço pago",
        type: "chat",
        timestamp: 1757520600,
      }),
      channel,
    );
    assert.equal(dm.ok, true);
    if (!dm.ok) return;
    const d = processMessage(state, dm.inbound, { now: () => new Date(dm.inbound.sentAt) });
    assert.equal(d.decision, "record_created");
    assert.equal(d.record?.kind, "despesa");
  });

  it("reads group participant from participant/participantId when author is absent", () => {
    const result = normalizeOpenWaEnvelope(
      env({
        id: "p1",
        chatId: "grupo-lab-teste@g.us",
        isGroup: true,
        participant: "chat-motorista-1@c.us",
        body: "hoje abasteci 200 litros no posto X deu 1200 pago",
        type: "chat",
        timestamp: 1757520000,
      }),
      channel,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.inbound.authorId, "chat-motorista-1@c.us");
    assert.equal(result.inbound.participantId, "chat-motorista-1@c.us");
    assert.equal(result.inbound.authorRole, "motorista");
  });

  it("ignores the bot's own messages via fromMe and via botIds", () => {
    const fromMe = normalizeOpenWaEnvelope(
      env({
        id: "bot-1",
        chatId: "grupo-lab-teste@g.us",
        author: "bot-lab@c.us",
        fromMe: true,
        body: "Faltam data e local/posto. Pode informar?",
        type: "chat",
        timestamp: 1757520000,
      }),
      channel,
    );
    assert.equal(fromMe.ok, false);
    if (!fromMe.ok) assert.equal(fromMe.reason, "self_or_status");

    const echo = normalizeOpenWaEnvelope(
      env({
        id: "bot-2",
        chatId: "grupo-lab-teste@g.us",
        author: "bot-lab@c.us",
        fromMe: false,
        isGroup: true,
        body: "Faltam data e local/posto. Pode informar?",
        type: "chat",
        timestamp: 1757520000,
      }),
      channel,
    );
    assert.equal(echo.ok, false);
    if (!echo.ok) assert.equal(echo.reason, "self_or_status");
  });

  it("does not treat an unknown group participant as the principal driver", () => {
    const result = normalizeOpenWaEnvelope(
      env({
        id: "unk-1",
        chatId: "grupo-lab-teste@g.us",
        author: "outro-participante@c.us",
        isGroup: true,
        body: "hoje abasteci 200 litros no posto X deu 1200 pago",
        type: "chat",
        timestamp: 1757520000,
      }),
      channel,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.inbound.authorRole, "desconhecido");
  });
});
