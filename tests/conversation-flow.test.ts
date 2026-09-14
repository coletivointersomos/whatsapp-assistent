import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessage } from "../src/engine/process.ts";
import { confirmationForKind, questionForMissing } from "../src/extraction/command.ts";

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

describe("fluidez conversacional", () => {
  it("complemento que fecha registro gera confirmação", () => {
    const state = seedState();
    run(state, msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }));
    const closed = run(state, msg({ externalId: "cmp-1", text: "foi hoje no posto X" }));
    assert.equal(closed.decision, "record_created");
    assert.equal(closed.replies.length, 1);
    assert.equal(closed.replies[0].text, "Fechado, registrei esse abastecimento.");
  });

  it("complemento que fecha registro durante pausa não responde", () => {
    const state = seedState();
    run(state, msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }));
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
    const closed = run(
      state,
      msg({
        externalId: "cmp-1",
        text: "foi hoje no posto X",
        sentAt: duringPause.toISOString(),
      }),
      duringPause,
    );
    assert.equal(closed.record?.status, "completo");
    assert.equal(closed.replies.length, 0);
  });

  it("duplicata não confirma de novo", () => {
    const state = seedState();
    run(state, msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }));
    const inbound = msg({ externalId: "cmp-1", text: "foi hoje no posto X" });
    const first = run(state, inbound);
    assert.equal(first.replies[0].text, confirmationForKind("abastecimento"));
    const again = run(state, inbound);
    assert.equal(again.decision, "duplicate");
    assert.equal(again.duplicate, true);
    assert.equal(again.replies.length, 0);
  });

  it("'agora não posso' registra adiamento e não cria registro", () => {
    const state = seedState();
    run(state, msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }));
    const deferred = run(state, msg({ externalId: "later-1", text: "agora não posso" }));
    assert.equal(deferred.decision, "deferred");
    assert.equal(deferred.replies[0].text, "Beleza, te pergunto depois.");
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].status, "incompleto");
    assert.equal(state.deferrals.length, 1);
    assert.equal(state.deferrals[0].recordId, state.records[0].id);
  });

  it("'te mando depois' registra adiamento", () => {
    const state = seedState();
    const deferred = run(state, msg({ externalId: "later-2", text: "te mando depois" }));
    assert.equal(deferred.decision, "deferred");
    assert.equal(state.deferrals[0].reason, "motorista_adiou");
    assert.equal(state.records.length, 0);
    assert.equal(deferred.replies[0].text, "Beleza, te pergunto depois.");
  });

  it("complemento natural 'foi no posto São João hoje'", () => {
    const state = seedState();
    const first = run(
      state,
      msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }),
    );
    const second = run(state, msg({ externalId: "cmp-1", text: "foi no posto São João hoje" }));
    assert.equal(second.record?.id, first.record?.id);
    assert.equal(second.record?.status, "completo");
    assert.equal(second.record?.abastecimento?.place, "posto São João");
    assert.equal(second.record?.abastecimento?.date, "2026-09-09");
    assert.equal(state.records.length, 1);
  });

  it("complemento natural 'pode colocar como assinada'", () => {
    const state = seedState();
    const first = run(state, msg({ externalId: "exp-1", text: "hoje gastei 150 com almoço" }));
    assert.ok(first.record?.missing.includes("payment"));
    const second = run(state, msg({ externalId: "exp-pay", text: "pode colocar como assinada" }));
    assert.equal(second.record?.id, first.record?.id);
    assert.equal(second.record?.despesa?.payment, "assinada");
    assert.equal(second.record?.despesa?.description, "almoço");
    assert.equal(second.decision, "record_created");
    assert.equal(second.replies[0].text, "Fechado, registrei essa despesa.");
  });

  it("complemento natural 'de Barreiras pra Recife'", () => {
    const state = seedState();
    const first = run(
      state,
      msg({ externalId: "trip-1", text: "viagem com milho 35 toneladas" }),
    );
    assert.ok(first.record?.missing.includes("origin"));
    assert.ok(first.record?.missing.includes("destination"));
    const second = run(state, msg({ externalId: "trip-route", text: "de Barreiras pra Recife" }));
    assert.equal(second.record?.id, first.record?.id);
    assert.equal(second.record?.viagem?.origin, "Barreiras");
    assert.equal(second.record?.viagem?.destination, "Recife");
    assert.equal(state.records.length, 1);
  });

  it("perguntas de pendência ficam mais curtas", () => {
    assert.equal(questionForMissing("abastecimento", ["place"]), "Qual foi o posto?");
    assert.equal(questionForMissing("abastecimento", ["date"]), "Foi hoje ou outro dia?");
    assert.equal(
      questionForMissing("abastecimento", ["date", "place"]),
      "Foi hoje? E qual foi o posto?",
    );
    assert.equal(questionForMissing("despesa", ["payment"]), "Foi pago ou ficou assinada?");
    assert.equal(
      questionForMissing("viagem", ["origin", "destination"]),
      "Qual foi a origem e o destino?",
    );
    for (const text of [
      questionForMissing("abastecimento", ["date", "place"]),
      questionForMissing("viagem", ["origin", "destination"]),
    ]) {
      assert.ok(text.length < 80);
      assert.doesNotMatch(text, /Faltam:/);
    }
  });

  it("adiamento durante pausa registra sem responder", () => {
    const state = seedState();
    run(
      state,
      msg({
        externalId: "alana-1",
        authorId: "alana",
        authorRole: "alana",
        text: "já vi",
      }),
    );
    const duringPause = new Date(T0.getTime() + 60 * 1000);
    const deferred = run(
      state,
      msg({
        externalId: "later-3",
        text: "mais tarde eu mando",
        sentAt: duringPause.toISOString(),
      }),
      duringPause,
    );
    assert.equal(deferred.decision, "deferred");
    assert.equal(deferred.replies.length, 0);
    assert.equal(state.deferrals.length, 1);
  });
});
