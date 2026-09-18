import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import { applyDemoSessionReset } from "../src/domain/demoSession.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessage } from "../src/engine/process.ts";
import { buildNluContext } from "../src/nlu/context.ts";

const T0 = new Date("2026-09-09T12:00:00.000Z");
const OLD = new Date(T0.getTime() - 2 * 60 * 60 * 1000);

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

describe("pendência ativa vs zumbi", () => {
  it("old electrician pending + nova viagem creates a trip", () => {
    const state = seedState();
    run(state, msg({ externalId: "el-old", text: "teve um gasto extra com eletricista", sentAt: OLD.toISOString() }), OLD);
    const trip = run(state, msg({ externalId: "trip-1", text: "nova viagem de curitiba para nova veneza" }));
    assert.equal(trip.record?.kind, "viagem");
    assert.match(trip.record?.viagem?.origin ?? "", /curitiba/i);
    assert.match(trip.record?.viagem?.destination ?? "", /nova veneza/i);
    assert.doesNotMatch(trip.replies[0]?.text ?? "", /eletricista/i);
    assert.match(trip.replies[0]?.text ?? "", /carga|material|quantidade/i);
    const expenses = state.records.filter((r) => r.kind === "despesa");
    assert.equal(expenses.length, 1);
    assert.equal(expenses[0].status, "incompleto");
    assert.equal(state.records.filter((r) => r.kind === "viagem").length, 1);
  });

  it("recent electrician + 250 no pix completes the same expense", () => {
    const state = seedState();
    const first = run(state, msg({ externalId: "el-1", text: "teve um gasto extra com eletricista" }));
    const pix = run(state, msg({ externalId: "el-2", text: "250 no pix" }));
    assert.equal(pix.record?.id, first.record?.id);
    assert.equal(pix.record?.despesa?.amountBrl, 250);
    assert.equal(pix.record?.despesa?.payment, "pix");
    assert.equal(state.records.filter((r) => r.kind === "despesa").length, 1);
  });

  it("stale pending is not the NLU active target", () => {
    const state = seedState();
    run(state, msg({ externalId: "el-old", text: "teve um gasto extra com eletricista", sentAt: OLD.toISOString() }), OLD);
    const ctx = buildNluContext(state, msg({ externalId: "x", text: "nova viagem de curitiba para nova veneza" }), {
      authorRole: "motorista",
      isAdmin: false,
      now: T0,
      driverId: "motorista-joao",
    });
    assert.equal(ctx.openPendings.length, 0);
    assert.ok((ctx.openRecordsSummary ?? []).some((line) => /stale despesa/.test(line)));
  });

  it("sao joao still fills place after a fueling question", () => {
    const state = seedState();
    run(state, msg({ externalId: "ab-1", text: "abasteci 150 litros, deu 980, assinada" }));
    const place = run(state, msg({ externalId: "ab-2", text: "sao joao" }));
    assert.equal(place.record?.abastecimento?.place, "posto sao joao");
    assert.equal(state.records.length, 1);
  });

  it("hoje still fills date after a date question", () => {
    const state = seedState();
    run(state, msg({ externalId: "ab-1", text: "abasteci 150 litros, deu 980, assinada" }));
    const date = run(state, msg({ externalId: "ab-2", text: "hoje" }));
    assert.equal(date.record?.abastecimento?.date, "2026-09-09");
    assert.equal(state.records.length, 1);
  });

  it("demo session archives old incompletes without deleting them", () => {
    const state = seedState();
    run(state, msg({ externalId: "el-old", text: "teve um gasto extra com eletricista", sentAt: OLD.toISOString() }), OLD);
    const result = applyDemoSessionReset(state, "conv-joao", T0);
    assert.equal(result.archived, 1);
    assert.equal(state.records[0].archivedForDemo, true);
    assert.equal(state.records[0].status, "incompleto");
    const ctx = buildNluContext(state, msg({ externalId: "x", text: "oi" }), {
      authorRole: "motorista",
      isAdmin: false,
      now: T0,
      driverId: "motorista-joao",
    });
    assert.equal(ctx.openPendings.length, 0);
    const trip = run(state, msg({ externalId: "trip-1", text: "nova viagem de curitiba para nova veneza" }));
    assert.equal(trip.record?.kind, "viagem");
  });
});
