import { dayIso } from "../domain/rules.ts";
import type { RecordKind } from "../domain/types.ts";
import { CARGO_MATERIAL_QTY_RE, CARGO_QTY_UNIT_RE, normalizeCargoUnit } from "../domain/units.ts";

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
  const match = text.match(/\b(assinada|pago|paga|pix)\b/i);
  if (!match) return undefined;
  const token = match[1].toLowerCase();
  return token === "paga" ? "pago" : token;
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
  if (/\b(eletricista|gasto extra|mec[aâ]nico|pneu|oficina)\b/i.test(text)) return "despesa";
  if (/\bgasto\b/i.test(text) && /\bmotor\b/i.test(text)) return "despesa";
  if (/\b(gastei|despesa|gasto)\b/i.test(text)) return "despesa";
  if (/\bviagem\b/i.test(text)) return "viagem";
  if (/\bfrete\b/i.test(text) && /\bde\s+.+\s+(?:para|pra|at[eé]|ate)\s+/i.test(text)) return "viagem";
  if (/\bde\s+.+\s+(?:para|pra|at[eé]|ate)\s+/i.test(text) && !/\b(suspender|listar)\b/i.test(text)) {
    return "viagem";
  }
  return undefined;
}

const COMPLEMENT_RESERVED = new Set([
  "hoje",
  "ontem",
  "foi",
  "no",
  "na",
  "de",
  "para",
  "pra",
  "ate",
  "até",
  "com",
  "em",
  "pago",
  "paga",
  "assinada",
  "posto",
  "viagem",
  "frete",
  "despesa",
  "gasto",
  "gastei",
  "abasteci",
  "litros",
  "toneladas",
]);

function isReservedWord(value: string): boolean {
  return COMPLEMENT_RESERVED.has(value.trim().toLowerCase());
}

function extractPlace(text: string): string | undefined {
  const stop = "(?=\\s+(?:deu|hoje|ontem)\\b|,|$)";
  const withNo = text.match(new RegExp(`\\b(?:l[aá]\\s+)?no\\s+(posto\\s+[^,.;]+?)${stop}`, "i"));
  if (withNo) return withNo[1].trim();
  const posto = text.match(new RegExp(`\\bposto\\s+([^,.;]+?)${stop}`, "i"));
  if (!posto) return undefined;
  const rest = posto[1].trim();
  if (!rest) return undefined;
  return /^posto\b/i.test(rest) ? rest : `posto ${rest}`;
}

const PLACE_BLOCKLIST =
  /^(hoje|ontem|pago|paga|assinada|pix|foi|isso|sim|nao|não|ok|blz|vlw|oi|alo|alô|bom dia)$/i;

