import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessageAsync } from "../src/engine/process.ts";
import type { AssistantV2Context, AssistantV2Provider, AssistantV2Response } from "../src/assistant-v2/types.ts";

const SESSION = "2026-09-17T18:00:00.000Z";
const NOW = new Date("2026-09-17T19:00:00.000Z");

function msg(partial: Partial<InboundMessage> & Pick<InboundMessage, "externalId" | "text">): InboundMessage {
  return {
    conversationId: "conv-joao",
    authorId: "motorista-joao",
    authorRole: "motorista",
    sentAt: NOW.toISOString(),
    type: "texto",
    ...partial,
  };
}

function script(fn: (ctx: AssistantV2Context) => AssistantV2Response): AssistantV2Provider {
  return { name: "assistant-v2-test", interpret: fn };
}

function emptyTalk(message: string): AssistantV2Provider {
  return script(() => ({ message, actions: [], confidence: 0.9 }));
}

async function run(
  state: AppState,
  inbound: InboundMessage,
  assistant: AssistantV2Provider,
  logs?: Array<{ event: string; fields?: Record<string, unknown> }>,
) {
  return processMessageAsync(state, inbound, {
    now: () => NOW,
    assistantV2Enabled: true,
    assistantV2SessionStartedAt: SESSION,
    assistantV2: assistant,
    assistantFirst: false,
    nluFirst: false,
    nluLog: logs ? (event, fields) => logs.push({ event, fields }) : undefined,
  });
}

function plantOldTrip(state: AppState) {
  state.messages.push({
    externalId: "old-msg",
    conversationId: "conv-joao",
    authorId: "motorista-joao",
    authorRole: "motorista",
    sentAt: "2026-09-01T12:00:00.000Z",
    type: "texto",
    text: "nova viagem de recife para salvador",
    processedAt: "2026-09-01T12:00:00.000Z",
  });
  state.records.push({
    id: "reg-zombie",
    kind: "viagem",
    driverId: "motorista-joao",
    status: "incompleto",
    sourceMessageIds: ["old-msg"],
    missing: ["material", "quantity", "unit"],
    viagem: { origin: "Recife", destination: "Salvador", date: "2026-09-01" },
  });
}

