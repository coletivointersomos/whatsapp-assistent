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
      if (/eletricista/i.test(ctx.message) && !/250/.test(ctx.message) && !/outro dia/i.test(ctx.message)) {
        return result({
          intent: "record_event",
          action: "create_record",
          recordType: "despesa",
          confidence: 0.9,
          reasoning_summary: "open_expense",
          fields: { description: "eletricista" },
          reply: "Posso anotar o gasto com eletricista. Qual foi o valor e como pagou?",
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
          reply: "Registrei R$ 250 com eletricista no pix. Qual foi o dia exato desse gasto?",
        });
      }
      if (/outro dia/i.test(ctx.message)) {
        return result({
          intent: "complete_record",
          action: "update_record",
          recordType: "despesa",
          confidence: 0.8,
          reasoning_summary: "approx_date",
          reply: "Certo. Você lembra o dia exato? Pode ser algo como 15/09.",
        });
      }
      return unknownNlu("nope");
    }, []);
    const state = seedState();
    const first = await runFirst(state, msg({ externalId: "el-1", text: "teve um gasto extra com eletricista" }), nlu);
    assert.equal(first.replies[0]?.text, "Posso anotar o gasto com eletricista. Qual foi o valor e como pagou?");
    const done = await runFirst(state, msg({ externalId: "el-2", text: "o gasto do eletricista foi 250 no pix" }), nlu);
    assert.equal(state.records.length, 1);
    assert.equal(done.record?.id, first.record?.id);
    assert.equal(done.record?.despesa?.amountBrl, 250);
    assert.equal(done.record?.despesa?.payment, "pix");
    assert.ok(done.record?.missing.includes("date"));
    assert.equal(done.replies[0]?.text, "Registrei R$ 250 com eletricista no pix. Qual foi o dia exato desse gasto?");
    assert.doesNotMatch(done.replies[0]?.text ?? "", /^Foi hoje ou outro dia\?$/);
    const mid = await runFirst(state, msg({ externalId: "el-3", text: "outro dia" }), nlu);
    assert.equal(mid.decision, "record_incomplete");
    assert.equal(mid.replies[0]?.text, "Certo. Você lembra o dia exato? Pode ser algo como 15/09.");
    assert.match(mid.record?.despesa?.note ?? "", /outro dia/);
    assert.equal(state.records.length, 1);
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

  it("logs NLU fields without secrets", async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const nlu: NluProvider = {
      name: "llm",
      interpret: () =>
        result({
          intent: "record_event",
          action: "create_record",
          recordType: "despesa",
          confidence: 0.9,
          reasoning_summary: "ok",
          reply: "Posso anotar. Qual o valor?",
        }),
    };
    await processMessageAsync(seedState(), msg({ externalId: "log-1", text: "teve um gasto extra com eletricista" }), {
      now: () => T0,
      nluFirst: true,
      nlu,
      nluLog: (event, fields) => logs.push({ event, fields }),
    });
    const nluLog = logs.find((l) => l.event === "nlu_result");
    assert.ok(nluLog);
    assert.equal(nluLog?.fields.provider, "llm");
    assert.equal(nluLog?.fields.intent, "record_event");
    assert.equal(nluLog?.fields.action, "create_record");
    assert.equal(nluLog?.fields.hasReply, true);
    const blob = JSON.stringify(logs);
    assert.doesNotMatch(blob, /sk-/i);
    assert.doesNotMatch(blob, /HMAC/i);
    assert.doesNotMatch(blob, /Bearer /);
    assert.doesNotMatch(blob, /openrouter/i);
  });

  it("does not reuse an electrician pending when the driver reports a new expense event", async () => {
    const state = seedState();
    state.records.push({
      id: "reg-zombie",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "incompleto",
      sourceMessageIds: ["old-el"],
      missing: ["amountBrl", "payment", "date"],
      despesa: { description: "eletricista", vehicle: "caminhão 1" },
    });
    state.messages.push({
      externalId: "old-el",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista",
      sentAt: T0.toISOString(),
      processedAt: T0.toISOString(),
      type: "texto",
      text: "gasto extra eletricista",
    });
    const nlu = scriptedLlm(
      () =>
        result({
          intent: "record_event",
          action: "create_record",
          recordType: "despesa",
          confidence: 0.9,
          reasoning_summary: "open",
          fields: { description: "eletricista" },
          reply: "Qual foi o valor do eletricista?",
        }),
      [],
    );
    const out = await runFirst(state, msg({ externalId: "el-new", text: "teve um gasto extra com eletricista" }), nlu);
    assert.notEqual(out.record?.id, "reg-zombie");
    assert.equal(out.record?.kind, "despesa");
    assert.equal(state.records.filter((r) => r.kind === "despesa").length, 2);
  });

  it("asks exact date after pix even if the LLM fails", async () => {
    const nlu: NluProvider = {
      name: "llm",
      interpret: async () => unknownNlu("llm_failed"),
    };
    const state = seedState();
    await runFirst(state, msg({ externalId: "el-1", text: "teve um gasto extra com eletricista" }), nlu);
    const pix = await runFirst(state, msg({ externalId: "el-2", text: "o gasto do eletricista foi 250 no pix" }), nlu);
    assert.equal(pix.replies[0]?.text, "Registrei R$ 250 com eletricista no pix. Qual foi o dia exato desse gasto?");
    const approx = await runFirst(state, msg({ externalId: "el-3", text: "outro dia" }), nlu);
    assert.equal(approx.decision, "record_incomplete");
    assert.equal(approx.replies[0]?.text, "Certo. Você lembra o dia exato? Pode ser algo como 15/09.");
  });

  it("opens a new trip even if an old electrician pending exists and the LLM points at it", async () => {
    const old = new Date(T0.getTime() - 2 * 60 * 60 * 1000);
    const state = seedState();
    state.records.push({
      id: "reg-old-el",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "incompleto",
      sourceMessageIds: ["old-el"],
      missing: ["amountBrl", "payment", "date"],
      despesa: { description: "eletricista" },
    });
    state.messages.push({
      externalId: "old-el",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista",
      sentAt: old.toISOString(),
      processedAt: old.toISOString(),
      type: "texto",
      text: "teve um gasto extra com eletricista",
    });
    const nlu = scriptedLlm((ctx) => {
      assert.equal(ctx.openPendings.some((line) => /eletricista|despesa/.test(line)), false);
      assert.ok((ctx.openRecordsSummary ?? []).some((line) => /stale despesa/.test(line)));
      return result({
        intent: "complete_record",
        action: "update_record",
        recordType: "despesa",
        targetRecordId: "reg-old-el",
        confidence: 0.95,
        reasoning_summary: "wrong_target",
        reply: "Qual foi o valor do eletricista?",
      });
    }, []);
    const out = await runFirst(
      state,
      msg({ externalId: "trip-1", text: "nova viagem de curitiba para nova veneza" }),
      nlu,
    );
    assert.equal(out.record?.kind, "viagem");
    assert.match(out.record?.viagem?.origin ?? "", /curitiba/i);
    assert.match(out.record?.viagem?.destination ?? "", /nova veneza/i);
    assert.doesNotMatch(out.replies[0]?.text ?? "", /eletricista/i);
    assert.match(out.replies[0]?.text ?? "", /carga|material|quantidade/i);
    assert.equal(state.records.filter((r) => r.kind === "viagem").length, 1);
    assert.equal(state.records.find((r) => r.id === "reg-old-el")?.status, "incompleto");
  });

  it("uses a valid LLM reply for a new trip instead of a rigid template", async () => {
    const nlu = scriptedLlm(
      () =>
        result({
          intent: "record_event",
          action: "create_record",
          recordType: "viagem",
          confidence: 0.94,
          reasoning_summary: "new_trip",
          fields: { origin: "Curitiba", destination: "Nova Veneza" },
          reply: "Anotei a viagem Curitiba → Nova Veneza. Qual foi a carga e a quantidade?",
        }),
      [],
    );
    const out = await runFirst(
      seedState(),
      msg({ externalId: "trip-llm", text: "nova viagem de curitiba para nova veneza" }),
      nlu,
    );
    assert.equal(out.replies[0]?.text, "Anotei a viagem Curitiba → Nova Veneza. Qual foi a carga e a quantidade?");
  });
});
