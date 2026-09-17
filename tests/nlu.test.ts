import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessage } from "../src/engine/process.ts";
import { buildNluContext } from "../src/nlu/context.ts";
import { createFakeProvider } from "../src/nlu/fakeProvider.ts";
import { gateSensitiveIntent } from "../src/nlu/gate.ts";
import { createLlmProvider } from "../src/nlu/llmProvider.ts";
import { canCallRemoteLlm, loadNluConfig } from "../src/nlu/config.ts";
import { validateNluResult } from "../src/nlu/schema.ts";
import { localTotals } from "../src/nlu/totals.ts";
import type { NluContext } from "../src/nlu/types.ts";

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

function run(state: AppState, inbound: InboundMessage, now = T0, nluEnabled?: boolean) {
  return processMessage(state, inbound, { now: () => now, nluEnabled });
}

function emptyCtx(partial: Partial<NluContext> & Pick<NluContext, "message">): NluContext {
  return {
    conversationMasked: "…joao",
    authorRole: "alana",
    isAdmin: true,
    paused: false,
    driverName: "João",
    openPendings: [],
    recentMessages: [],
    recentRecords: [],
    recentExpenses: [],
    permissions: { canWriteRecords: true, canWriteSheets: false, canBroadcast: false },
    totals: { asOfDate: "2026-09-09", fuelBrlToday: 0, expenseBrlToday: 0, pendingCount: 0 },
    ...partial,
  };
}

function seedTrip(state: AppState) {
  state.records.push({
    id: "reg-trip-1",
    kind: "viagem",
    driverId: "motorista-joao",
    status: "completo",
    sourceMessageIds: ["trip-src"],
    missing: [],
    viagem: {
      date: "2026-09-09",
      origin: "Ceará",
      destination: "Salvador",
      material: "milho",
      quantity: 30,
      unit: "toneladas",
    },
  });
}

