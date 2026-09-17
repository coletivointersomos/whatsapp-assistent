import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState, InboundMessage } from "../src/domain/types.ts";
import { processMessage } from "../src/engine/process.ts";
import { createFakeProvider } from "../src/nlu/fakeProvider.ts";
import { gateSensitiveIntent } from "../src/nlu/gate.ts";
import { createLlmProvider } from "../src/nlu/llmProvider.ts";
import { canCallRemoteLlm, loadNluConfig } from "../src/nlu/config.ts";
import { validateNluResult } from "../src/nlu/schema.ts";
import { localTotals } from "../src/nlu/totals.ts";

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

describe("nlu operacional assistant", () => {
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
    assert.match(hello.replies[0]?.text ?? "", /escuto|aqui/i);

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

  it("driver electrician expense is not ignored", () => {
    const result = run(seedState(), msg({ externalId: "el-1", text: "existe um gasto extra com eletricista" }));
    assert.notEqual(result.decision, "ignored");
    assert.equal(result.record?.kind, "despesa");
    assert.equal(result.record?.status, "incompleto");
    assert.ok(result.replies.length > 0);
  });

  it("fake NLU returns a validated intent and invalid JSON becomes unknown", () => {
    const fake = createFakeProvider({
      intent: "admin_question",
      confidence: 0.8,
      reasoning_summary: "ok",
    });
    const ctx = {
      authorRole: "alana" as const,
      isAdmin: true,
      paused: false,
      message: "oi",
      conversationMasked: "…joao",
      recentMessages: [],
      recentRecords: [],
      totals: { fuelBrlToday: 0, expenseBrlToday: 0, pendingCount: 0 },
    };
    const ok = fake.interpret(ctx) as import("../src/nlu/types.ts").NluResult;
    assert.equal(ok.intent, "admin_question");
    assert.equal(validateNluResult("{not json").intent, "unknown");
    assert.equal(validateNluResult({ intent: "explode" }).intent, "unknown");
  });

  it("sensitive intent without admin is blocked; with admin needs confirmation", () => {
    const raw = {
      intent: "broadcast_request" as const,
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

  it("NLU disabled keeps random driver chat ignored and does not call a remote LLM", () => {
    const cfg = loadNluConfig({ LLM_NLU_ENABLED: "false", LLM_NLU_PROVIDER: "llm" });
    assert.equal(cfg.enabled, false);
    assert.equal(canCallRemoteLlm(cfg), false);
    const result = run(seedState(), msg({ externalId: "rand", text: "blz vlw" }));
    assert.equal(result.decision, "ignored");
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
    const result = await provider.interpret({
      authorRole: "alana",
      isAdmin: true,
      paused: false,
      message: "oi",
      conversationMasked: "…x",
      recentMessages: [],
      recentRecords: [],
      totals: { fuelBrlToday: 0, expenseBrlToday: 0, pendingCount: 0 },
    });
    assert.equal(result.intent, "unknown");
    assert.equal(canCallRemoteLlm(loadNluConfig({ LLM_NLU_ENABLED: "true", LLM_NLU_PROVIDER: "llm" })), false);
  });
});
