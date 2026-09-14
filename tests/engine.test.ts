import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { considerResume, processMessage } from "../src/engine/process.ts";

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

describe("engine", () => {
  it("creates a fueling record from an authorized driver", () => {
    const state = seedState();
    const result = run(
      state,
      msg({
        externalId: "ok-1",
        text: "hoje abasteci 200 litros no posto X deu 1200 pago",
      }),
    );
    assert.equal(result.decision, "record_created");
    assert.equal(result.record?.kind, "abastecimento");
    assert.equal(result.record?.status, "completo");
    assert.equal(state.records.length, 1);
  });

  it("creates an incomplete record and asks only for missing fields", () => {
    const state = seedState();
    const result = run(
      state,
      msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }),
    );
    assert.equal(result.decision, "record_incomplete");
    assert.ok(result.record?.missing.includes("date"));
    assert.ok(result.record?.missing.includes("place"));
    assert.equal(result.record?.abastecimento?.payment, "assinada");
    assert.equal(result.replies.length, 1);
    assert.match(result.replies[0].text, /hoje|posto/i);
  });

  it("does not change operational records for an unauthorized conversation", () => {
    const state = seedState();
    const result = run(
      state,
      msg({
        externalId: "nope-1",
        conversationId: "conv-desconhecida",
        text: "hoje abasteci 200 litros no posto X deu 1200 pago",
      }),
    );
    assert.equal(result.decision, "rejected_unauthorized");
    assert.equal(state.records.length, 0);
    assert.equal(state.messages.length, 0);
    assert.equal(state.rejected.length, 1);
  });

  it("pauses 15 minutes after Alana speaks and still records during the pause", () => {
    const state = seedState();
    const pause = run(
      state,
      msg({
        externalId: "alana-1",
        authorId: "alana",
        authorRole: "alana",
        text: "já vi aqui",
      }),
    );
    assert.equal(pause.decision, "pause_updated");
    assert.ok(pause.pause);

    const during = run(
      state,
      msg({ externalId: "drv-1", text: "abasteci 150 litros, deu 980, assinada" }),
      new Date(T0.getTime() + 5 * 60 * 1000),
    );
    assert.equal(during.decision, "record_incomplete");
    assert.equal(during.replies.length, 0);
    assert.equal(state.records.length, 1);

    const tooSoon = considerResume(state, "conv-joao", {
      now: () => new Date(T0.getTime() + 10 * 60 * 1000),
    });
    assert.equal(tooSoon.length, 0);

    const after = considerResume(state, "conv-joao", {
      now: () => new Date(T0.getTime() + 16 * 60 * 1000),
    });
    assert.equal(after.length, 1);
    assert.equal(after[0].silentResume, true);
  });

  it("blocks proactive questions while a central suspension covers the driver", () => {
    const state = seedState();
    const now = new Date("2026-09-12T12:00:00.000Z");
    const cmd = run(
      state,
      msg({
        externalId: "cmd-1",
        conversationId: "conv-central",
        authorId: "alana",
        authorRole: "alana",
        text: "suspender motorista João de 2026-09-10 até 2026-09-15",
      }),
      now,
    );
    assert.equal(cmd.decision, "command_applied");
    assert.equal(state.suspensions.length, 1);

    const rec = run(
      state,
      msg({ externalId: "drv-s", text: "abasteci 150 litros, deu 980, assinada" }),
      now,
    );
    assert.equal(rec.decision, "record_incomplete");
    assert.equal(rec.replies.length, 0);
  });

  it("refuses an admin command coming from a driver", () => {
    const state = seedState();
    const result = run(
      state,
      msg({
        externalId: "drv-cmd",
        text: "suspender motorista Ana de 2026-09-10 até 2026-09-15",
      }),
    );
    assert.equal(result.decision, "command_refused");
    assert.equal(state.suspensions.length, 0);
  });

  it("keeps frete as viagem, not despesa", () => {
    const state = seedState();
    const result = run(
      state,
      msg({
        externalId: "f-1",
        conversationId: "conv-ana",
        authorId: "motorista-ana",
        text: "hoje frete de Barreiras para Recife, soja, 47 m3",
      }),
    );
    assert.equal(result.record?.kind, "viagem");
    assert.equal(state.records.filter((r) => r.kind === "despesa").length, 0);
  });

  it("treats audio_info and anexo_comprovante as different types", () => {
    const state = seedState();
    const audio = run(
      state,
      msg({
        externalId: "aud-1",
        type: "audio_info",
        text: "hoje gastei 150 com almoço pago",
      }),
    );
    const photo = run(
      state,
      msg({
        externalId: "pic-1",
        type: "anexo_comprovante",
        attachmentRef: "comprovante-1.jpg",
        text: undefined,
      }),
    );
    assert.equal(audio.message?.type, "audio_info");
    assert.equal(audio.record?.kind, "despesa");
    assert.equal(photo.decision, "attachment_stored");
    assert.equal(photo.record, undefined);
    assert.equal(state.messages[0].type, "audio_info");
    assert.equal(state.messages[1].type, "anexo_comprovante");
  });

  it("does not duplicate on reprocessing the same external id", () => {
    const state = seedState();
    const inbound = msg({
      externalId: "dup-1",
      text: "hoje abasteci 200 litros no posto X deu 1200 pago",
    });
    const first = run(state, inbound);
    const second = run(state, inbound);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.decision, "duplicate");
    assert.equal(state.records.length, 1);
    assert.equal(state.messages.length, 1);
  });

  it("ignores ordinary central chat instead of storing an ambiguous command", () => {
    const state = seedState();
    const result = run(
      state,
      msg({
        externalId: "central-oi",
        conversationId: "conv-central",
        authorId: "alana",
        authorRole: "alana",
        text: "oi",
      }),
    );
    assert.equal(result.decision, "ignored");
    assert.equal(result.replies.length, 0);
    assert.equal(state.commands.length, 0);
    assert.equal(state.suspensions.length, 0);
  });

  it("sets the 15-minute pause from Alana sentAt, not clock.now()", () => {
    const state = seedState();
    const sentAt = new Date("2026-09-09T12:00:00.000Z");
    const processedAt = new Date("2026-09-09T12:20:00.000Z");
    const pause = run(
      state,
      msg({
        externalId: "alana-late",
        authorId: "alana",
        authorRole: "alana",
        sentAt: sentAt.toISOString(),
        text: "já vi aqui",
      }),
      processedAt,
    );
    assert.equal(pause.pause?.silenceUntil, "2026-09-09T12:15:00.000Z");
    assert.notEqual(pause.pause?.silenceUntil, "2026-09-09T12:35:00.000Z");

    const duringWindow = run(
      state,
      msg({ externalId: "drv-on-time", text: "abasteci 150 litros, deu 980, assinada" }),
      new Date("2026-09-09T12:10:00.000Z"),
    );
    assert.equal(duringWindow.replies.length, 0);

    const afterWindow = run(
      state,
      msg({ externalId: "drv-late", text: "abasteci 150 litros, deu 980, assinada" }),
      processedAt,
    );
    assert.equal(afterWindow.replies.length, 1);
  });

  it("does not list an expired suspension as active", () => {
    const state = seedState();
    const applied = run(
      state,
      msg({
        externalId: "cmd-old",
        conversationId: "conv-central",
        authorId: "alana",
        authorRole: "alana",
        text: "suspender motorista João de 2026-09-01 até 2026-09-05",
      }),
      new Date("2026-09-02T12:00:00.000Z"),
    );
    assert.equal(applied.decision, "command_applied");

    const listed = run(
      state,
      msg({
        externalId: "cmd-list",
        conversationId: "conv-central",
        authorId: "alana",
        authorRole: "alana",
        text: "listar suspensoes",
      }),
      new Date("2026-09-12T12:00:00.000Z"),
    );
    assert.equal(listed.decision, "command_applied");
    assert.equal(listed.replies[0].text, "Nenhuma suspensão ativa.");
    assert.equal(state.suspensions[0].status, "aplicada");
  });

  it("does not pause from a spoofed authorRole when the JID is the driver", () => {
    const state = seedState();
    const result = run(
      state,
      msg({
        externalId: "spoof-1",
        authorId: "motorista-joao",
        authorRole: "alana",
        text: "já vi aqui",
      }),
    );
    assert.equal(result.decision, "ignored");
    assert.equal(state.pauses.length, 0);
  });

  it("keeps Alana pause local to the conversation where she spoke", () => {
    const state = seedState();
    run(
      state,
      msg({
        externalId: "alana-joao",
        authorId: "alana",
        authorRole: "alana",
        text: "já vi aqui",
      }),
    );
    const ana = run(
      state,
      msg({
        externalId: "ana-1",
        conversationId: "conv-ana",
        authorId: "motorista-ana",
        text: "abasteci 150 litros, deu 980, assinada",
      }),
    );
    assert.equal(ana.decision, "record_incomplete");
    assert.equal(ana.replies.length, 1);
    assert.equal(state.pauses.some((p) => p.conversationId === "conv-ana"), false);
  });

  it("does not renew pause on driver or bot messages", () => {
    const state = seedState();
    state.botIds = ["bot-lab@c.us"];
    const pause = run(
      state,
      msg({
        externalId: "alana-1",
        authorId: "alana",
        authorRole: "alana",
        text: "já vi aqui",
      }),
    );
    const until = pause.pause?.silenceUntil;
    run(
      state,
      msg({
        externalId: "drv-keep",
        text: "abasteci 150 litros, deu 980, assinada",
      }),
      new Date(T0.getTime() + 2 * 60 * 1000),
    );
    run(
      state,
      msg({
        externalId: "bot-keep",
        authorId: "bot-lab@c.us",
        authorRole: "bot",
        text: "Faltam data e local/posto. Pode informar?",
      }),
      new Date(T0.getTime() + 3 * 60 * 1000),
    );
    assert.equal(state.pauses[0].silenceUntil, until);
    assert.equal(state.pauses[0].lastAlanaMessageId, "alana-1");
  });

  it("treats 'agora não posso' as deferral, not administrative pause", () => {
    const state = seedState();
    const result = run(state, msg({ externalId: "def-1", text: "agora não posso" }));
    assert.equal(result.decision, "deferred");
    assert.equal(state.pauses.length, 0);
    assert.equal(state.records.length, 0);
    assert.equal(state.deferrals.length, 1);
    assert.equal(state.deferrals[0].reason, "motorista_adiou");
    assert.equal(result.replies.length, 1);
    assert.equal(result.replies[0].text, "Beleza, te pergunto depois.");
  });
});
