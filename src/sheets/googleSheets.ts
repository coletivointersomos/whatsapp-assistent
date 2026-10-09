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

const GREEN = { red: 0.82, green: 0.93, blue: 0.82 };
const RED = { red: 0.96, green: 0.8, blue: 0.8 };
const HEADER = { red: 0.93, green: 0.93, blue: 0.93 };

type SheetsMeta = { sheets?: Array<{ properties?: { title?: string; sheetId?: number } }> };

export function fluxoColorRequests(sheetId: number, rows: SheetRow[]): unknown[] {
  const colCount = SHEET_COLUMNS.length;
  const requests: unknown[] = [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: colCount },
        cell: { userEnteredFormat: { backgroundColor: HEADER, textFormat: { bold: true } } },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
  ];
  rows.forEach((row, index) => {
    const color = row.fluxo === "entrada" ? GREEN : row.fluxo === "saida" ? RED : undefined;
    if (!color) return;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: index + 1,
          endRowIndex: index + 2,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        cell: { userEnteredFormat: { backgroundColor: color } },
        fields: "userEnteredFormat.backgroundColor",
      },
    });
  });
  return requests;
}

async function readMeta(input: {
  spreadsheetId: string;
  accessToken: string;
  fetchImpl: typeof fetch;
}): Promise<SheetsMeta> {
  const headers = { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" };
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}?fields=sheets.properties(title,sheetId)`;
  const metaRes = await input.fetchImpl(metaUrl, { method: "GET", headers });
  const metaRaw = await metaRes.text();
  if (!metaRes.ok) throw new Error(`sheets meta http ${metaRes.status}`);
  try {
    return JSON.parse(metaRaw) as SheetsMeta;
  } catch {
    throw new Error("sheets meta json invalid");
  }
}

function tabSheetId(meta: SheetsMeta, tabName: string): number | undefined {
  return meta.sheets?.find((item) => item.properties?.title === tabName)?.properties?.sheetId;
}

export async function ensureSheetTab(input: {
  spreadsheetId: string;
  tabName: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ created: boolean; sheetId?: number }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" };
  const first = await readMeta({ spreadsheetId: input.spreadsheetId, accessToken: input.accessToken, fetchImpl });
  const existing = tabSheetId(first, input.tabName);
  if (existing !== undefined) return { created: false, sheetId: existing };
  const addUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}:batchUpdate`;
  const add = await fetchImpl(addUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: input.tabName } } }],
    }),
  });
  if (!add.ok) throw new Error(`sheets addSheet http ${add.status}`);
  const second = await readMeta({ spreadsheetId: input.spreadsheetId, accessToken: input.accessToken, fetchImpl });
  return { created: true, sheetId: tabSheetId(second, input.tabName) };
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
  const tab = await ensureSheetTab({
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
  if (tab.sheetId === undefined) return;
  const format = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}:batchUpdate`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requests: fluxoColorRequests(tab.sheetId, input.rows) }),
    },
  );
  if (!format.ok) throw new Error(`sheets format http ${format.status}`);
}
