import type { AppState, OperationalRecord } from "../domain/types.ts";
import { maskPii } from "./pii.ts";

/**
 * Campos de texto livre dos registros que podem trazer PII (comprovante, nota do motorista).
 * Ids, datas, placas, valores numéricos e litros ficam de fora.
 */
const RECORD_TEXT_FIELDS = {
  abastecimento: ["place", "payment", "note"],
  despesa: ["description", "payment", "note"],
  viagem: ["origin", "destination", "material", "note", "receipt"],
} as const;

/** Mascara PII nos campos de texto do registro, no próprio objeto. Retorna true se mudou algo. */
export function maskRecordPiiInPlace(record: OperationalRecord): boolean {
  let changed = false;
  for (const kind of Object.keys(RECORD_TEXT_FIELDS) as (keyof typeof RECORD_TEXT_FIELDS)[]) {
    const fields = record[kind] as Record<string, unknown> | undefined;
    if (!fields) continue;
    for (const key of RECORD_TEXT_FIELDS[kind]) {
      const value = fields[key];
      if (typeof value !== "string" || !value) continue;
      const masked = maskPii(value);
      if (masked !== value) {
        fields[key] = masked;
        changed = true;
      }
    }
  }
  return changed;
}

/** Antes de gravar o store: mascara PII nos registros (idempotente). Retorna quantos mudaram. */
export function maskStateRecordsPii(state: AppState): number {
  let count = 0;
  for (const record of state.records) if (maskRecordPiiInPlace(record)) count += 1;
  return count;
}
