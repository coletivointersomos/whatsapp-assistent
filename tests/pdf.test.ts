import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { applyChannelConfig } from "../src/adapters/hermes/config.ts";
import { normalizeOpenWaEnvelope } from "../src/adapters/hermes/normalize.ts";
import { fetchOpenWaImage, MAX_MEDIA_BYTES, sniffBase64Mime } from "../src/adapters/hermes/openwaMedia.ts";
import type { MessageSender, SendTextInput, SendTextResult } from "../src/adapters/hermes/openwaSend.ts";
import type { ChannelConfig } from "../src/adapters/hermes/types.ts";
import { seedState } from "../src/config/seed.ts";
import { extractPdfText, ingestPdfInbound, type PdfRunner } from "../src/documents/pdf.ts";
import type { InboundMessage } from "../src/domain/types.ts";
import type { RuntimeConfig } from "../src/runtime/config.ts";
import { handleInboundPayload } from "../src/runtime/pipeline.ts";

/** PDF mínimo de 1 página com texto (pdftotext reconstrói o xref). */
function textPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 40 760 Td (${text}) Tj ET`;
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n` +
      `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n` +
      `5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
    "latin1",
  );
}
const BLANK_PDF = textPdf("").toString("latin1").replace("BT /F1 12 Tf 40 760 Td () Tj ET", "0 0 1 rg 10 10 100 100 re f");
const HAS_POPPLER = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);

function fakeRunner(opts: { text?: string; jpeg?: Buffer; fail?: string }) {
  const calls: string[] = [];
  const runner: PdfRunner = async (cmd, args) => {
    calls.push(cmd);
    if (opts.fail) throw new Error(opts.fail);
    if (cmd === "pdftotext") writeFileSync(args[args.length - 1]!, opts.text ?? "");
    if (cmd === "pdftoppm") writeFileSync(`${args[args.length - 1]}-1.jpg`, opts.jpeg ?? JPEG);
  };
  return { runner, calls };
}

function pdfInbound(): InboundMessage {
  return {
    externalId: "pdf-1",
    conversationId: "g@g.us",
    authorId: "a@c.us",
    authorRole: "motorista",
    sentAt: "2026-10-19T12:00:00.000Z",
    type: "anexo_comprovante",
    text: "comprovante",
    attachmentRef: "application/pdf",
    media: { mime: "application/pdf", base64: textPdf("x").toString("base64"), source: "webhook" },
  };
}

describe("PDF (2b)", () => {
  it("PDF com texto vira texto para o NLU, com PII mascarada, sem mídia", async () => {
    const { runner, calls } = fakeRunner({ text: "Comprovante Pix\nCPF 529.982.247-25\nValor R$ 150,00\nAgência 0001 Conta 12345-6" });
    const events: string[] = [];
    const out = await ingestPdfInbound({ inbound: pdfInbound(), runner, log: (e) => events.push(e) });
    assert.deepEqual(calls, ["pdftotext"]);
    assert.equal(out.type, "texto");
    assert.equal(out.media, undefined);
    assert.match(out.text ?? "", /^comprovante\nComprovante Pix/);
    assert.match(out.text ?? "", /\*\*\*\.\*\*\*\.\*\*\*-25/);
    assert.match(out.text ?? "", /R\$ 150,00/);
    assert.doesNotMatch(out.text ?? "", /529\.982|12345-6/);
    assert.deepEqual(events, ["pdf_text_extracted"]);
  });

  it("PDF sem texto: 1ª página rasterizada vai ao vision como JPEG", async () => {
    const { runner, calls } = fakeRunner({ text: "  \n " });
    const out = await ingestPdfInbound({ inbound: pdfInbound(), runner });
    assert.deepEqual(calls, ["pdftotext", "pdftoppm"]);
    assert.equal(out.type, "anexo_comprovante");
    assert.equal(out.media?.mime, "image/jpeg");
    assert.equal(out.media?.base64, JPEG.toString("base64"));
  });

  it("rasterização acima do limite tenta DPI menor e depois desiste (pdf_failed)", async () => {
    const big = Buffer.alloc(MAX_MEDIA_BYTES + 1, 1);
    const { runner, calls } = fakeRunner({ text: "", jpeg: big });
    const events: Array<{ e: string; f?: Record<string, unknown> }> = [];
    const out = await ingestPdfInbound({ inbound: pdfInbound(), runner, log: (e, f) => events.push({ e, f }) });
    assert.equal(calls.filter((c) => c === "pdftoppm").length, 3);
    assert.equal(out.media, undefined);
    assert.deepEqual(events.at(-1), { e: "pdf_failed", f: { reason: "pdf_raster_too_large" } });
  });

  it("falha do pdftotext: pdf_failed e segue sem mídia (não manda PDF ao vision)", async () => {
    const { runner } = fakeRunner({ fail: "spawn pdftotext ENOENT" });
    const out = await ingestPdfInbound({ inbound: pdfInbound(), runner });
    assert.equal(out.media, undefined);
    assert.equal(out.type, "anexo_comprovante");
  });

  it("normalize aceita application/pdf do webhook e o OpenWA binário é reconhecido como PDF", async () => {
    const channel: ChannelConfig = { sessionId: "s", adminIds: [], botIds: [], conversations: [{ conversationId: "g@g.us", role: "motorista", driverId: "motorista-joao" }] };
    const b64 = textPdf("ola").toString("base64");
    const norm = normalizeOpenWaEnvelope(
      { event: "message.received", sessionId: "s", data: { id: "m1", chatId: "g@g.us", author: "a@c.us", isGroup: true, type: "document", media: { mimetype: "application/pdf", data: b64 } } },
      channel,
    );
    assert.ok(norm.ok);
    assert.equal(norm.inbound.media?.mime, "application/pdf");
    assert.equal(sniffBase64Mime(b64), "application/pdf");
    assert.equal(sniffBase64Mime(JPEG.toString("base64")), "image/jpeg");
    const fetched = await fetchOpenWaImage({
      baseUrl: "http://openwa-test",
      apiKey: "",
      apiKeyHeader: "X-Api-Key",
      sessionId: "s",
      messageId: "m1",
      chatId: "g@g.us",
      mediaPath: "/api/sessions/{sessionId}/messages/{chatId}/{messageId}/media",
      fetchImpl: (async () => new Response(new Uint8Array(textPdf("ola")), { headers: { "content-type": "application/octet-stream" } })) as typeof fetch,
    });
    assert.equal(fetched?.mime, "application/pdf");
  });

  it("pipeline: PDF de comprovante no grupo autorizado chega ao engine como texto, sem envio", async () => {
    const channel: ChannelConfig = { sessionId: "s", adminIds: [], botIds: [], conversations: [{ conversationId: "g@g.us", role: "motorista", driverId: "motorista-joao", driverJids: ["a@c.us"] }] };
    const runtime = { serviceName: "t", liveSend: false, hmacRequired: false, hmacSecret: "", sessionId: "s", testGroupJid: "g@g.us", channel, openwaBaseUrl: "", openwaApiKey: "", openwaApiKeyHeader: "X-Api-Key", openwaSendPath: "/x", openwaMediaPath: "/y", port: 0, storePath: "x", adminAlertJid: "" } as RuntimeConfig;
    const state = applyChannelConfig(seedState(), channel);
    const sent: SendTextInput[] = [];
    const sender: MessageSender = { async sendText(i: SendTextInput): Promise<SendTextResult> { sent.push(i); return { ok: true, status: 200 }; } };
    const { runner } = fakeRunner({ text: "hoje abasteci 200 litros no posto X deu 1200 pago" });
    const result = await handleInboundPayload({
      runtime,
      state,
      sender,
      pdfRunner: runner,
      clock: { now: () => new Date("2026-10-19T12:00:00.000Z"), assistantV2Enabled: false, nluFirst: false, assistantFirst: false, nluEnabled: false },
      envelope: { event: "message.received", sessionId: "s", data: { id: "pdf-9", chatId: "g@g.us", author: "a@c.us", isGroup: true, type: "document", body: "", media: { mimetype: "application/pdf", data: textPdf("x").toString("base64") } } },
    });
    assert.equal(sent.length, 0);
    assert.match(String(result.body.decision), /record_(created|incomplete)/);
    assert.equal(state.messages.find((m) => m.externalId === "pdf-9")?.type, "texto");
  });

  it("poppler real (quando instalado): extrai texto e rasteriza PDF sem texto", { skip: !HAS_POPPLER }, async () => {
    const text = await extractPdfText(textPdf("Comprovante de pagamento 150,00").toString("base64"));
    assert.match(text, /Comprovante de pagamento 150,00/);
    const out = await ingestPdfInbound({ inbound: { ...pdfInbound(), media: { mime: "application/pdf", base64: Buffer.from(BLANK_PDF, "latin1").toString("base64"), source: "webhook" } } });
    assert.equal(out.media?.mime, "image/jpeg");
    assert.ok((out.media?.base64.length ?? 0) > 100);
  });
});