describe("nlu operacional assistant", () => {
  it("context includes the recent trip", () => {
    const state = seedState();
    seedTrip(state);
    const ctx = buildNluContext(state, msg({ externalId: "c1", text: "onde estamos?" }), {
      authorRole: "alana",
      isAdmin: true,
      now: T0,
      driverId: "motorista-joao",
    });
    assert.equal(ctx.currentTrip?.origin, "Ceará");
    assert.equal(ctx.currentTrip?.destination, "Salvador");
    assert.equal(ctx.currentTrip?.material, "milho");
    assert.equal(ctx.driverName, "João");
  });

  it("driver BR 101 status becomes driver_status_update", () => {
    const state = seedState();
    seedTrip(state);
    const result = run(
      state,
      msg({ externalId: "st-1", text: "estou na BR 101, ainda em Cratos no Ceará" }),
    );
    assert.equal(result.decision, "assisted");
    assert.equal(state.statusUpdates.length, 1);
    assert.match(state.statusUpdates[0].text, /BR 101/i);
    assert.equal(state.statusUpdates[0].tripRecordId, "reg-trip-1");
    const interpreted = createFakeProvider().interpret(
      buildNluContext(state, msg({ externalId: "x", text: "estou na BR 101, ainda em Cratos no Ceará" }), {
        authorRole: "motorista",
        isAdmin: false,
        now: T0,
        driverId: "motorista-joao",
      }),
    ) as import("../src/nlu/types.ts").NluResult;
    assert.equal(interpreted.intent, "driver_status_update");
    assert.equal(interpreted.action, "store_status_update");
  });

  it("admin onde estamos uses the last operational update", () => {
    const state = seedState();
    seedTrip(state);
    run(state, msg({ externalId: "st-1", text: "estou na BR 101, ainda em Cratos no Ceará" }));
    const admin = run(
      state,
      msg({
        externalId: "adm-where",
        authorId: "alana",
        authorRole: "alana",
        text: "onde estamos?",
      }),
    );
    assert.equal(admin.decision, "assisted");
    assert.match(admin.replies[0]?.text ?? "", /João/i);
    assert.match(admin.replies[0]?.text ?? "", /milho/i);
    assert.match(admin.replies[0]?.text ?? "", /Ceará/i);
    assert.match(admin.replies[0]?.text ?? "", /Salvador/i);
    assert.match(admin.replies[0]?.text ?? "", /BR 101|Cratos/i);
  });

  it("admin quem é você is answered from context by the fake provider", () => {
    const fake = createFakeProvider();
    const ctx = emptyCtx({ message: "quem é você?" });
    const out = fake.interpret(ctx) as import("../src/nlu/types.ts").NluResult;
    assert.equal(out.intent, "bot_identity_question");
    assert.equal(out.action, "answer_question");
    assert.match(out.reply ?? "", /assistente operacional/i);
    assert.match(out.reply ?? "", /João/);
    assert.match(out.reply ?? "", /não envio mensagem em massa/i);
    const viaEngine = run(
      seedState(),
      msg({
        externalId: "who",
        authorId: "alana",
        authorRole: "alana",
        text: "quem é você?",
      }),
    );
    assert.equal(viaEngine.decision, "assisted");
    assert.match(viaEngine.replies[0]?.text ?? "", /assistente operacional/i);
  });

  it("sao joao completes place then hoje closes the fueling", () => {
    const state = seedState();
    run(state, msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }));
    const place = run(state, msg({ externalId: "p1", text: "sao joao" }));
    assert.equal(place.decision, "record_incomplete");
    assert.equal(place.record?.abastecimento?.place, "posto sao joao");
    assert.deepEqual(place.record?.missing, ["date"]);
    assert.match(place.replies[0]?.text ?? "", /hoje|dia/i);
    const closed = run(state, msg({ externalId: "d1", text: "hoje" }));
    assert.equal(closed.decision, "record_created");
    assert.equal(closed.record?.status, "completo");
    assert.equal(closed.record?.abastecimento?.date, "2026-09-09");
  });

  it("admin always gets a reply for hello and local fuel total", () => {
    const state = seedState();
    run(state, msg({ externalId: "fuel", text: "hoje abasteci 200 litros no posto X deu 1200 pago" }));
    const hello = run(
      state,
      msg({
        externalId: "adm-hi",
        authorId: "alana",
        authorRole: "alana",
        text: "oi, você me escuta?",
      }),
    );
    assert.equal(hello.decision, "assisted");
    assert.match(hello.replies[0]?.text ?? "", /assistente|registro|escuto/i);

    const fuel = run(
      state,
      msg({
        externalId: "adm-fuel",
        authorId: "alana",
        authorRole: "alana",
        text: "quanto deu de combustível hoje?",
      }),
    );
    assert.match(fuel.replies[0]?.text ?? "", /1200/);
    assert.equal(localTotals(state, { date: "2026-09-09" }).fuelBrl, 1200);
  });

  it("admin pending, broadcast and sheet change do not execute side effects", () => {
    const state = seedState();
    run(state, msg({ externalId: "inc-1", text: "abasteci 150 litros, deu 980, assinada" }));
    const pending = run(
      state,
      msg({
        externalId: "adm-p",
        authorId: "alana",
        authorRole: "alana",
        text: "tem pendência?",
      }),
    );
    assert.match(pending.replies[0]?.text ?? "", /pendência/i);

    const beforeReplies = state.botReplies.length;
    const broadcast = run(
      state,
      msg({
        externalId: "adm-b",
        authorId: "alana",
        authorRole: "alana",
        text: "manda mensagem para todos os motoristas pedindo pendências",
      }),
    );
    assert.equal(broadcast.decision, "assisted");
    assert.match(broadcast.replies[0]?.text ?? "", /não envio mensagem em massa/i);
    assert.equal(state.botReplies.length, beforeReplies + 1);
    assert.equal(state.conversations.filter((c) => c.role === "motorista").length, 2);

    const sheet = run(
      state,
      msg({
        externalId: "adm-s",
        authorId: "alana",
        authorRole: "alana",
        text: "cria uma coluna observação",
      }),
    );
    assert.match(sheet.replies[0]?.text ?? "", /não altero o Sheets real/i);
    assert.equal(sheet.decision, "assisted");
    assert.equal(state.records.length, 1);

    const lookup = run(
      state,
      msg({
        externalId: "adm-m",
        authorId: "alana",
        authorRole: "alana",
        text: "o motorista 1 teve gasto com motor duas semanas atrás?",
      }),
    );
    assert.match(lookup.replies[0]?.text ?? "", /Não encontrei confirmação local/i);
  });

  it("sheet_change_request and broadcast_request require confirmation", () => {
    const fake = createFakeProvider();
    const sheet = gateSensitiveIntent(
      fake.interpret(emptyCtx({ message: "cria uma coluna observação" })) as import("../src/nlu/types.ts").NluResult,
      true,
    );
    assert.equal(sheet.intent, "sheet_change_request");
    assert.equal(sheet.requiresConfirmation, true);
    assert.equal(sheet.action, "block_sheets");
    const broadcast = gateSensitiveIntent(
      fake.interpret(
        emptyCtx({ message: "manda mensagem para todos os motoristas pedindo pendências" }),
      ) as import("../src/nlu/types.ts").NluResult,
      true,
    );
    assert.equal(broadcast.intent, "broadcast_request");
    assert.equal(broadcast.requiresConfirmation, true);
    assert.equal(broadcast.action, "block_broadcast");
  });

  it("driver electrician expense is not ignored", () => {
    const result = run(seedState(), msg({ externalId: "el-1", text: "existe um gasto extra com eletricista" }));
    assert.notEqual(result.decision, "ignored");
    assert.equal(result.record?.kind, "despesa");
    assert.equal(result.record?.status, "incompleto");
    assert.doesNotMatch(result.replies[0]?.text ?? "", /^Foi hoje ou outro dia\?$/);
  });

  it("fake NLU returns a validated intent and invalid JSON becomes unknown", () => {
    const fake = createFakeProvider({
      intent: "admin_question",
      confidence: 0.8,
      reasoning_summary: "ok",
    });
    const ok = fake.interpret(emptyCtx({ message: "oi" })) as import("../src/nlu/types.ts").NluResult;
    assert.equal(ok.intent, "admin_question");
    assert.equal(ok.action, "answer_question");
    assert.equal(validateNluResult("{not json").intent, "unknown");
    assert.equal(validateNluResult({ intent: "explode" }).intent, "unknown");
  });

  it("sensitive intent without admin is blocked; with admin needs confirmation", () => {
    const raw = {
      intent: "broadcast_request" as const,
      action: "block_broadcast" as const,
      confidence: 0.9,
      reasoning_summary: "mass",
      reply: "enviar",
    };
    const blocked = gateSensitiveIntent(raw, false);
    assert.equal(blocked.intent, "unknown");
    assert.equal(blocked.unsafeReason, "sensitive_not_admin");
    const admin = gateSensitiveIntent(raw, true);
    assert.equal(admin.intent, "broadcast_request");
    assert.equal(admin.requiresConfirmation, true);
  });

  it("NLU disabled keeps random driver chat ignored and does not break deterministic records", () => {
    const cfg = loadNluConfig({ LLM_NLU_ENABLED: "false", LLM_NLU_PROVIDER: "llm" });
    assert.equal(cfg.enabled, false);
    assert.equal(canCallRemoteLlm(cfg), false);
    const state = seedState();
    const chatter = run(state, msg({ externalId: "rand", text: "blz vlw" }), T0, false);
    assert.equal(chatter.decision, "ignored");
    const statusOff = run(
      state,
      msg({ externalId: "st-off", text: "estou na BR 101, ainda em Cratos no Ceará" }),
      T0,
      false,
    );
    assert.equal(statusOff.decision, "ignored");
    assert.equal(state.statusUpdates.length, 0);
    const fuel = run(
      state,
      msg({ externalId: "det-1", text: "hoje abasteci 200 litros no posto X deu 1200 pago" }),
      T0,
      false,
    );
    assert.equal(fuel.decision, "record_created");
  });

  it("llm provider stays quiet without key or when disabled", async () => {
    const provider = createLlmProvider({
      enabled: false,
      provider: "llm",
      model: "x",
      apiKey: "secret-should-not-log",
      baseUrl: "https://example.invalid",
      timeoutMs: 50,
    });
    const result = await provider.interpret(emptyCtx({ message: "oi", authorRole: "alana", isAdmin: true }));
    assert.equal(result.intent, "unknown");
    assert.equal(canCallRemoteLlm(loadNluConfig({ LLM_NLU_ENABLED: "true", LLM_NLU_PROVIDER: "llm" })), false);
  });
});
