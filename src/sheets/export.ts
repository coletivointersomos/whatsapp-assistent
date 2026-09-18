import { SHEET_COLUMNS, type SheetRow } from "./mapper.ts";

function tsvCell(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

/** Preview tabular. Sem Google: TSV estável para colar ou inspecionar. */
export function formatSheetTable(rows: SheetRow[]): string {
  const header = SHEET_COLUMNS.join("\t");
  const body = rows.map((row) => SHEET_COLUMNS.map((col) => tsvCell(row[col])).join("\t")).join("\n");
  return body ? `${header}\n${body}\n` : `${header}\n`;
}
