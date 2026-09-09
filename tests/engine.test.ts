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
    assert.match(result.replies[0].text, /data|local/i);
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
});
