import { dayIso } from "../domain/rules.ts";
import type { RecordKind } from "../domain/types.ts";

export type Extracted = {
  kind: RecordKind;
  abastecimento?: Record<string, string | number>;
  despesa?: Record<string, string | number>;
  viagem?: Record<string, string | number>;
};

function parseNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

function paymentToken(text: string): string | undefined {
  const match = text.match(/\b(assinada|pago|paga)\b/i);
  if (!match) return undefined;
  return match[1].toLowerCase();
}

function resolveDate(text: string, sentAt: Date): string | undefined {
  if (/\bhoje\b/i.test(text)) return dayIso(sentAt);
  if (/\bontem\b/i.test(text)) {
    const d = new Date(sentAt);
    d.setUTCDate(d.getUTCDate() - 1);
    return dayIso(d);
  }
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  return undefined;
}

function detectKind(text: string): RecordKind | undefined {
  if (/\b(abastec\w*)\b/i.test(text)) return "abastecimento";
  if (/\b(gastei|despesa|gasto)\b/i.test(text)) return "despesa";
  if (/\bviagem\b/i.test(text)) return "viagem";
  if (/\bfrete\b/i.test(text) && /\bde\s+.+\s+para\s+/i.test(text)) return "viagem";
  return undefined;
}

function extractAbastecimento(text: string, sentAt: Date, vehicle?: string) {
  const liters = text.match(/(\d+(?:[.,]\d+)?)\s*(?:l(?:itros?)?)\b/i);
  const total =
    text.match(/\bdeu\s*(?:r\$\s*)?(\d+(?:[.,]\d+)?)\b/i) ??
    text.match(/(?:r\$\s*)(\d+(?:[.,]\d+)?)/i);
  const place =
    text.match(/\bno\s+(posto\s+[^,.;]+?)(?=\s+deu\b|,|$)/i) ??
    text.match(/\bposto\s+([^,.;]+?)(?=\s+deu\b|,|$)/i);
  const fields: Record<string, string | number> = {};
  const date = resolveDate(text, sentAt);
  if (date) fields.date = date;
  if (liters) fields.liters = parseNumber(liters[1]);
  if (total) fields.totalBrl = parseNumber(total[1]);
  if (place) fields.place = place[1].trim();
  const payment = paymentToken(text);
  if (payment) fields.payment = payment;
  if (vehicle) fields.vehicle = vehicle;
  return fields;
}

function extractDespesa(text: string, sentAt: Date, vehicle?: string) {
  const amount =
    text.match(/\b(?:gastei|gasto|despesa)\s*(?:de\s*)?(?:r\$\s*)?(\d+(?:[.,]\d+)?)/i) ??
    text.match(/(?:r\$\s*)(\d+(?:[.,]\d+)?)/i);
  const description = text.match(
    /\b(?:com|de|em)\s+([^,.;]+?)(?=\s+(?:pago|paga|assinada)\b|,|$)/i,
  );
  const fields: Record<string, string | number> = {};
  const date = resolveDate(text, sentAt);
  if (date) fields.date = date;
  if (amount) fields.amountBrl = parseNumber(amount[1]);
  if (description) fields.description = description[1].trim();
  const payment = paymentToken(text);
  if (payment) fields.payment = payment;
  if (vehicle) fields.vehicle = vehicle;
  return fields;
}

function extractViagem(text: string, sentAt: Date, vehicle?: string) {
  const route = text.match(/\bde\s+(.+?)\s+para\s+(.+?)(?=\s+com\b|,|$)/i);
  const qty = text.match(
    /(\d+(?:[.,]\d+)?)\s*(toneladas?|t\b|m[³3]|metros?\s*c[uú]bicos?|kg)\b/i,
  );
  const material = text.match(/\b(?:com|de|,)\s*([a-zA-Zá-úÁ-Ú]+)\s+(\d+(?:[.,]\d+)?)\s*(?:toneladas?|t\b|m[³3])/i)
    ?? text.match(/,\s*([a-zA-Zá-úÁ-Ú]+)\s*,/i);
  const unitPrice = text.match(/\b(?:pre[cç]o|r\$)\s*(?:por\s*)?(?:unidade\s*)?(\d+(?:[.,]\d+)?)/i);
  const freightTotal = text.match(/\bfrete\s*(?:de\s*|total\s*)?(?:r\$\s*)?(\d+(?:[.,]\d+)?)/i);
  const receipt = text.match(/\breceb(?:i|ido|imento)\s+([^,.;]+)/i);

  const fields: Record<string, string | number> = {};
  const date = resolveDate(text, sentAt);
  if (date) fields.date = date;
  if (route) {
    fields.origin = route[1].trim();
    fields.destination = route[2].trim();
  }
  if (qty) {
    fields.quantity = parseNumber(qty[1]);
    const unitRaw = qty[2].toLowerCase();
    fields.unit = unitRaw.startsWith("m") ? "m³" : unitRaw.replace(/^t$/, "toneladas");
  }
  if (material) fields.material = material[1].trim();
  if (unitPrice) fields.unitPrice = parseNumber(unitPrice[1]);
  if (freightTotal && freightTotal.index !== undefined) {
    const around = text.slice(freightTotal.index, freightTotal.index + 20);
    if (!/\bfrete de\s+[A-Za-zá-ú]/i.test(around)) {
      fields.freightTotal = parseNumber(freightTotal[1]);
    }
  }
  if (receipt) fields.receipt = receipt[1].trim();
  if (vehicle) fields.vehicle = vehicle;
  return fields;
}

export function looksLikeAdminCommand(text: string): boolean {
  return /^\s*suspender\b/i.test(text) || /^\s*listar suspens/i.test(text);
}

export function isDeferral(text: string): boolean {
  return (
    /agora n[aã]o posso\b/i.test(text) ||
    /agora n[aã]o( consigo)?/i.test(text) ||
    /n[aã]o posso (falar|responder) agora/i.test(text)
  );
}

export function extractFromText(
  text: string,
  sentAt: Date,
  vehicleHint?: string,
): Extracted | undefined {
  const kind = detectKind(text);
  if (!kind) return undefined;
  if (kind === "abastecimento") {
    return { kind, abastecimento: extractAbastecimento(text, sentAt, vehicleHint) };
  }
  if (kind === "despesa") {
    return { kind, despesa: extractDespesa(text, sentAt, vehicleHint) };
  }
  return { kind, viagem: extractViagem(text, sentAt, vehicleHint) };
}
