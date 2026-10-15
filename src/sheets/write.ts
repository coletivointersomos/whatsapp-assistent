import { readFileSync } from "node:fs";
import type { AppState, OperationalRecord } from "../domain/types.ts";
import { recordInCurrentSession, parseSessionStart } from "../assistant-v2/session.ts";
import {
  assignControleCodes,
  assignSheetCodes,
  controleToValues,
  isSyncEligible,
  recordToControleRow,
  recordToRow,
  resumoGrid,
  resumoTabName,
  tabForRecord,
  type ControleRow,
  type SheetRow,
} from "./mapper.ts";
import { loadSheetsWriteConfig, sheetsWriteSkipReason, canWriteAppsScript, type SheetsWriteConfig } from "./config.ts";
import { fetchGoogleAccessToken, type ServiceAccountFile } from "./googleJwt.ts";
import { replaceSheetValues, rowsToValueRange } from "./googleSheets.ts";
import { postAppsScriptRewrite } from "./appsScript.ts";
import { planPagamento, writePagamentoToGoogleSheet } from "./pagamento.ts";
import { oficialTabName } from "./oficial.ts";

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

export function controleGroupsFromState(
  state: AppState,
  sessionStartedAt?: string,
): Array<{ tabName: string; resumoTab: string; rows: ControleRow[] }> {
  const records = recordsForSheet(state, sessionStartedAt);
  const buckets = new Map<string, OperationalRecord[]>();
  for (const record of records) {
    const tab = tabForRecord(record);
    const list = buckets.get(tab) ?? [];
    list.push(record);
    buckets.set(tab, list);
  }
  return [...buckets.entries()].map(([tabName, items]) => {
    const dateOf = (record: OperationalRecord) =>
      record.viagem?.date ?? record.despesa?.date ?? record.abastecimento?.date ?? "";
    const vehicleOf = (record: OperationalRecord) =>
      record.viagem?.vehicle ?? record.despesa?.vehicle ?? record.abastecimento?.vehicle;
    const sorted = [...items].sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    const sample = sorted[0];
    return {
      tabName,
      resumoTab: resumoTabName(vehicleOf(sample), dateOf(sample)),
      rows: assignControleCodes(sorted.map((record) => recordToControleRow(state, record))),
    };
  });
}

export function formatRewritePreview(input: {
  state: AppState;
  config: SheetsWriteConfig;
  source: string;
}): string {
  const pagamento = input.config.tabMode === "vehicle_month";
  const plan = pagamento
    ? planPagamento({
        state: input.state,
        sessionStartedAt: input.config.sessionStartedAt,
        commissionRate: input.config.commissionRate,
      })
    : undefined;
  const rows = pagamento
    ? plan?.merged ?? []
    : sheetRowsFromState(input.state, input.config.sessionStartedAt);
  const tabs = pagamento
    ? [input.config.rascunhoTabName, ...(plan?.oficial.map((item) => item.tabName) ?? [oficialTabName("2026-09")])].join(", ")
    : input.config.tabName;
  const skip = sheetsWriteSkipReason(input.config);
  const session = input.config.sessionStartedAt ?? "todas (sem corte de sessão)";
  return [
    `Fonte: ${input.source}`,
    `Modo: ${pagamento ? "dry-run (rascunho append + oficial se limpo)" : "dry-run (rewrite da aba)"}`,
    `Aba: ${tabs}`,
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
  if (config.tabMode !== "vehicle_month" && canWriteAppsScript(config)) {
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
    if (config.tabMode === "vehicle_month") {
      return writePagamentoToGoogleSheet({
        state: input.state,
        config,
        accessToken: token,
        fetchImpl: input.fetchImpl,
      });
    }
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