describe("assistant v2 session runtime", () => {
  it("does not mention an old trip on alô", async () => {
    const state = seedState();
    plantOldTrip(state);
    const out = await run(
      state,
      msg({ externalId: "h1", text: "alô" }),
      script((ctx) => ({
        message: ctx.activeTrip
          ? `Continuando a viagem de ${ctx.activeTrip.origin} para ${ctx.activeTrip.destination}.`
          : "Opa, estou aqui. Pode me mandar abastecimento, despesa, viagem ou atualização da rota.",
        actions: [],
        confidence: 0.9,
      })),
    );
    assert.equal(out.decision, "assisted");
    assert.equal(
      out.replies[0]?.text,
      "Opa, estou aqui. Pode me mandar abastecimento, despesa, viagem ou atualização da rota.",
    );
    assert.doesNotMatch(out.replies[0]?.text ?? "", /Recife|Salvador/i);
    assert.equal(state.records.filter((r) => r.id !== "reg-zombie").length, 0);
  });

  it("creates a session trip from nova viagem de curitiba para nova veneza", async () => {
    const state = seedState();
    plantOldTrip(state);
    const out = await run(
      state,
      msg({ externalId: "t1", text: "nova viagem de curitiba para nova veneza" }),
      script(() => ({
        message: "Entendi a viagem de Curitiba para Nova Veneza. Qual foi a carga e a quantidade?",
        actions: [
          {
            type: "record.create",
            recordType: "viagem",
            fields: { origin: "Curitiba", destination: "Nova Veneza" },
          },
        ],
        confidence: 0.95,
      })),
    );
    assert.equal(out.decision, "record_incomplete");
    assert.equal(out.record?.id, "reg-t1");
    assert.equal(out.record?.viagem?.origin?.toLowerCase(), "curitiba");
    assert.equal(out.record?.viagem?.destination?.toLowerCase(), "nova veneza");
    assert.equal(
      out.replies[0]?.text,
      "Entendi a viagem de Curitiba para Nova Veneza. Qual foi a carga e a quantidade?",
    );
    assert.equal(state.records.find((r) => r.id === "reg-zombie")?.status, "incompleto");
  });

  it("completes the session trip with arroz, 55 m3", async () => {
    const state = seedState();
    const assistant = script((ctx) => {
      if (/nova viagem/i.test(ctx.message)) {
        return {
          message: "Entendi a viagem de Curitiba para Nova Veneza. Qual foi a carga e a quantidade?",
          actions: [
            {
              type: "record.create",
              recordType: "viagem",
              fields: { origin: "Curitiba", destination: "Nova Veneza" },
            },
          ],
          confidence: 0.95,
        };
      }
      return {
        message: "Fechado, registrei a viagem de Curitiba para Nova Veneza com arroz, 55 m³.",
        actions: [
          {
            type: "record.update",
            recordType: "viagem",
            fields: { material: "arroz", quantity: 55, unit: "m³" },
          },
        ],
        confidence: 0.95,
      };
    });
    await run(state, msg({ externalId: "t1", text: "nova viagem de curitiba para nova veneza" }), assistant);
    const done = await run(state, msg({ externalId: "t2", text: "arroz, 55 m3" }), assistant);
    assert.equal(done.record?.status, "completo");
    assert.equal(done.record?.viagem?.material, "arroz");
    assert.equal(done.record?.viagem?.quantity, 55);
    assert.equal(done.record?.viagem?.unit, "m³");
    assert.equal(
      done.replies[0]?.text,
      "Fechado, registrei a viagem de Curitiba para Nova Veneza com arroz, 55 m³.",
    );
  });

  it("associates operational status to the session trip", async () => {
    const state = seedState();
    const assistant = script((ctx) => {
      if (/nova viagem/i.test(ctx.message)) {
        return {
          message: "Entendi a viagem.",
          actions: [{ type: "record.create", recordType: "viagem", fields: { origin: "Curitiba", destination: "Nova Veneza" } }],
          confidence: 0.9,
        };
      }
      if (/arroz/i.test(ctx.message)) {
        return {
          message: "Fechado.",
          actions: [{ type: "record.update", recordType: "viagem", fields: { material: "arroz", quantity: 55, unit: "m³" } }],
          confidence: 0.9,
        };
      }
      return {
        message: "Anotei a atualização da viagem Curitiba → Nova Veneza.",
        actions: [{ type: "status.create", text: "parei em Cratos, chuva atrasou" }],
        confidence: 0.9,
      };
    });
    await run(state, msg({ externalId: "t1", text: "nova viagem de curitiba para nova veneza" }), assistant);
    await run(state, msg({ externalId: "t2", text: "arroz, 55 m3" }), assistant);
    const st = await run(state, msg({ externalId: "s1", text: "parei em Cratos, chuva atrasou" }), assistant);
    assert.equal(state.statusUpdates.length, 1);
    assert.equal(state.statusUpdates[0].tripRecordId, "reg-t1");
    assert.equal(st.replies[0]?.text, "Anotei a atualização da viagem Curitiba → Nova Veneza.");
  });

  it("creates then fills an electrician expense in the session", async () => {
    const state = seedState();
    const assistant = script((ctx) => {
      if (/eletricista/i.test(ctx.message)) {
        return {
          message: "Entendi o gasto com eletricista. Qual foi o valor, a forma de pagamento e o dia?",
          actions: [{ type: "record.create", recordType: "despesa", fields: { description: "eletricista" } }],
          confidence: 0.9,
        };
      }
      if (/250/.test(ctx.message)) {
        return {
          message: "Registrei R$ 250 com eletricista no pix. Qual foi o dia exato?",
          actions: [{ type: "record.update", recordType: "despesa", fields: { amountBrl: 250, payment: "pix" } }],
          confidence: 0.9,
        };
      }
      return {
        message: "Fechado, registrei a despesa de R$ 250 com eletricista no pix.",
        actions: [{ type: "record.update", recordType: "despesa", fields: { date: "2026-09-16" } }],
        confidence: 0.9,
      };
    });
    const first = await run(state, msg({ externalId: "e1", text: "teve um gasto com eletricista" }), assistant);
    assert.match(first.replies[0]?.text ?? "", /eletricista/i);
    assert.match(first.replies[0]?.text ?? "", /valor/i);
    const pix = await run(state, msg({ externalId: "e2", text: "250 no pix" }), assistant);
    assert.equal(pix.record?.despesa?.amountBrl, 250);
    assert.equal(pix.record?.despesa?.payment, "pix");
    assert.match(pix.replies[0]?.text ?? "", /dia/i);
    const done = await run(state, msg({ externalId: "e3", text: "ontem" }), assistant);
    assert.equal(done.record?.status, "completo");
    assert.equal(done.record?.despesa?.date, "2026-09-16");
    assert.equal(
      done.replies[0]?.text,
      "Fechado, registrei a despesa de R$ 250 com eletricista no pix.",
    );
  });

  it("answers admin onde estamos from the current session only", async () => {
    const state = seedState();
    plantOldTrip(state);
    const assistant = script((ctx) => ({
      message: ctx.activeTrip
        ? `Estamos na viagem de ${ctx.activeTrip.origin} para ${ctx.activeTrip.destination}.`
        : "Não há viagem na sessão atual.",
      actions: [{ type: "summary.query", scope: "general" }],
      confidence: 0.9,
    }));
    await run(
      state,
      msg({ externalId: "t1", text: "nova viagem de curitiba para nova veneza" }),
      script(() => ({
        message: "Entendi.",
        actions: [{ type: "record.create", recordType: "viagem", fields: { origin: "Curitiba", destination: "Nova Veneza" } }],
        confidence: 0.9,
      })),
    );
    const out = await run(
      state,
      msg({
        externalId: "adm1",
        authorId: "alana",
        authorRole: "alana",
        text: "onde estamos?",
      }),
      assistant,
    );
    assert.match(out.replies[0]?.text ?? "", /Curitiba|Nova Veneza/i);
    assert.doesNotMatch(out.replies[0]?.text ?? "", /Recife|Salvador/i);
  });

  it("blocks broadcast and sheet change", async () => {
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const state = seedState();
    const bc = await run(
      state,
      msg({
        externalId: "bc1",
        authorId: "alana",
        authorRole: "alana",
        conversationId: "conv-central",
        text: "manda mensagem para todos os motoristas",
      }),
      script(() => ({
        message: "Enviei para todos.",
        actions: [{ type: "broadcast.request", audience: "drivers", text: "cobrem pendências" }],
        needsConfirmation: true,
        confidence: 0.9,
      })),
      logs,
    );
    assert.equal(bc.replies[0]?.text, "Posso preparar isso, mas preciso de confirmação antes de executar.");
    const sh = await run(
      state,
      msg({
        externalId: "sh1",
        authorId: "alana",
        authorRole: "alana",
        conversationId: "conv-central",
        text: "cria coluna observação",
      }),
      script(() => ({
        message: "Já criei a coluna.",
        actions: [{ type: "sheet.change.request", description: "coluna observação" }],
        needsConfirmation: true,
        confidence: 0.9,
      })),
      logs,
    );
    assert.equal(sh.replies[0]?.text, "Posso preparar isso, mas preciso de confirmação antes de executar.");
    assert.ok(logs.some((l) => l.event === "assistant_v2_actions_blocked"));
  });

  it("does not use pre-session records as update targets", async () => {
    const state = seedState();
    plantOldTrip(state);
    const out = await run(
      state,
      msg({ externalId: "u1", text: "arroz, 55 m3" }),
      script(() => ({
        message: "Atualizei a viagem antiga.",
        actions: [{ type: "record.update", recordId: "reg-zombie", fields: { material: "arroz", quantity: 55, unit: "m³" } }],
        confidence: 0.9,
      })),
    );
    assert.equal(state.records.find((r) => r.id === "reg-zombie")?.viagem?.material, undefined);
    assert.notEqual(out.record?.id, "reg-zombie");
  });

  it("falls back when operational text has empty actions and still ignores zombies", async () => {
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const state = seedState();
    plantOldTrip(state);
    const talk = emptyTalk("Posso registrar essa viagem?");
    const first = await run(
      state,
      msg({ externalId: "f1", text: "nova viagem de curitiba para nova veneza" }),
      talk,
      logs,
    );
    assert.ok(logs.some((l) => l.event === "assistant_v2_missing_action_fallback"));
    assert.equal(first.record?.status, "incompleto");
    assert.equal(first.record?.id, "reg-f1");
    assert.doesNotMatch(first.replies[0]?.text ?? "", /Posso registrar/i);
    const done = await run(state, msg({ externalId: "f2", text: "arroz, 55 m3" }), talk, logs);
    assert.equal(done.record?.status, "completo");
    assert.equal(done.record?.viagem?.material, "arroz");
    assert.equal(state.records.find((r) => r.id === "reg-zombie")?.status, "incompleto");
    assert.equal(state.records.find((r) => r.id === "reg-zombie")?.viagem?.material, undefined);
  });
});
