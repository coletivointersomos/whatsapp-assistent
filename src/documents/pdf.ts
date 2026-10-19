import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MEDIA_BYTES } from "../adapters/hermes/openwaMedia.ts";
import type { InboundMessage } from "../domain/types.ts";
import { maskPii } from "../privacy/pii.ts";

/** Executa um binário (pdftotext/pdftoppm). Injetável nos testes. */
export type PdfRunner = (cmd: string, args: string[]) => Promise<void>;

export const PDF_TEXT_MAX_PAGES = 5;
export const PDF_RASTER_PAGES = 1;
export const PDF_MIN_TEXT_CHARS = 20;

const defaultRunner: PdfRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error) => (error ? reject(error) : resolve()));
  });

export function isPdfMime(mime: string | undefined): boolean {
  return (mime ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/pdf";
}

function withTempPdf<T>(base64: string, fn: (dir: string, pdf: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdf-"));
  const pdf = join(dir, "in.pdf");
  writeFileSync(pdf, Buffer.from(base64, "base64"));
  return fn(dir, pdf).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Texto das primeiras páginas (pdftotext -layout). Vazio se o PDF for só imagem. */
export async function extractPdfText(base64: string, runner: PdfRunner = defaultRunner): Promise<string> {
  return withTempPdf(base64, async (dir, pdf) => {
    const out = join(dir, "out.txt");
    await runner("pdftotext", ["-layout", "-enc", "UTF-8", "-f", "1", "-l", String(PDF_TEXT_MAX_PAGES), pdf, out]);
    return readFileSync(out, "utf8").replace(/\f/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, 80_000);
  });
}

/** Primeira página → JPEG para o Qwen vision, dentro do limite de mídia. */
export async function rasterizePdfFirstPage(base64: string, runner: PdfRunner = defaultRunner): Promise<{ mime: string; base64: string; bytes: number }> {
  return withTempPdf(base64, async (dir, pdf) => {
    for (const dpi of [130, 90, 60]) {
      for (const name of readdirSync(dir)) if (name.startsWith("page")) rmSync(join(dir, name), { force: true });
      await runner("pdftoppm", ["-jpeg", "-jpegopt", "quality=80", "-r", String(dpi), "-f", "1", "-l", String(PDF_RASTER_PAGES), pdf, join(dir, "page")]);
      const page = readdirSync(dir).filter((name) => name.startsWith("page") && name.endsWith(".jpg")).sort()[0];
      if (!page) throw new Error("pdf_raster_empty");
      const bytes = readFileSync(join(dir, page));
      if (bytes.length > 0 && bytes.length <= MAX_MEDIA_BYTES) return { mime: "image/jpeg", base64: bytes.toString("base64"), bytes: bytes.length };
    }
    throw new Error("pdf_raster_too_large");
  });
}

/**
 * PDF recebido: com texto → vira texto para o NLU (PII mascarada pelo ponto único pii.ts);
 * sem texto → 1ª página rasterizada vai ao vision. Falha → `pdf_failed` e segue como estava.
 */
export async function ingestPdfInbound(input: {
  inbound: InboundMessage;
  runner?: PdfRunner;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<InboundMessage> {
  const { inbound } = input;
  const log = input.log ?? (() => undefined);
  const media = inbound.media;
  if (!media || !isPdfMime(media.mime)) return inbound;
  try {
    const text = await extractPdfText(media.base64, input.runner);
    if (text.replace(/\s/g, "").length >= PDF_MIN_TEXT_CHARS) {
      const masked = maskPii(text);
      log("pdf_text_extracted", { chars: masked.length });
      return {
        ...inbound,
        type: "texto",
        text: [inbound.text, masked].filter(Boolean).join("\n").slice(0, 80_000),
        media: undefined,
      };
    }
    const image = await rasterizePdfFirstPage(media.base64, input.runner);
    log("pdf_rasterized", { bytes: image.bytes, pages: PDF_RASTER_PAGES });
    return { ...inbound, media: { mime: image.mime, base64: image.base64, source: media.source } };
  } catch (error) {
    log("pdf_failed", { reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" });
    return { ...inbound, media: undefined };
  }
}
