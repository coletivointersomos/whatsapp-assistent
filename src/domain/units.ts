/** Normaliza unidade de carga da viagem. Sem enum rígido: aceita m3, m³ e metros cúbicos. */
export function normalizeCargoUnit(raw: string | number | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const n = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/³/g, "3")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(m3|m\^3|mt3)$/.test(n) || /metros?\s*cubicos?/.test(n) || n === "metro cubico") return "m³";
  if (/^(t|ton|tonelada|toneladas)$/.test(n)) return "toneladas";
  if (/^kg$/.test(n) || /^quilos?$/.test(n)) return "kg";
  return text.slice(0, 20);
}

const UNIT_TOKEN = String.raw`toneladas?|t\b|m3|m³|m\u00b3|metros?\s*c[uú]bicos?|kg`;

export const CARGO_QTY_UNIT_RE = new RegExp(
  String.raw`(\d+(?:[.,]\d+)?)\s*(${UNIT_TOKEN})(?=\s|$|,|\.|;)`,
  "i",
);

export const CARGO_MATERIAL_QTY_RE = new RegExp(
  String.raw`\b([A-Za-zÀ-ú]+)\s*[, ]+\s*(\d+(?:[.,]\d+)?)\s*(${UNIT_TOKEN})(?=\s|$|,|\.|;)`,
  "i",
);
