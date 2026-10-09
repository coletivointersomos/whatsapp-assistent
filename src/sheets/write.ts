import { readFileSync } from "node:fs";
import type { AppState, OperationalRecord } from "../domain/types.ts";
import { recordInCurrentSession, parseSessionStart } from "../assistant-v2/session.ts";
import { assignSheetCodes, isSyncEligible, recordToRow, tabForRecord, type SheetRow } from "./mapper.ts";
import { loadSheetsWriteConfig, sheetsWriteSkipReason, canWriteAppsScript, type SheetsWriteConfig } from "./config.ts";
import { fetchGoogleAccessToken, type ServiceAccountFile } from "./googleJwt.ts";
import { replaceSheetValues, rowsToValueRange } from "./googleSheets.ts";
import { postAppsScriptRewrite } from "./appsScript.ts";

export function recordsForSheet(state: AppState, sessionStartedAt?: string): OperationalRecord[] {
  const sessionMs = parseSessionStart(sessionStartedAt);
  if (!sessionMs) return state.records.filter((item) => isSyncEligible(item));
  const conversations = state.conversations.filter((item) => item.active);
  return state.records.filter((record) => {
    if (!isSyncEligible(record)) return false;
    return conversations.some((conversation) => recordInCurrentSession(state, record, conversation, sessionMs));
  });
}

export function sheetRowsFromState(state: AppState, sessionStartedAt?: string): SheetRow[] {
  return assignSheetCodes(recordsForSheet(state, sessionStartedAt).map((record) => recordToRow(state, record)));
}

export function sheetGroupsFromState(
  state: AppState,
  sessionStartedAt?: string,
  tabMode: SheetsWriteConfig["tabMode"] = "fixed",
  fixedTab = "registros",
): Array<{ tabName: string; rows: SheetRow[] }> {
  const records = recordsForSheet(state, sessionStartedAt);
  if (tabMode !== "vehicle_month") {
    return [{ tabName: fixedTab, rows: assignSheetCodes(records.map((record) => recordToRow(state, record))) }];
  }
  const buckets = new Map<string, OperationalRecord[]>();
  for (const record of records) {
    const tab = tabForRecord(record);
    const list = buckets.get(tab) ?? [];
    list.push(record);
    buckets.set(tab, list);
  }
  return [...buckets.entries()].map(([tabName, items]) => ({
    tabName,
    rows: assignSheetCodes(items.map((record) => recordToRow(state, record))),
  }));
}

export function formatRewritePreview(input: {
  state: AppState;
  config: SheetsWriteConfig;
  source: string;
}): string {
  const rows = sheetRowsFromState(input.state, input.config.sessionStartedAt);
  const skip = sheetsWriteSkipReason(input.config);
  const session = input.config.sessionStartedAt ?? "todas (sem corte de sessão)";
  return [
    `Fonte: ${input.source}`,
    `Modo: dry-run (rewrite da aba)`,
    `Aba: ${input.config.tabName}`,
    `Sessão: ${session}`,
    `Linhas: ${rows.length}`,
    skip
      ? `Escrita: bloqueada (${skip})`
      : canWriteAppsScript(input.config)
        ? "Escrita: Apps Script (use --apply)"
        : "Escrita: pronta (use --apply)",
    "",
  ].join("\n");
}

function loadServiceAccount(path: string): ServiceAccountFile {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as ServiceAccountFile;
}

export async function writeSessionToSheet(input: {
  state: AppState;
  config?: SheetsWriteConfig;
  account?: ServiceAccountFile;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; rowCount: number } | { ok: false; reason: string }> {
  const config = input.config ?? loadSheetsWriteConfig();
  if (canWriteAppsScript(config)) {
    const rows = sheetRowsFromState(input.state, config.sessionStartedAt);
    return postAppsScriptRewrite({
      url: config.appsScriptUrl,
      token: config.appsScriptToken,
      tabName: config.tabName,
      values: rowsToValueRange(rows),
      fetchImpl: input.fetchImpl,
    });
  }
  return writeStateToGoogleSheet(input);
}

export async function writeStateToGoogleSheet(input: {
  state: AppState;
  config?: SheetsWriteConfig;
  account?: ServiceAccountFile;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; rowCount: number } | { ok: false; reason: string }> {
  const config = input.config ?? loadSheetsWriteConfig();
  if (!input.account) {
    const skip = sheetsWriteSkipReason(config);
    if (skip) return { ok: false, reason: skip };
  }
  if (!config.spreadsheetId) return { ok: false, reason: "missing_spreadsheet_id" };
  try {
    const account = input.account ?? loadServiceAccount(config.credentialsPath);
    const token = await fetchGoogleAccessToken(account, input.fetchImpl);
    const groups = sheetGroupsFromState(input.state, config.sessionStartedAt, config.tabMode, config.tabName);
    let rowCount = 0;
    for (const group of groups) {
      await replaceSheetValues({
        spreadsheetId: config.spreadsheetId,
        tabName: group.tabName,
        accessToken: token,
        rows: group.rows,
        fetchImpl: input.fetchImpl,
      });
      rowCount += group.rows.length;
    }
    return { ok: true, rowCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : "sheets_write_failed";
    return { ok: false, reason: message.slice(0, 180) };
  }
}
