import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessage } from "../src/engine/process.ts";

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

describe("complemento de pendência por texto", () => {
  it("abastecimento incompleto + 'foi hoje no posto X' completa o mesmo registro", () => {
    const state = seedState();
    const first = run(
      state,
      msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }),
    );
    assert.equal(first.decision, "record_incomplete");
    assert.equal(first.replies[0].text, "Foi hoje? E qual foi o posto?");

    const second = run(state, msg({ externalId: "cmp-1", text: "foi hoje no posto X" }));
    assert.equal(second.decision, "record_created");
    assert.equal(second.record?.id, first.record?.id);
    assert.equal(second.record?.status, "completo");
    assert.equal(second.record?.abastecimento?.date, "2026-09-09");
    assert.equal(second.record?.abastecimento?.place, "posto X");
    assert.equal(second.record?.abastecimento?.liters, 150);
    assert.equal(second.record?.abastecimento?.payment, "assinada");
    assert.deepEqual(second.record?.missing, []);
    assert.equal(second.replies.length, 1);
    assert.equal(second.replies[0].text, "Fechado, registrei esse abastecimento.");
  });

  it("não cria segundo registro ao completar a pendência", () => {
    const state = seedState();
    run(state, msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }));
    run(state, msg({ externalId: "cmp-1", text: "foi hoje no posto X" }));
    assert.equal(state.records.length, 1);
  });

  it("sourceMessageIds contém a mensagem original e a de complemento", () => {
    const state = seedState();
    run(state, msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }));
    run(state, msg({ externalId: "cmp-1", text: "foi hoje no posto X" }));
    assert.deepEqual(state.records[0].sourceMessageIds, ["inc-1", "cmp-1"]);
  });

  it("complemento parcial mantém incompleto e pergunta só o restante", () => {
    const state = seedState();
    run(state, msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }));
    const partial = run(state, msg({ externalId: "cmp-date", text: "hoje" }));
    assert.equal(partial.decision, "record_incomplete");
    assert.equal(state.records.length, 1);
    assert.equal(partial.record?.abastecimento?.date, "2026-09-09");
    assert.deepEqual(partial.record?.missing, ["place"]);
    assert.equal(partial.replies.length, 1);
    assert.equal(partial.replies[0].text, "Qual foi o posto?");
    assert.doesNotMatch(partial.replies[0].text, /hoje|data/i);
  });

  it("conversa pausada atualiza o registro, mas não envia resposta", () => {
    const state = seedState();
    const created = run(
      state,
      msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }),
    );
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
    const complement = run(
      state,
      msg({
        externalId: "cmp-1",
        text: "foi hoje no posto X",
        sentAt: duringPause.toISOString(),
      }),
      duringPause,
    );
    assert.equal(complement.decision, "record_created");
    assert.equal(complement.record?.id, created.record?.id);
    assert.equal(complement.record?.status, "completo");
    assert.equal(complement.replies.length, 0);
    assert.equal(state.records.length, 1);
  });

  it("mensagem sem pendência aberta continua seguindo o fluxo normal", () => {
    const state = seedState();
    const ignored = run(state, msg({ externalId: "orphan", text: "foi hoje no posto X" }));
    assert.equal(ignored.decision, "ignored");
    assert.equal(state.records.length, 0);

    const created = run(
      state,
      msg({
        externalId: "full-1",
        text: "hoje abasteci 200 litros no posto X deu 1200 pago",
      }),
    );
    assert.equal(created.decision, "record_created");
    assert.equal(created.replies.length, 0);
    assert.equal(state.records.length, 1);
  });

  it("complemento de viagem preenche quantidade e unidade no mesmo registro", () => {
    const state = seedState();
    const first = run(
      state,
      msg({ externalId: "trip-1", text: "viagem de Barreiras para Recife" }),
    );
    assert.equal(first.decision, "record_incomplete");
    assert.equal(first.record?.kind, "viagem");
    assert.ok(first.record?.missing.includes("quantity"));
    assert.ok(first.record?.missing.includes("unit"));

    const second = run(state, msg({ externalId: "trip-qty", text: "47 m3" }));
    assert.equal(second.record?.id, first.record?.id);
    assert.equal(state.records.length, 1);
    assert.equal(second.record?.viagem?.quantity, 47);
    assert.equal(second.record?.viagem?.unit, "m³");
    assert.equal(second.record?.viagem?.origin, "Barreiras");
    assert.ok(second.record?.missing.includes("material"));
    assert.equal(second.decision, "record_incomplete");
    assert.equal(second.replies.length, 1);
    assert.doesNotMatch(second.replies[0].text, /quantidade|unidade da carga/i);
  });

  it("complemento de despesa preenche pagamento e descrição no mesmo registro", () => {
    const state = seedState();
    const first = run(state, msg({ externalId: "exp-1", text: "hoje gastei 150" }));
    assert.equal(first.decision, "record_incomplete");
    assert.ok(first.record?.missing.includes("description"));
    assert.ok(first.record?.missing.includes("payment"));

    const second = run(state, msg({ externalId: "exp-cmp", text: "foi almoço, assinada" }));
    assert.equal(second.decision, "record_created");
    assert.equal(second.record?.id, first.record?.id);
    assert.equal(state.records.length, 1);
    assert.equal(second.record?.despesa?.description, "almoço");
    assert.equal(second.record?.despesa?.payment, "assinada");
    assert.equal(second.record?.despesa?.amountBrl, 150);
    assert.equal(second.replies.length, 1);
    assert.equal(second.replies[0].text, "Fechado, registrei essa despesa.");
  });

  it("texto de complemento não precisa repetir a categoria", () => {
    const state = seedState();
    run(state, msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }));
    const second = run(state, msg({ externalId: "cmp-1", text: "hoje no posto X" }));
    assert.equal(second.decision, "record_created");
    assert.equal(state.records.length, 1);
    assert.equal(second.record?.kind, "abastecimento");
  });
});