/** Complemento curto de posto, sem exigir a palavra "posto" (`sao joao`). */
export function inferPlaceName(text: string): string | undefined {
  const known = extractPlace(text);
  if (known) return known;
  const n = text.trim().replace(/[?!.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n || PLACE_BLOCKLIST.test(n)) return undefined;
  if (/\b(abastec|gastei|despesa|frete|viagem|litros?|deu)\b/i.test(n)) return undefined;
  if (n.split(/\s+/).length > 5) return undefined;
  return /^posto\b/i.test(n) ? n : `posto ${n}`;
}

function extractDescription(text: string): string | undefined {
  const withPrep = text.match(
    /\b(?:com|de|em)\s+([^,.;]+?)(?=\s+(?:pago|paga|assinada)\b|,|$)/i,
  );
  if (withPrep) {
    const value = withPrep[1].trim();
    if (!/^(hoje|ontem|pago|paga|assinada)$/i.test(value)) return value;
  }
  const foi = text.match(
    /\b(?:foi|era)\s+(?:com\s+)?(?!hoje\b|ontem\b|pago\b|paga\b|assinada\b)([^,.;]+?)(?=\s+(?:pago|paga|assinada|hoje|ontem)\b|,|$)/i,
  );
  if (foi) return foi[1].trim();
  return undefined;
}

function extractAbastecimento(text: string, sentAt: Date, vehicle?: string) {
  const liters = text.match(/(\d+(?:[.,]\d+)?)\s*(?:l(?:itros?)?)\b/i);
  const total =
    text.match(/\bdeu\s*(?:r\$\s*)?(\d+(?:[.,]\d+)?)\b/i) ??
    text.match(/(?:r\$\s*)(\d+(?:[.,]\d+)?)/i);
  const fields: Record<string, string | number> = {};
  const date = resolveDate(text, sentAt);
  if (date) fields.date = date;
  if (liters) fields.liters = parseNumber(liters[1]);
  if (total) fields.totalBrl = parseNumber(total[1]);
  if (fields.liters === undefined && fields.totalBrl === undefined) {
    const bare = text.match(/\babastec\w*\s+(\d+(?:[.,]\d+)?)\b/i);
    if (bare) {
      if (/\b(reais|r\$|deu)\b/i.test(text)) fields.totalBrl = parseNumber(bare[1]);
      else fields.liters = parseNumber(bare[1]);
    }
  }
  const place = extractPlace(text);
  if (place) fields.place = place;
  const payment = paymentToken(text);
  if (payment) fields.payment = payment;
  if (vehicle) fields.vehicle = vehicle;
  return fields;
}

function extractDespesa(text: string, sentAt: Date, vehicle?: string) {
  const amount =
    text.match(/\b(?:gastei|gasto|despesa)\s*(?:de\s*)?(?:r\$\s*)?(\d+(?:[.,]\d+)?)/i) ??
    text.match(/\bfoi\s+(?:de\s+|r\$\s*)?(\d+(?:[.,]\d+)?)/i) ??
    text.match(/(?:r\$\s*)(\d+(?:[.,]\d+)?)/i) ??
    text.match(/\b(\d+(?:[.,]\d+)?)\s*(?:reais|no pix)\b/i);
  const fields: Record<string, string | number> = {};
  const date = resolveDate(text, sentAt);
  if (date) fields.date = date;
  if (amount) fields.amountBrl = parseNumber(amount[1]);
  const description = extractDescription(text);
  if (description && !/^\d/.test(description.trim())) fields.description = description;
  if (!fields.description) {
    const known = text.match(/\b(eletricista|mec[aâ]nico|pneu|oficina|motor)\b/i);
    if (known) fields.description = known[1].toLowerCase();
  }
  const payment = paymentToken(text);
  if (payment) fields.payment = payment;
  if (vehicle) fields.vehicle = vehicle;
  return fields;
}

const ROUTE_TO = String.raw`(?:para|pra|at[eé]|ate)`;
const ROUTE_STOP = String.raw`(?=\s+com\b|\s+\d|,|;|$)`;

function cleanPlace(value: string): string {
  return value
    .replace(/\bviagem\b/gi, " ")
    .replace(/^(al[oô]|oi|ola|olá)[,.\s]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRoute(text: string): { origin: string; destination: string } | undefined {
  const de = text.match(new RegExp(String.raw`\bde\s+(.+?)\s+${ROUTE_TO}\s+(.+?)${ROUTE_STOP}`, "i"));
  if (de) {
    const origin = cleanPlace(de[1]);
    const destination = cleanPlace(de[2]);
    if (origin && destination) return { origin, destination };
  }
  if (/\b(suspender|listar)\b/i.test(text)) return undefined;
  const ate = text.match(new RegExp(String.raw`(?:^|[,;]\s*)(.+?)\s+${ROUTE_TO}\s+(.+?)${ROUTE_STOP}`, "i"));
  if (!ate) return undefined;
  const origin = cleanPlace(ate[1]);
  const destination = cleanPlace(ate[2]);
  if (origin && destination) return { origin, destination };
  return undefined;
}

function samePlace(value: string, place: string | number | undefined): boolean {
  return typeof place === "string" && value.trim().toLowerCase() === place.trim().toLowerCase();
}

function isRouteMaterial(value: string, origin?: string | number, destination?: string | number): boolean {
  if (isReservedWord(value)) return true;
  if (samePlace(value, origin) || samePlace(value, destination)) return true;
  return /\b(de|para|pra|at[eé]|ate|viagem)\b/i.test(value);
}

function extractViagem(text: string, sentAt: Date, vehicle?: string) {
  const route = extractRoute(text);
  const qty = text.match(CARGO_QTY_UNIT_RE);
  const material = text.match(/\b(?:com|de|,)\s*([a-zA-Zá-úÁ-Ú]+)\s+(\d+(?:[.,]\d+)?)\s*(?:toneladas?|t\b|m[³3])/i)
    ?? text.match(/,\s*([a-zA-Zá-úÁ-Ú]+)\s*,/i);
  const unitPrice = text.match(/\b(?:pre[cç]o|r\$)\s*(?:por\s*)?(?:unidade\s*)?(\d+(?:[.,]\d+)?)/i);
  const freightTotal = text.match(/\bfrete\s*(?:de\s*|total\s*)?(?:r\$\s*)?(\d+(?:[.,]\d+)?)/i);
  const receipt = text.match(/\breceb(?:i|ido|imento)\s+([^,.;]+)/i);

  const fields: Record<string, string | number> = {};
  const date = resolveDate(text, sentAt);
  if (date) fields.date = date;
  if (route) {
    fields.origin = route.origin;
    fields.destination = route.destination;
  }
  if (qty) {
    fields.quantity = parseNumber(qty[1]);
    const unit = normalizeCargoUnit(qty[2]);
    if (unit) fields.unit = unit;
  }
  if (material && !isRouteMaterial(material[1], fields.origin, fields.destination)) {
    fields.material = material[1].trim();
  }
  if (!fields.material && qty && qty.index !== undefined) {
    const after = text.slice(qty.index + qty[0].length).match(/^\s*[,.]?\s*([A-Za-zÀ-ú]{3,})\b/);
    if (after && !isRouteMaterial(after[1], fields.origin, fields.destination)) {
      fields.material = after[1].trim();
    }
  }
  if (!fields.material) {
    const beforeQty = text.match(CARGO_MATERIAL_QTY_RE);
    if (beforeQty && !isRouteMaterial(beforeQty[1], fields.origin, fields.destination)) {
      const idx = beforeQty.index ?? 0;
      const prefix = text.slice(Math.max(0, idx - 16), idx);
      if (!new RegExp(String.raw`${ROUTE_TO}\s*$`, "i").test(prefix)) {
        fields.material = beforeQty[1].trim();
        if (fields.quantity === undefined && beforeQty[2]) fields.quantity = parseNumber(beforeQty[2]);
        if (fields.unit === undefined && beforeQty[3]) {
          const unit = normalizeCargoUnit(beforeQty[3]);
          if (unit) fields.unit = unit;
        }
      }
    }
  }
  if (!fields.material) {
    const lone = text.trim().match(/^(?:foi|era)\s+([A-Za-zÀ-ú]+)$/i) ?? text.trim().match(/^([A-Za-zÀ-ú]+)$/i);
    if (lone && !isRouteMaterial(lone[1], fields.origin, fields.destination)) fields.material = lone[1].trim();
  }
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
  const normalized = text.trim();
  return (
    /agora n[aã]o posso\b/i.test(normalized) ||
    /agora n[aã]o( consigo)?/i.test(normalized) ||
    /n[aã]o consigo falar agora/i.test(normalized) ||
    /n[aã]o posso (falar|responder) agora/i.test(normalized) ||
    /te mando depois/i.test(normalized) ||
    /mais tarde eu mando/i.test(normalized) ||
    /depois respondo/i.test(normalized)
  );
}

export function extractFromText(
  text: string,
  sentAt: Date,
  vehicleHint?: string,
): Extracted | undefined {
  const kind = detectKind(text);
  if (!kind) return undefined;
  return extractComplement(kind, text, sentAt, vehicleHint);
}

/** Extrai campos de um tipo já conhecido, sem exigir a palavra da categoria. */
export function extractComplement(
  kind: RecordKind,
  text: string,
  sentAt: Date,
  vehicleHint?: string,
): Extracted {
  if (kind === "abastecimento") {
    return { kind, abastecimento: extractAbastecimento(text, sentAt, vehicleHint) };
  }
  if (kind === "despesa") {
    return { kind, despesa: extractDespesa(text, sentAt, vehicleHint) };
  }
  return { kind, viagem: extractViagem(text, sentAt, vehicleHint) };
}

/** Preenche só campos ainda faltantes, inclusive posto sem a palavra "posto". */
export function extractPendingFill(
  kind: RecordKind,
  missing: string[],
  text: string,
  sentAt: Date,
  vehicleHint?: string,
): Record<string, string | number> {
  const extracted = extractComplement(kind, text, sentAt, vehicleHint);
  const bucket = extracted.abastecimento ?? extracted.despesa ?? extracted.viagem ?? {};
  const fill: Record<string, string | number> = {};
  for (const key of missing) {
    const value = bucket[key];
    if (value !== undefined && value !== "") fill[key] = value;
  }
  if (missing.includes("place") && fill.place === undefined) {
    const place = inferPlaceName(text);
    if (place) fill.place = place;
  }
  return fill;
}

const NEW_EVENT_CORE: Record<RecordKind, string[]> = {
  abastecimento: ["liters", "totalBrl"],
  despesa: ["amountBrl"],
  viagem: ["origin", "destination", "quantity"],
};

export function isNewOperationalEvent(
  extracted: Extracted | undefined,
  pendingKind: RecordKind,
  pendingFields: Record<string, string | number | undefined> | undefined,
): boolean {
  if (!extracted) return false;
  if (extracted.kind !== pendingKind) return true;
  const incoming =
    extracted.abastecimento ?? extracted.despesa ?? extracted.viagem ?? {};
  const existing = pendingFields ?? {};
  return NEW_EVENT_CORE[pendingKind].some((key) => {
    const next = incoming[key];
    const prev = existing[key];
    return next !== undefined && next !== "" && prev !== undefined && prev !== "";
  });
}
