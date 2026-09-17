import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessage, processMessageAsync } from "../src/engine/process.ts";
import type { NluContext, NluProvider, NluResult } from "../src/nlu/types.ts";
import { unknownNlu } from "../src/nlu/types.ts";

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

function result(partial: NluResult): NluResult {
  return partial;
}

function scriptedLlm(script: (ctx: NluContext) => NluResult, order: string[]): NluProvider {
  return {
    name: "llm",
    interpret(ctx) {
      order.push(ctx.message);
      return script(ctx);
    },
  };
}

async function runFirst(state: AppState, inbound: InboundMessage, nlu: NluProvider) {
  return processMessageAsync(state, inbound, {
    now: () => T0,
    nluFirst: true,
    nluEnabled: true,
    nlu,
  });
}

describe("LLM-first pipeline", () => {
  it("calls the LLM provider before the deterministic parser for authorized chat", async () => {
    const order: string[] = [];
    const nlu = scriptedLlm((ctx) => {
      order.push("llm");
      if (/eletricista/i.test(ctx.message) && !/250/.test(ctx.message)) {
        return result({
          intent: "record_event",
          action: "create_record",
          recordType: "despesa",
          confidence: 0.91,
          reasoning_summary: "open_expense",
          fields: { description: "eletricista" },
          reply: "Entendi o gasto com eletricista. Qual foi o valor e como foi pago?",
        });
      }
      return unknownNlu("nope");
    }, order);
    const state = seedState();
    const first = await runFirst(state, msg({ externalId: "el-1", text: "teve um gasto extra com eletricista" }), nlu);
    assert.equal(order[0], "teve um gasto extra com eletricista");
    assert.equal(order[1], "llm");
    assert.equal(first.decision, "record_incomplete");
    assert.equal(first.record?.kind, "despesa");
    assert.equal(state.records.length, 1);
    assert.match(first.replies[0]?.text ?? "", /valor/i);
    assert.doesNotMatch(first.replies[0]?.text ?? "", /^Foi hoje ou outro dia\?$/);
  });

  it("completes the pending electrician expense from pix follow-up", async () => {
    const nlu = scriptedLlm((ctx) => {
      if (/eletricista/i.test(ctx.message) && !/250/.test(ctx.message)) {
        return result({
          intent: "record_event",
          action: "create_record",
          recordType: "despesa",
          confidence: 0.9,
          reasoning_summary: "open_expense",
          fields: { description: "eletricista" },
          reply: "Entendi o gasto com eletricista. Qual foi o valor e como foi pago?",
        });
      }
      if (/250/.test(ctx.message) && /pix/i.test(ctx.message)) {
        return result({
          intent: "complete_record",
          action: "update_record",
          recordType: "despesa",
          confidence: 0.93,
          reasoning_summary: "complete_expense",
          fields: { amountBrl: 250, payment: "pix" },
          targetRecordId: ctx.openPendings[0]?.split(" ")[0],
          reply: "Fechado, registrei essa despesa de R$ 250 com eletricista no pix.",
        });
      }
      if (/outro dia/i.test(ctx.message)) {
        return result({
          intent: "complete_record",
          action: "update_record",
          recordType: "despesa",
          confidence: 0.7,
          reasoning_summary: "not_today",
          reply: "Certo. Qual foi o valor desse gasto com eletricista?",
        });
      }
      return unknownNlu("nope");
    }, []);
    const state = seedState();
    await runFirst(state, msg({ externalId: "el-1", text: "teve um gasto extra com eletricista" }), nlu);
    const mid = await runFirst(state, msg({ externalId: "el-2", text: "outro dia" }), nlu);
    assert.match(mid.replies[0]?.text ?? "", /valor/i);
    assert.equal(state.records.length, 1);
    const done = await runFirst(state, msg({ externalId: "el-3", text: "o gasto do eletricista foi 250 no pix" }), nlu);
    assert.equal(state.records.length, 1);
    assert.equal(done.record?.status, "incompleto");
    assert.equal(done.record?.despesa?.amountBrl, 250);
    assert.equal(done.record?.despesa?.payment, "pix");
    assert.equal(done.record?.despesa?.description, "eletricista");
    assert.ok(done.record?.missing.includes("date"));
    assert.match(done.replies[0]?.text ?? "", /hoje|dia/i);
  });

  it("records a complete fueling via LLM", async () => {
    const nlu = scriptedLlm(() => {
      return result({
        intent: "record_event",
        action: "create_record",
        recordType: "abastecimento",
        confidence: 0.95,
        reasoning_summary: "fuel",
        fields: { liters: 150, totalBrl: 980 },
        reply: "Fechado, registrei esse abastecimento.",
      });
    }, []);
    const state = seedState();
    const out = await runFirst(
      state,
      msg({
        externalId: "fuel-1",
        text: "abasteci 150 litros deu 980 no posto são joão hoje pago",
      }),
      nlu,
    );
    assert.equal(out.decision, "record_created");
    assert.equal(out.record?.status, "completo");
    assert.equal(out.record?.abastecimento?.liters, 150);
    assert.equal(out.record?.abastecimento?.totalBrl, 980);
    assert.equal(out.record?.abastecimento?.date, "2026-09-09");
  });

  it("stores operational status via LLM", async () => {
    const nlu = scriptedLlm(() => {
      return result({
        intent: "driver_status_update",
        action: "store_status_update",
        confidence: 0.88,
        reasoning_summary: "status",
        fields: { text: "parei em Cratos, chuva atrasou" },
        reply: "Anotei sua atualização operacional da viagem.",
      });
    }, []);
    const state = seedState();
    const out = await runFirst(state, msg({ externalId: "st-1", text: "parei em Cratos, chuva atrasou" }), nlu);
    assert.equal(out.decision, "assisted");
    assert.equal(state.statusUpdates.length, 1);
    assert.match(state.statusUpdates[0].text, /Cratos/);
    assert.equal(state.records.length, 0);
  });

  it("answers admin location from context without Sheets", async () => {
    const nlu = scriptedLlm((ctx) => {
      return result({
        intent: "trip_status_question",
        action: "answer_question",
        confidence: 0.9,
        reasoning_summary: "where",
        reply: `João está em viagem ${ctx.currentTrip?.origin ?? "?"} → ${ctx.currentTrip?.destination ?? "?"}.`,
      });
    }, []);
    const state = seedState();
    state.records.push({
      id: "reg-trip-1",
      kind: "viagem",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["t0"],
      missing: [],
      viagem: { origin: "Barreiras", destination: "Recife", date: "2026-09-09" },
    });
    const out = await runFirst(
      state,
      msg({
        externalId: "ad-1",
        authorId: "alana",
        authorRole: "alana",
        text: "onde estamos?",
      }),
      nlu,
    );
    assert.equal(out.decision, "assisted");
    assert.match(out.replies[0]?.text ?? "", /Barreiras/);
    assert.match(out.replies[0]?.text ?? "", /Recife/);
  });

  it("requires confirmation for Sheets and broadcast and does not execute them", async () => {
    const nlu = scriptedLlm((ctx) => {
      if (/coluna/i.test(ctx.message)) {
        return result({
          intent: "sheet_change_request",
          action: "sheet_change_request",
          confidence: 0.86,
          reasoning_summary: "sheet",
          requiresConfirmation: true,
          reply: "Isso entra como solicitação de alteração da planilha. Não altero o Sheets real daqui; precisa confirmação.",
        });
      }
      return result({
        intent: "broadcast_request",
        action: "broadcast_request",
        confidence: 0.86,
        reasoning_summary: "bc",
        requiresConfirmation: true,
        reply: "Posso preparar um pedido, mas não envio mensagem em massa. Precisa confirmação e ativação explícita.",
      });
    }, []);
    const state = seedState();
    const sheet = await runFirst(
      state,
      msg({
        externalId: "ad-s",
        authorId: "alana",
        authorRole: "alana",
        conversationId: "conv-central",
        text: "cria uma coluna observação",
      }),
      nlu,
    );
    assert.equal(sheet.decision, "assisted");
    assert.match(sheet.replies[0]?.text ?? "", /confirmação|Sheets real/i);
    const before = state.conversations.length;
    const bc = await runFirst(
      state,
      msg({
        externalId: "ad-b",
        authorId: "alana",
        authorRole: "alana",
        conversationId: "conv-central",
        text: "manda mensagem para todos os motoristas",
      }),
      nlu,
    );
    assert.equal(bc.decision, "assisted");
    assert.match(bc.replies[0]?.text ?? "", /não envio mensagem em massa/i);
    assert.equal(state.conversations.length, before);
  });

  it("falls back to the deterministic engine when the LLM fails", async () => {
    const nlu: NluProvider = {
      name: "llm",
      interpret: async () => unknownNlu("llm_failed"),
    };
    const state = seedState();
    const out = await runFirst(state, msg({ externalId: "el-f", text: "teve um gasto extra com eletricista" }), nlu);
    assert.equal(out.record?.kind, "despesa");
    assert.match(out.replies[0]?.text ?? "", /valor/i);
    assert.doesNotMatch(out.replies[0]?.text ?? "", /^Foi hoje ou outro dia\?$/);
  });

  it("keeps extract-first behavior when nluFirst is off", () => {
    const calls: string[] = [];
    const nlu: NluProvider = {
      name: "llm",
      interpret() {
        calls.push("llm");
        return unknownNlu("should_not_matter_first");
      },
    };
    const state = seedState();
    const out = processMessage(state, msg({ externalId: "el-d", text: "teve um gasto extra com eletricista" }), {
      now: () => T0,
      nluFirst: false,
      nlu,
    });
    assert.equal(out.record?.kind, "despesa");
    assert.equal(calls.length, 0);
    assert.match(out.replies[0]?.text ?? "", /valor/i);
  });
});
