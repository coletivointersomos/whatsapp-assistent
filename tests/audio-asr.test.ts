import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyChannelConfig } from "../src/adapters/hermes/config.ts";
import type { MessageSender, SendTextInput, SendTextResult } from "../src/adapters/hermes/openwaSend.ts";
import type { ChannelConfig } from "../src/adapters/hermes/types.ts";
import { createAlibabaAsr, type SpeechToText } from "../src/audio/alibabaAsr.ts";
import { loadAsrConfig, type AsrRuntimeConfig } from "../src/audio/config.ts";
import { seedState } from "../src/config/seed.ts";
import type { RuntimeConfig } from "../src/runtime/config.ts";
import { handleInboundPayload } from "../src/runtime/pipeline.ts";

const GROUP = "120363000000001234@g.us";
const DRIVER = "5511900005678@c.us";
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(2_000, 1)]);

const channel: ChannelConfig = {
  sessionId: "sessao-teste",
  testGroupJid: GROUP,
  adminIds: ["alana-lab@c.us"],
  botIds: ["bot-lab@c.us"],
  conversations: [{ conversationId: GROUP, role: "motorista", driverId: "motorista-joao", driverJids: [DRIVER] }],
};

const runtime: RuntimeConfig = {
  serviceName: "hermes-arnaldo-transportadora",
  liveSend: false,
  hmacRequired: false,
  hmacSecret: "",
  sessionId: channel.sessionId,
  testGroupJid: GROUP,
  channel,
  openwaBaseUrl: "http://openwa-test",
  openwaApiKey: "k",
  openwaApiKeyHeader: "X-Api-Key",
  openwaSendPath: "/api/sessions/{sessionId}/messages/text",
  openwaMediaPath: "/api/sessions/{sessionId}/messages/{chatId}/{messageId}/media",
  port: 0,
  storePath: "data/store.json",
  adminAlertJid: "",
};

const ASR_ON: AsrRuntimeConfig = { enabled: true, baseUrl: "https://asr.test/api", model: "asr-test", apiKey: "test-key" };
const DETERMINISTIC = { now: () => new Date("2026-10-19T12:00:00.000Z"), assistantV2Enabled: false, nluFirst: false, assistantFirst: false, nluEnabled: false };

class NoSend implements MessageSender {
  calls: SendTextInput[] = [];
  async sendText(input: SendTextInput): Promise<SendTextResult> {
    this.calls.push(input);
    return { ok: true, status: 200 };
  }
}

function voice(id: string, chatId = GROUP, media?: { data: string; mimetype: string }) {
  return {
    event: "message.received",
    sessionId: channel.sessionId,
    data: { id, chatId, author: DRIVER, from: DRIVER, fromMe: false, isGroup: true, body: "", type: "voice", timestamp: 1760880000, ...(media ? { media } : {}) },
  };
}

function mediaFetch(body: Buffer, contentType = "audio/ogg; codecs=opus") {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (!url.startsWith("http://openwa-test/")) throw new Error(`unexpected fetch ${url}`);
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return { impl, urls };
}

function recorder() {
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  return { events, log: (event: string, fields?: Record<string, unknown>) => events.push({ event, fields }) };
}

