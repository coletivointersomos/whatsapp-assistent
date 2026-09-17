import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import { processMessage } from "../src/engine/process.ts";
import {
  SCHEDULE_DEMO_NOW,
  scheduleDecisions,
  scheduleDemoState,
} from "../src/schedule/preview.ts";

describe("schedule preview", () => {
  it("sends daily collection to João and skips Ana on active suspension in the demo", () => {
    const lines = scheduleDecisions(scheduleDemoState(), SCHEDULE_DEMO_NOW);
    assert.equal(lines.find((l) => l.driverName === "João")?.action, "enviar coleta diária");
    assert.equal(lines.find((l) => l.driverName === "Ana")?.action, "não enviar, suspensão ativa");
  });

  it("does not send while the driver conversation is paused", () => {
    const state = seedState();
    const t0 = new Date("2026-09-09T12:00:00.000Z");
    processMessage(
      state,
      {
        externalId: "alana-pause",
        conversationId: "conv-joao",
        authorId: "alana",
        authorRole: "alana",
        sentAt: t0.toISOString(),
        type: "texto",
        text: "deixa comigo",
      },
      { now: () => t0 },
    );
    const now = new Date("2026-09-09T12:05:00.000Z");
    const joao = scheduleDecisions(state, now).find((l) => l.driverName === "João");
    assert.equal(joao?.action, "não enviar, conversa pausada");
  });

  it("asks about an open pending record instead of a new daily collection", () => {
    const state = seedState();
    const now = new Date("2026-09-09T12:00:00.000Z");
    processMessage(
      state,
      {
        externalId: "inc-1",
        conversationId: "conv-joao",
        authorId: "motorista-joao",
        authorRole: "motorista",
        sentAt: now.toISOString(),
        type: "texto",
        text: "abasteci 150 litros, deu 980, assinada",
      },
      { now: () => now },
    );
    const joao = scheduleDecisions(state, now).find((l) => l.driverName === "João");
    assert.equal(joao?.action, "enviar pergunta de pendência existente");
  });
});
