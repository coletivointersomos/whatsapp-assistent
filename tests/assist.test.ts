import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeOpenWaEnvelope } from "../src/adapters/hermes/normalize.ts";
import type { ChannelConfig } from "../src/adapters/hermes/types.ts";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessage } from "../src/engine/process.ts";
import {
  CENTRAL_HELP,
  DRIVER_HELLO,
  DRIVER_MORNING,
  DRIVER_WHAT_TO_SEND,
} from "../src/extraction/assist.ts";

const T0 = new Date("2026-09-09T12:00:00.000Z");

function msg(partial: Partial<InboundMessage> & Pick<InboundMessage, "externalId" | "text">): InboundMessage {
  return {
    conversationId: "conv-joao",
    authorId: "motorista-joao",
    authorRole: "motorista",
    sentAt: T0.toISOString(),
    type: "texto",
    ...partial,
  };
}

function run(state: AppState, inbound: InboundMessage, now = T0) {
  return processMessage(state, inbound, { now: () => now });
}

describe("camada leve de assistente", () => {
  it("motorista manda alô e recebe orientação curta", () => {
    const result = run(seedState(), msg({ externalId: "a1", text: "alô" }));
    assert.equal(result.decision, "assisted");
    assert.equal(result.replies[0]?.text, DRIVER_HELLO);
    assert.equal(result.record, undefined);
  });

  it("motorista manda bom dia e recebe orientação curta", () => {
    const result = run(seedState(), msg({ externalId: "a2", text: "bom dia" }));
    assert.equal(result.decision, "assisted");
    assert.equal(result.replies[0]?.text, DRIVER_MORNING);
  });

  it("motorista pergunta o que eu mando aqui?", () => {
    const result = run(seedState(), msg({ externalId: "a3", text: "o que eu mando aqui?" }));
    assert.equal(result.decision, "assisted");
    assert.equal(result.replies[0]?.text, DRIVER_WHAT_TO_SEND);
  });

  it("admin pergunta onde estamos e a NLU usa o contexto local", () => {
    const result = run(
      seedState(),
      msg({
        externalId: "a4",
        authorId: "alana",
        authorRole: "alana",
        text: "onde estamos?",
      }),
    );
    assert.equal(result.decision, "assisted");
    assert.match(result.replies[0]?.text ?? "", /João|situação|viagem|pendência/i);
    assert.ok(result.pause);
  });

  it("central recebe ajuda", () => {
    const result = run(
      seedState(),
      msg({
        externalId: "a5",
        conversationId: "conv-central",
        authorId: "alana",
        authorRole: "alana",
        text: "ajuda",
      }),
    );
    assert.equal(result.decision, "assisted");
    assert.equal(result.replies[0]?.text, CENTRAL_HELP);
    assert.equal(result.command, undefined);
  });

  it("desconhecido não recebe resposta", () => {
    const result = run(
      seedState(),
      msg({
        externalId: "a6",
        authorId: "visitante",
        authorRole: "desconhecido",
        text: "alô",
      }),
    );
    assert.equal(result.decision, "ignored");
    assert.equal(result.replies.length, 0);
  });

  it("durante pausa não responde saudação", () => {
    const state = seedState();
    run(
      state,
      msg({
        externalId: "alana-1",
        authorId: "alana",
        authorRole: "alana",
        text: "já vi aqui",
      }),
    );
    const duringPause = new Date(T0.getTime() + 2 * 60 * 1000);
    const hello = run(
      state,
      msg({
        externalId: "a7",
        text: "alô",
        sentAt: duringPause.toISOString(),
      }),
      duringPause,
    );
    assert.equal(hello.decision, "ignored");
    assert.equal(hello.replies.length, 0);

    const admin = run(
      state,
      msg({
        externalId: "a8",
        authorId: "alana",
        authorRole: "alana",
        text: "quem é você?",
        sentAt: duringPause.toISOString(),
      }),
      duringPause,
    );
    assert.equal(admin.decision, "assisted");
    assert.match(admin.replies[0]?.text ?? "", /assistente operacional/i);
    assert.ok(admin.pause);
  });

  it("bot/fromMe é ignorado", () => {
    const state = seedState();
    state.botIds = ["bot-lab@c.us"];
    const bot = run(
      state,
      msg({
        externalId: "bot-1",
        authorId: "bot-lab@c.us",
        authorRole: "bot",
        text: "alô",
      }),
    );
    assert.equal(bot.decision, "ignored");
    assert.equal(bot.replies.length, 0);

    const channel: ChannelConfig = {
      sessionId: "sessao-lab-substituivel",
      adminIds: ["alana"],
      botIds: ["bot-lab@c.us"],
      conversations: [
        { conversationId: "conv-joao", role: "motorista", driverId: "motorista-joao" },
      ],
    };
    const fromMe = normalizeOpenWaEnvelope(
      {
        event: "message.received",
        sessionId: channel.sessionId,
        data: {
          id: "me-1",
          chatId: "conv-joao",
          from: "bot-lab@c.us",
          fromMe: true,
          body: "alô",
          type: "chat",
          timestamp: T0.toISOString(),
        },
      },
      channel,
    );
    assert.equal(fromMe.ok, false);
    if (!fromMe.ok) assert.equal(fromMe.reason, "self_or_status");
  });

  it("texto aleatório sem intenção clara continua ignorado", () => {
    const result = run(seedState(), msg({ externalId: "rand", text: "blz vlw" }));
    assert.equal(result.decision, "ignored");
    assert.equal(result.replies.length, 0);
    assert.equal(result.record, undefined);
  });

  it("registro operacional continua tendo prioridade sobre conversa leve", () => {
    const result = run(
      seedState(),
      msg({ externalId: "op-1", text: "hoje abasteci 200 litros no posto X deu 1200 pago" }),
    );
    assert.equal(result.decision, "record_created");
    assert.equal(result.record?.kind, "abastecimento");
    assert.notEqual(result.replies[0]?.text, DRIVER_HELLO);
  });
});