function mockAsr(result: string | Error) {
  const calls: Array<{ data: string; mimetype?: string }> = [];
  const asr: SpeechToText = {
    async transcribe(input) {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { asr, calls };
}

async function run(opts: { id: string; asr?: SpeechToText; config?: AsrRuntimeConfig; fetchImpl?: typeof fetch; envelope?: unknown; state?: ReturnType<typeof seedState> }) {
  const state = opts.state ?? applyChannelConfig(seedState(), channel);
  const rec = recorder();
  const sender = new NoSend();
  const result = await handleInboundPayload({
    runtime,
    state,
    sender,
    envelope: opts.envelope ?? voice(opts.id),
    clock: DETERMINISTIC,
    log: rec.log,
    audio: { asr: opts.asr, config: opts.config ?? ASR_ON, fetchImpl: opts.fetchImpl },
  });
  assert.equal(sender.calls.length, 0, "nunca envia ao WhatsApp");
  return { state, result, events: rec.events };
}

describe("áudio de grupo autorizado → ASR → NLU", () => {
  it("transcreve o áudio baixado do OpenWA e alimenta o engine como texto, com PII mascarada", async () => {
    const media = mediaFetch(OGG);
    const asr = mockAsr("hoje abasteci 200 litros no posto X deu 1200 pago, pix 11987654321");
    const { state, result, events } = await run({ id: "aud-1", asr: asr.asr, fetchImpl: media.impl });
    assert.equal(asr.calls.length, 1);
    assert.equal(asr.calls[0]!.mimetype, "audio/ogg");
    assert.equal(asr.calls[0]!.data, OGG.toString("base64"));
    assert.ok(media.urls[0]!.includes("/media"));
    const ok = events.find((e) => e.event === "asr_ok");
    assert.ok(ok);
    assert.equal(ok.fields?.bytes, OGG.length);
    assert.equal(JSON.stringify(events).includes("abasteci"), false, "transcrição não vai para o log");
    assert.equal(JSON.stringify(events).includes("11987654321"), false);
    const stored = state.messages.find((m) => m.externalId === "aud-1");
    assert.equal(stored?.type, "audio_info");
    assert.equal(stored?.text, "hoje abasteci 200 litros no posto X deu 1200 pago, pix …4321");
    assert.match(String(result.body.decision), /record_(created|incomplete)/);
    assert.doesNotMatch(JSON.stringify(state), /11987654321/);
  });

  it("falha do ASR: registra asr_failed e mantém o comportamento audio_info atual", async () => {
    const baseline = await run({ id: "aud-2", config: { ...ASR_ON, enabled: false }, fetchImpl: mediaFetch(OGG).impl });
    const failing = mockAsr(new Error("asr_request_failed:500"));
    const failed = await run({ id: "aud-2", asr: failing.asr, fetchImpl: mediaFetch(OGG).impl });
    assert.equal(failing.calls.length, 1);
    const ev = failed.events.find((e) => e.event === "asr_failed");
    assert.equal(ev?.fields?.reason, "asr_request_failed:500");
    assert.equal(failed.result.body.decision, baseline.result.body.decision);
    assert.equal(failed.state.messages.find((m) => m.externalId === "aud-2")?.text, undefined);
  });

  it("áudio acima de 8 MiB não vai ao ASR (OpenWA e webhook)", async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 1);
    const asr = mockAsr("nao deveria");
    const fromOpenWa = await run({ id: "aud-3", asr: asr.asr, fetchImpl: mediaFetch(big).impl });
    assert.equal(fromOpenWa.events.find((e) => e.event === "asr_failed")?.fields?.reason, "media_too_large");
    const inline = await run({
      id: "aud-4",
      asr: asr.asr,
      envelope: voice("aud-4", GROUP, { data: big.toString("base64"), mimetype: "audio/ogg; codecs=opus" }),
      fetchImpl: mediaFetch(OGG).impl,
    });
    assert.equal(inline.events.find((e) => e.event === "asr_failed")?.fields?.reason, "media_too_large");
    assert.equal(asr.calls.length, 0);
  });

  it("áudio inline no webhook é usado sem baixar do OpenWA", async () => {
    const media = mediaFetch(OGG);
    const asr = mockAsr("abasteci 100 litros");
    const { events } = await run({ id: "aud-5", asr: asr.asr, fetchImpl: media.impl, envelope: voice("aud-5", GROUP, { data: OGG.toString("base64"), mimetype: "audio/ogg; codecs=opus" }) });
    assert.equal(media.urls.length, 0);
    assert.equal(events.find((e) => e.event === "asr_ok")?.fields?.source, "webhook");
  });

  it("mídia que não é áudio, ASR desligado ou mensagem duplicada não chamam o ASR", async () => {
    const asr = mockAsr("x");
    const notAudio = await run({ id: "aud-6", asr: asr.asr, fetchImpl: mediaFetch(Buffer.from("<html>"), "text/html").impl });
    assert.equal(notAudio.events.find((e) => e.event === "asr_failed")?.fields?.reason, "media_not_audio");
    const media = mediaFetch(OGG);
    await run({ id: "aud-7", asr: asr.asr, config: { ...ASR_ON, enabled: false }, fetchImpl: media.impl });
    assert.equal(media.urls.length, 0);
    const first = await run({ id: "aud-8", asr: mockAsr("abasteci 100 litros").asr, fetchImpl: mediaFetch(OGG).impl });
    await run({ id: "aud-8", asr: asr.asr, fetchImpl: mediaFetch(OGG).impl, state: first.state });
    assert.equal(asr.calls.length, 0);
  });

  it("grupo não autorizado: bloqueado antes do ASR", async () => {
    const asr = mockAsr("x");
    const media = mediaFetch(OGG);
    const { events, result } = await run({ id: "aud-9", asr: asr.asr, fetchImpl: media.impl, envelope: voice("aud-9", "000000009876-0000@g.us") });
    assert.equal(result.body.processed, false);
    assert.equal(asr.calls.length + media.urls.length, 0);
    assert.ok(events.some((e) => e.event === "inbound_blocked"));
  });

  it("cliente Alibaba: usa endpoint/modelo da config, chave no header e lê output.text", async () => {
    const seen: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) });
      return Response.json({ output: { text: "abasteci 150 litros" } });
    }) as typeof fetch;
    const client = createAlibabaAsr(ASR_ON, fetchImpl);
    assert.equal(await client.transcribe({ data: OGG.toString("base64"), mimetype: "audio/ogg; codecs=opus" }), "abasteci 150 litros");
    assert.equal(seen[0]!.url, ASR_ON.baseUrl);
    assert.equal(seen[0]!.auth, "Bearer test-key");
    assert.equal(seen[0]!.body.model, "asr-test");
    assert.match(JSON.stringify(seen[0]!.body), /data:audio\/ogg;base64,/);
    const cfg = loadAsrConfig({ ASR_ENABLED: "true", ASR_BASE_URL: " https://a/b ", ASR_MODEL: "m", LLM_NLU_API_KEY: "sk-x" });
    assert.deepEqual(cfg, { enabled: true, baseUrl: "https://a/b", model: "m", apiKey: "sk-x" });
    assert.equal(loadAsrConfig({ ASR_ENABLED: "TRUE" }).enabled, false);
  });
});
