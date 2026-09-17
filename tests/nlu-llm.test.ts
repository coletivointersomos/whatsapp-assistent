import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nluRejectReason } from "../src/nlu/audit.ts";
import { loadNluConfig } from "../src/nlu/config.ts";
import {
  extractChatMessageContent,
  maskHttpSnippet,
  resolveChatCompletionsUrl,
} from "../src/nlu/llmHttp.ts";
import { createLlmProvider } from "../src/nlu/llmProvider.ts";
import type { NluContext } from "../src/nlu/types.ts";

function ctx(): NluContext {
  return {
    conversationMasked: "…joao",
    authorRole: "alana",
    isAdmin: true,
    paused: false,
    message: "oi",
    driverName: "João",
    openPendings: [],
    recentMessages: [],
    recentRecords: [],
    recentExpenses: [],
    permissions: { canWriteRecords: true, canWriteSheets: false, canBroadcast: false },
    totals: { asOfDate: "2026-09-09", fuelBrlToday: 0, expenseBrlToday: 0, pendingCount: 0 },
  };
}

function llmCfg() {
  return {
    enabled: true,
    provider: "llm" as const,
    model: "openai/gpt-4o-mini",
    apiKey: "test-key-should-not-appear",
    baseUrl: "https://openrouter.ai/api/v1",
    timeoutMs: 2000,
    maxTokens: 512,
    jsonResponseFormat: true,
  };
}

const validJson = JSON.stringify({
  intent: "bot_identity_question",
  action: "reply",
  confidence: 0.9,
  reply: "ok",
});

describe("llm http helper", () => {
  it("does not duplicate /chat/completions", () => {
    assert.equal(
      resolveChatCompletionsUrl("https://openrouter.ai/api/v1"),
      "https://openrouter.ai/api/v1/chat/completions",
    );
    assert.equal(
      resolveChatCompletionsUrl("https://openrouter.ai/api/v1/chat/completions/"),
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("strips markdown fences and accepts object content", () => {
    const fenced = extractChatMessageContent({
      choices: [{ message: { content: "```json\n" + validJson + "\n```" } }],
    });
    assert.equal(typeof fenced, "string");
    assert.match(String(fenced), /bot_identity_question/);
    const obj = extractChatMessageContent({
      choices: [{ message: { content: JSON.parse(validJson) } }],
    });
    assert.equal((obj as { intent?: string }).intent, "bot_identity_question");
  });

  it("masks keys, urls and long hex from error bodies", () => {
    const masked = maskHttpSnippet(
      'Bearer sk-abc123 {"url":"https://openrouter.ai/keys/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    );
    assert.equal(masked.includes("sk-abc123"), false);
    assert.equal(masked.includes("openrouter.ai"), false);
    assert.equal(masked.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
  });
});

describe("llm provider fetch", () => {
  it("parses HTTP 200 JSON content", async () => {
    const provider = createLlmProvider(llmCfg(), async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: validJson } }] }), { status: 200 }),
    );
    const result = await provider.interpret(ctx());
    assert.equal(result.intent, "bot_identity_question");
    assert.equal(result.action, "reply");
    assert.equal(result.reply, "ok");
  });

  it("parses HTTP 200 JSON inside a markdown fence", async () => {
    const provider = createLlmProvider(llmCfg(), async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "```json\n" + validJson + "\n```" } }] }),
        { status: 200 },
      ),
    );
    const result = await provider.interpret(ctx());
    assert.equal(result.intent, "bot_identity_question");
  });

  it("maps 401/403/404/500 to llm_http:status", async () => {
    for (const status of [401, 403, 404, 500, 402]) {
      const provider = createLlmProvider(llmCfg(), async () => new Response("nope", { status }));
      const result = await provider.interpret(ctx());
      assert.equal(result.reasoning_summary, `llm_http:${status}`);
      assert.equal(nluRejectReason(result), "http_error");
    }
  });

  it("maps missing choices content to llm_empty_content", async () => {
    const provider = createLlmProvider(
      llmCfg(),
      async () => new Response(JSON.stringify({ id: "x" }), { status: 200 }),
    );
    const result = await provider.interpret(ctx());
    assert.equal(result.reasoning_summary, "llm_empty_content");
    assert.equal(nluRejectReason(result), "schema_invalid");
  });

  it("retries without response_format on 400 mentioning it", async () => {
    let calls = 0;
    const provider = createLlmProvider(llmCfg(), async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { response_format?: unknown; max_tokens?: number };
      if (calls === 1) {
        assert.ok(body.response_format);
        assert.equal(body.max_tokens, 512);
        return new Response("response_format is not supported", { status: 400 });
      }
      assert.equal(body.response_format, undefined);
      return new Response(JSON.stringify({ choices: [{ message: { content: validJson } }] }), { status: 200 });
    });
    const result = await provider.interpret(ctx());
    assert.equal(calls, 2);
    assert.equal(result.intent, "bot_identity_question");
  });

  it("does not log the api key in http hooks", async () => {
    const seen: string[] = [];
    const provider = createLlmProvider(
      llmCfg(),
      async () => new Response("secret test-key-should-not-appear", { status: 401 }),
      {
        onHttp: (info) => {
          seen.push(JSON.stringify(info));
        },
      },
    );
    await provider.interpret(ctx());
    assert.equal(seen.length, 1);
    assert.equal(seen[0].includes("test-key-should-not-appear"), false);
    assert.match(seen[0], /"status":401/);
  });

  it("defaults max tokens to 512", () => {
    const cfg = loadNluConfig({ LLM_NLU_ENABLED: "true", LLM_NLU_PROVIDER: "llm" });
    assert.equal(cfg.maxTokens, 512);
    assert.equal(cfg.jsonResponseFormat, true);
  });
});
