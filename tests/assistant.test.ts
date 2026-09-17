import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessageAsync } from "../src/engine/process.ts";
import type { AssistantContext, AssistantProvider, AssistantResponse } from "../src/assistant/types.ts";
import { parseAssistantResponse } from "../src/assistant/schema.ts";

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

function script(fn: (ctx: AssistantContext) => AssistantResponse): AssistantProvider {
  return { name: "assistant-test", interpret: fn };
}

async function run(state: AppState, inbound: InboundMessage, assistant: AssistantProvider, logs?: Array<{ event: string; fields?: Record<string, unknown> }>) {
  return processMessageAsync(state, inbound, {
    now: () => T0,
    assistant,
    assistantFirst: true,
    nluFirst: false,
    nluLog: logs ? (event, fields) => logs.push({ event, fields }) : undefined,
  });
}

describe("assistant product runtime", () => {
  it("parses composed message plus actions", () => {
    const parsed = parseAssistantResponse({
      message: "Entendi. Vou abrir a viagem.",
      actions: [
        {
          type: "record.create",
          recordType: "viagem",
          fields: { origin: "Curitiba", destination: "Nova Veneza" },
          missingFields: ["material", "quantity"],
        },
      ],
      confidence: 0.94,
    });
    assert.match(parsed.message, /Entendi/);
    assert.equal(parsed.actions[0]?.type, "record.create");
  });

  it("opens a trip then completes it with soja 47 m3 using the LLM message", async () => {
    const assistant = script((ctx) => {
      if (/nova viagem/i.test(ctx.message)) {
        return {
          message: "Entendi. Vou abrir a viagem de Curitiba para Nova Veneza. Qual foi a carga e a quantidade?",
          actions: [
            {
              type: "record.create",
              recordType: "viagem",
              fields: { origin: "Curitiba", destination: "Nova Veneza" },
              missingFields: ["material", "quantity"],
            },
          ],
          confidence: 0.94,
        };
      }
      const pendingId = ctx.openPendings[0]?.split(" ")[0] ?? "";
      return {
        message: "Fechado, registrei a viagem de Curitiba para Nova Veneza com soja, 47 m³.",
        actions: [
          {
            type: "record.update",
            recordId: pendingId,
            fields: { material: "soja", quantity: 47, unit: "m³" },
            missingFields: [],
          },
        ],
        confidence: 0.93,
      };
    });
    const state = seedState();
    const first = await run(state, msg({ externalId: "t1", text: "nova viagem de curitiba para nova veneza" }), assistant);
    assert.equal(first.decision, "record_incomplete");
    assert.match(first.replies[0]?.text ?? "", /carga e a quantidade/i);
    assert.doesNotMatch(first.replies[0]?.text ?? "", /^Qual foi a carga/);
    const done = await run(state, msg({ externalId: "t2", text: "soja, 47 m3" }), assistant);
    assert.equal(state.records.length, 1);
    assert.equal(done.record?.status, "completo");
    assert.equal(done.record?.viagem?.material, "soja");
    assert.equal(done.record?.viagem?.quantity, 47);
    assert.equal(done.record?.viagem?.unit, "m³");
    assert.match(done.replies[0]?.text ?? "", /soja/i);
    assert.match(done.replies[0]?.text ?? "", /47/i);
    assert.doesNotMatch(done.replies[0]?.text ?? "", /unidade da carga/i);
  });

  it("records an electrician expense through a natural three-step conversation", async () => {
    const assistant = script((ctx) => {
      if (/eletricista/i.test(ctx.message) && !/250/.test(ctx.message) && !/ontem/i.test(ctx.message)) {
        return {
          message: "Beleza, anotei o gasto com eletricista. Qual foi o valor e como pagou?",
          actions: [
            {
              type: "record.create",
              recordType: "despesa",
              fields: { description: "eletricista" },
              missingFields: ["amountBrl", "payment", "date"],
            },
          ],
          confidence: 0.9,
        };
      }
      const pendingId = ctx.openPendings[0]?.split(" ")[0] ?? "";
      if (/250/.test(ctx.message)) {
        return {
          message: "Registrei R$ 250 no pix com o eletricista. Foi ontem ou você lembra a data?",
          actions: [
            {
              type: "record.update",
              recordId: pendingId,
              fields: { amountBrl: 250, payment: "pix" },
              missingFields: ["date"],
            },
          ],
          confidence: 0.92,
        };
      }
      return {
        message: "Fechado, registrei a despesa de R$ 250 com eletricista no pix, ontem.",
        actions: [
          {
            type: "record.update",
            recordId: pendingId,
            fields: { date: "2026-09-08" },
            missingFields: [],
          },
        ],
        confidence: 0.93,
      };
    });
    const state = seedState();
    await run(state, msg({ externalId: "e1", text: "teve um gasto com eletricista" }), assistant);
    const pix = await run(state, msg({ externalId: "e2", text: "250 no pix" }), assistant);
    assert.equal(pix.record?.despesa?.amountBrl, 250);
    assert.equal(pix.record?.despesa?.payment, "pix");
    assert.match(pix.replies[0]?.text ?? "", /pix/i);
    assert.doesNotMatch(pix.replies[0]?.text ?? "", /^Foi hoje ou outro dia\?$/);
    const done = await run(state, msg({ externalId: "e3", text: "foi ontem" }), assistant);
    assert.equal(done.record?.status, "completo");
    assert.equal(done.record?.despesa?.date, "2026-09-08");
    assert.match(done.replies[0]?.text ?? "", /eletricista/i);
  });

  it("stores operational status without creating a record", async () => {
    const assistant = script(() => ({
      message: "Anotei: parado em Cratos por atraso de chuva. Qualquer mudança me avisa.",
      actions: [{ type: "status.create", text: "parei em Cratos, chuva atrasou" }],
      confidence: 0.9,
    }));
    const state = seedState();
    const out = await run(state, msg({ externalId: "s1", text: "parei em Cratos, chuva atrasou" }), assistant);
    assert.equal(out.decision, "assisted");
    assert.equal(state.records.length, 0);
    assert.equal(state.statusUpdates.length, 1);
    assert.match(state.statusUpdates[0].text, /Cratos/);
    assert.match(out.replies[0]?.text ?? "", /Cratos/i);
  });

  it("answers admin location from local trip and status context", async () => {
    const state = seedState();
    state.records.push({
      id: "reg-trip",
      kind: "viagem",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["t0"],
      missing: [],
      viagem: { origin: "Curitiba", destination: "Nova Veneza", material: "soja", quantity: 47, unit: "m³" },
    });
    state.statusUpdates.push({
      id: "st-1",
      conversationId: "conv-joao",
      driverId: "motorista-joao",
      tripRecordId: "reg-trip",
      text: "parado em Cratos por atraso de chuva",
      sentAt: T0.toISOString(),
      sourceMessageId: "st-src",
    });
    const assistant = script((ctx) => ({
      message: `Estamos acompanhando a viagem de ${ctx.currentTrip?.origin} para ${ctx.currentTrip?.destination}. A última atualização foi: ${ctx.lastStatusUpdate?.text}.`,
      actions: [],
      confidence: 0.9,
    }));
    const out = await run(
      state,
      msg({
        externalId: "a1",
        authorId: "alana",
        authorRole: "alana",
        conversationId: "conv-central",
        text: "onde estamos?",
      }),
      assistant,
    );
    assert.equal(out.decision, "assisted");
    assert.match(out.replies[0]?.text ?? "", /Curitiba/);
    assert.match(out.replies[0]?.text ?? "", /Cratos/);
  });

  it("asks confirmation for broadcast and does not send", async () => {
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const before = seedState();
    const convCount = before.conversations.length;
    const assistant = script(() => ({
      message: "Posso preparar essa cobrança para os motoristas, mas preciso da sua confirmação antes de enviar em massa.",
      actions: [
        {
          type: "broadcast.request",
          audience: "drivers",
          text: "Pessoal, enviem as pendências de abastecimento, despesa ou viagem de hoje.",
        },
      ],
      needsConfirmation: true,
      confidence: 0.9,
    }));
    const out = await run(
      before,
      msg({
        externalId: "bc1",
        authorId: "alana",
        authorRole: "alana",
        conversationId: "conv-central",
        text: "manda mensagem para todos os motoristas",
      }),
      assistant,
      logs,
    );
    assert.equal(out.decision, "assisted");
    assert.match(out.replies[0]?.text ?? "", /confirmação/i);
    assert.equal(before.conversations.length, convCount);
    assert.ok(logs.some((l) => l.event === "assistant_actions_blocked"));
  });

  it("answers fuel totals from local records without Google", async () => {
    const state = seedState();
    state.records.push({
      id: "reg-fuel",
      kind: "abastecimento",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["f0"],
      missing: [],
      abastecimento: { date: "2026-09-09", liters: 150, totalBrl: 980, place: "posto X", payment: "pago" },
    });
    const assistant = script((ctx) => ({
      message: `Pelos registros locais, o combustível de hoje deu R$ ${ctx.totals.fuelBrlToday}. Não consultei o Google.`,
      actions: [{ type: "summary.query", scope: "fuel", period: "today" }],
      confidence: 0.9,
    }));
    const out = await run(
      state,
      msg({
        externalId: "fuel-q",
        authorId: "alana",
        authorRole: "alana",
        conversationId: "conv-central",
        text: "quanto deu de combustível hoje?",
      }),
      assistant,
    );
    assert.match(out.replies[0]?.text ?? "", /980/);
    assert.match(out.replies[0]?.text ?? "", /locais|Google/i);
  });
});
