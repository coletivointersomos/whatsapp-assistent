import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessageAsync } from "../src/engine/process.ts";
import { coercePlanForRecord, looksLikeClosingConfirmation } from "../src/nlu/plan.ts";
import { validateNluResult } from "../src/nlu/schema.ts";
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

function plan(partial: NluResult): NluResult {
  return partial;
}

function scripted(script: (ctx: NluContext) => NluResult): NluProvider {
  return { name: "llm", interpret: script };
}

async function run(state: AppState, inbound: InboundMessage, nlu: NluProvider, logs?: Array<{ event: string; fields: Record<string, unknown> }>) {
  return processMessageAsync(state, inbound, {
    now: () => T0,
    nluFirst: true,
    nluEnabled: true,
    nlu,
    nluLog: logs ? (event, fields) => logs.push({ event, fields }) : undefined,
  });
}

describe("LLM conversational planner", () => {
  it("parses planner JSON with missing_fields and amount_brl", () => {
    const parsed = validateNluResult({
      intent: "record_event",
      action: "create_record",
      confidence: 0.95,
      record_type: "viagem",
      fields: { origin: "Curitiba", destination: "Nova Veneza" },
      missing_fields: ["material", "quantity"],
      is_complete: false,
      reply: "Entendi a viagem de Curitiba para Nova Veneza. Qual foi a carga e a quantidade?",
    });
    assert.equal(parsed.intent, "record_event");
    assert.equal(parsed.recordType, "viagem");
    assert.equal(parsed.isComplete, false);
    assert.deepEqual(parsed.missingFields, ["material", "quantity"]);
    assert.equal(parsed.fields?.origin, "Curitiba");
    const expense = validateNluResult({
      intent: "record_event",
      action: "create_record",
      record_type: "despesa",
      confidence: 0.9,
      fields: { amount_brl: 250, description: "eletricista", payment: "pix" },
      reply: "ok",
    });
    assert.equal(expense.fields?.amountBrl, 250);
    const blocked = validateNluResult({
      intent: "broadcast_request",
      action: "block",
      confidence: 0.9,
      reply: "não envio",
    });
    assert.equal(blocked.action, "block_broadcast");
  });

  it("corrects is_complete=true and blocks a closing reply when the trip is incomplete", () => {
    const nlu: NluResult = {
      intent: "record_event",
      action: "create_record",
      confidence: 0.99,
      reasoning_summary: "bad_complete",
      recordType: "viagem",
      isComplete: true,
      missingFields: [],
      reply: "Registrei a nova viagem de Curitiba para Nova Veneza.",
    };
    const coerced = coercePlanForRecord(nlu, {
      id: "reg-1",
      kind: "viagem",
      driverId: "motorista-joao",
      status: "incompleto",
      sourceMessageIds: ["a"],
      missing: ["material", "quantity", "unit"],
      viagem: { origin: "Curitiba", destination: "Nova Veneza", date: "2026-09-09" },
    });
    assert.equal(coerced.isComplete, false);
    assert.equal(coerced.planCorrection, "incomplete_marked_complete");
    assert.ok(looksLikeClosingConfirmation("Registrei a nova viagem de Curitiba para Nova Veneza."));
    assert.match(coerced.reply ?? "", /carga e a quantidade/i);
    assert.doesNotMatch(coerced.reply ?? "", /^Registrei a nova viagem/);
  });

  it("LLM plan for incomplete trip asks material/quantity and does not confirm", async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const nlu = scripted(() =>
      plan({
        intent: "record_event",
        action: "create_record",
        recordType: "viagem",
        confidence: 0.95,
        reasoning_summary: "new_trip",
        isComplete: true,
        fields: { origin: "Curitiba", destination: "Nova Veneza" },
        reply: "Registrei a nova viagem de Curitiba para Nova Veneza.",
      }),
    );
    const state = seedState();
    const out = await run(state, msg({ externalId: "trip-1", text: "nova viagem de curitiba para nova veneza" }), nlu, logs);
    assert.equal(out.decision, "record_incomplete");
    assert.equal(out.record?.kind, "viagem");
    assert.match(out.record?.viagem?.origin ?? "", /Curitiba/i);
    assert.match(out.record?.viagem?.destination ?? "", /Nova Veneza/i);
    assert.ok(out.record?.missing.includes("material"));
    assert.ok(out.record?.missing.includes("quantity"));
    assert.match(out.replies[0]?.text ?? "", /carga|quantidade/i);
    assert.doesNotMatch(out.replies[0]?.text ?? "", /eletricista/i);
    assert.ok(!looksLikeClosingConfirmation(out.replies[0]?.text ?? "x?"));
    assert.ok(logs.some((l) => l.event === "llm_plan_received"));
    assert.ok(logs.some((l) => l.event === "llm_plan_corrected"));
  });

  it("soja, 47 m3 completes the pending trip", async () => {
    const nlu = scripted((ctx) => {
      if (/nova viagem/i.test(ctx.message)) {
        return plan({
          intent: "record_event",
          action: "create_record",
          recordType: "viagem",
          confidence: 0.95,
          reasoning_summary: "new_trip",
          isComplete: false,
          missingFields: ["material", "quantity"],
          fields: { origin: "Curitiba", destination: "Nova Veneza" },
          reply: "Entendi a viagem de Curitiba para Nova Veneza. Qual foi a carga e a quantidade?",
        });
      }
      return plan({
        intent: "complete_record",
        action: "update_record",
        recordType: "viagem",
        confidence: 0.94,
        reasoning_summary: "cargo",
        isComplete: true,
        fields: { material: "soja", quantity: 47, unit: "m3" },
        reply: "Fechado, registrei essa viagem.",
      });
    });
    const state = seedState();
    await run(state, msg({ externalId: "trip-1", text: "nova viagem de curitiba para nova veneza" }), nlu);
    const done = await run(state, msg({ externalId: "trip-2", text: "soja, 47 m3" }), nlu);
    assert.equal(state.records.length, 1);
    assert.equal(done.record?.status, "completo");
    assert.match(done.record?.viagem?.material ?? "", /soja/i);
    assert.equal(done.record?.viagem?.quantity, 47);
    assert.match(done.record?.viagem?.unit ?? "", /m3|m³/i);
    assert.match(done.replies[0]?.text ?? "", /Fechado|registrei essa viagem/i);
  });

  it("electrician 250 pix asks exact date; outro dia is not ignored", async () => {
    const nlu = scripted((ctx) => {
      if (/eletricista/i.test(ctx.message) && !/250/.test(ctx.message) && !/outro dia/i.test(ctx.message)) {
        return plan({
          intent: "record_event",
          action: "create_record",
          recordType: "despesa",
          confidence: 0.9,
          reasoning_summary: "open",
          isComplete: false,
          fields: { description: "eletricista" },
          reply: "Entendi o gasto com eletricista. Qual foi o valor e como foi pago?",
        });
      }
      if (/250/.test(ctx.message)) {
        return plan({
          intent: "complete_record",
          action: "update_record",
          recordType: "despesa",
          confidence: 0.93,
          reasoning_summary: "pix",
          isComplete: false,
          missingFields: ["date"],
          fields: { amountBrl: 250, payment: "pix" },
          reply: "Registrei o gasto de R$ 250 com eletricista no pix. Qual foi o dia exato desse gasto?",
        });
      }
      return plan({
        intent: "complete_record",
        action: "update_record",
        recordType: "despesa",
        confidence: 0.85,
        reasoning_summary: "approx",
        fields: { approximate_date_text: "outro dia" },
        reply: "Certo. Você lembra o dia exato? Pode me mandar como 15/09, por exemplo.",
      });
    });
    const state = seedState();
    await run(state, msg({ externalId: "el-1", text: "teve um gasto extra com eletricista" }), nlu);
    const pix = await run(state, msg({ externalId: "el-2", text: "o gasto do eletricista foi 250 no pix" }), nlu);
    assert.ok(pix.record?.missing.includes("date"));
    assert.match(pix.replies[0]?.text ?? "", /dia exato/i);
    assert.doesNotMatch(pix.replies[0]?.text ?? "", /^Foi hoje ou outro dia\?$/);
    const approx = await run(state, msg({ externalId: "el-3", text: "outro dia" }), nlu);
    assert.equal(approx.decision, "record_incomplete");
    assert.match(approx.record?.despesa?.note ?? "", /outro dia/);
    assert.match(approx.replies[0]?.text ?? "", /dia exato/i);
    assert.equal(approx.record?.status, "incompleto");
  });

  it("zombie electrician pending is not the trip target", async () => {
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
    const nlu = scripted(() =>
      plan({
        intent: "record_event",
        action: "create_record",
        recordType: "viagem",
        confidence: 0.95,
        reasoning_summary: "trip",
        isComplete: false,
        fields: { origin: "Curitiba", destination: "Nova Veneza" },
        reply: "Entendi a viagem de Curitiba para Nova Veneza. Qual foi a carga e a quantidade?",
      }),
    );
    const out = await run(state, msg({ externalId: "trip-1", text: "nova viagem de curitiba para nova veneza" }), nlu);
    assert.equal(out.record?.kind, "viagem");
    assert.notEqual(out.record?.id, "reg-old-el");
    assert.doesNotMatch(out.replies[0]?.text ?? "", /eletricista/i);
  });

  it("blocks broadcast and real Sheets actions", async () => {
    const nlu = scripted((ctx) => {
      if (/coluna/i.test(ctx.message)) {
        return plan({
          intent: "sheet_change_request",
          action: "block",
          confidence: 0.9,
          reasoning_summary: "sheets",
          requiresConfirmation: true,
          reply: "Posso preparar a coluna observação, mas não altero o Sheets real sem confirmação.",
        });
      }
      return plan({
        intent: "broadcast_request",
        action: "block",
        confidence: 0.9,
        reasoning_summary: "bc",
        requiresConfirmation: true,
        reply: "Não envio mensagem em massa. Precisa confirmação explícita.",
      });
    });
    const state = seedState();
    const sheet = await run(
      state,
      msg({
        externalId: "ad-s",
        authorId: "alana",
        authorRole: "alana",
        conversationId: "conv-central",
        text: "cria coluna observação",
      }),
      nlu,
    );
    assert.equal(sheet.decision, "assisted");
    assert.match(sheet.replies[0]?.text ?? "", /Sheets real|confirmação/i);
    const before = state.conversations.length;
    const bc = await run(
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
    assert.match(bc.replies[0]?.text ?? "", /massa|confirmação/i);
    assert.equal(state.conversations.length, before);
  });

  it("uses deterministic fallback only when the LLM fails", async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const failed: NluProvider = { name: "llm", interpret: async () => unknownNlu("llm_failed") };
    const state = seedState();
    const out = await run(state, msg({ externalId: "fb-1", text: "teve um gasto extra com eletricista" }), failed, logs);
    assert.equal(out.record?.kind, "despesa");
    assert.ok(logs.some((l) => l.event === "llm_plan_rejected"));
    assert.equal(logs.some((l) => l.event === "llm_plan_applied"), false);

    const logsOk: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const ok = scripted(() =>
      plan({
        intent: "record_event",
        action: "create_record",
        recordType: "despesa",
        confidence: 0.9,
        reasoning_summary: "ok",
        isComplete: false,
        fields: { description: "eletricista" },
        reply: "Entendi o gasto com eletricista. Qual foi o valor e como foi pago?",
      }),
    );
    const applied = await run(
      seedState(),
      msg({ externalId: "ok-1", text: "teve um gasto extra com eletricista" }),
      ok,
      logsOk,
    );
    assert.equal(applied.replies[0]?.text, "Entendi o gasto com eletricista. Qual foi o valor e como foi pago?");
    assert.ok(logsOk.some((l) => l.event === "llm_plan_applied"));
    assert.equal(logsOk.some((l) => l.event === "llm_plan_rejected"), false);
  });
});
