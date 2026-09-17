import { SHEET_COLUMNS, type SheetRow } from "./mapper.ts";

export function sheetRange(tabName: string): string {
  const safe = tabName.replace(/'/g, "''");
  return `'${safe}'!A1`;
}

export function sheetClearRange(tabName: string): string {
  const safe = tabName.replace(/'/g, "''");
  return `'${safe}'!A:Z`;
}

export function rowsToValueRange(rows: SheetRow[]): string[][] {
  const header = [...SHEET_COLUMNS];
  const body = rows.map((row) => SHEET_COLUMNS.map((col) => row[col] ?? ""));
  return [header, ...body];
}

type SheetsMeta = { sheets?: Array<{ properties?: { title?: string } }> };

export async function ensureSheetTab(input: {
  spreadsheetId: string;
  tabName: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ created: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" };
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}?fields=sheets.properties.title`;
  const metaRes = await fetchImpl(metaUrl, { method: "GET", headers });
  const metaRaw = await metaRes.text();
  if (!metaRes.ok) throw new Error(`sheets meta http ${metaRes.status}`);
  let meta: SheetsMeta;
  try {
    meta = JSON.parse(metaRaw) as SheetsMeta;
  } catch {
    throw new Error("sheets meta json invalid");
  }
  const titles = (meta.sheets ?? []).map((item) => item.properties?.title).filter(Boolean);
  if (titles.includes(input.tabName)) return { created: false };
  const addUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}:batchUpdate`;
  const add = await fetchImpl(addUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: input.tabName } } }],
    }),
  });
  if (!add.ok) throw new Error(`sheets addSheet http ${add.status}`);
  return { created: true };
}

export async function replaceSheetValues(input: {
  spreadsheetId: string;
  tabName: string;
  accessToken: string;
  rows: SheetRow[];
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" };
  await ensureSheetTab({
    spreadsheetId: input.spreadsheetId,
    tabName: input.tabName,
    accessToken: input.accessToken,
    fetchImpl,
  });
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values`;
  const clearUrl = `${base}/${encodeURIComponent(sheetClearRange(input.tabName))}:clear`;
  const clear = await fetchImpl(clearUrl, { method: "POST", headers, body: "{}" });
  if (!clear.ok) throw new Error(`sheets clear http ${clear.status}`);
  const updateUrl = `${base}/${encodeURIComponent(sheetRange(input.tabName))}?valueInputOption=RAW`;
  const update = await fetchImpl(updateUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({ range: sheetRange(input.tabName), majorDimension: "ROWS", values: rowsToValueRange(input.rows) }),
  });
  if (!update.ok) throw new Error(`sheets update http ${update.status}`);
}
