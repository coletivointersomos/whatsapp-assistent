import { readFileSync } from "node:fs";
import { monitoredVehicle } from "../config/monitored.ts";
import type { AppState } from "../domain/types.ts";
import { archiveBaseName, ensureMonthFolders, monthFolderName } from "../drive/archive.ts";
import { DEFAULT_DRIVE_ROOT_FOLDER_ID } from "../drive/config.ts";
import { createDriveClient, DRIVE_SCOPE, type DriveClient, type DriveFile } from "../drive/googleDrive.ts";
import { maskJidsInText } from "../privacy/pii.ts";
import { fetchGoogleAccessToken, type ServiceAccountFile } from "./googleJwt.ts";
import { buildModeloFill, type LinkLookup, type ModeloFill } from "./modelo.ts";
import { planPagamento } from "./pagamento.ts";
import type { RascunhoRow } from "./rascunho.ts";

/**
 * Parte 2e: cópia do Modelo → "<PLACA_CURTA> - <Mês> <Ano> (Hermes)" na pasta do mês, preenchendo
 * só a aba do motorista. Atrás de MODELO_SHEET_ENABLED=false.
 * Travas (todas verificadas antes de qualquer escrita):
 *  - o arquivo escrito tem que ter sido criado/achado com nome terminado em " (Hermes)";
 *  - nunca é o Modelo nem nenhuma planilha protegida ("TFA - Setembro 2026", "TFA - Outubro 2026"…:
 *    qualquer planilha da pasta do mês sem o sufixo);
 *  - só a aba do motorista recebe valores; nenhuma outra aba é tocada;
 *  - no Drive só cria (cópia/pasta). Nada é apagado, movido ou renomeado.
 * Exceção explícita (Bruno, 19/10/2026): com MODELO_TARGET_SPREADSHEET_ID a CLI usa
 * appendExisting.ts (planilha existente do mês, SOMENTE ACRESCENTAR) e este caminho de cópia não roda.
 */
export type ModeloConfig = {
  enabled: boolean;
  rootFolderId: string;
  credentialsPath: string;
  suffix: string;
};

export function loadModeloConfig(env: Record<string, string | undefined> = process.env): ModeloConfig {
  return {
    enabled: env.MODELO_SHEET_ENABLED === "true",
    rootFolderId: env.DRIVE_ROOT_FOLDER_ID?.trim() || DEFAULT_DRIVE_ROOT_FOLDER_ID,
    credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? "",
    suffix: " (Hermes)",
  };
}

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

export function hermesCopyName(competencia: string, suffix = " (Hermes)"): string {
  const [y, m] = competencia.split("-").map(Number) as [number, number];
  return `${monitoredVehicle().plate.slice(0, 3)} - ${MESES[m - 1]} ${y}${suffix}`;
}

/** Linhas da competência: promovíveis entram nos blocos; confirmar/incompleto/outro vão para ITENS A CONFIRMAR. */
export function rowsForModelo(state: AppState, competencia: string): { rows: RascunhoRow[]; pendentes: RascunhoRow[] } {
  const plan = planPagamento({ state, commissionRate: 0.11 });
  const promotable = new Set(plan.validation.promotable.map((r) => `${r.record_id}|${r.message_id}`));
  const month = plan.merged.filter((r) => r.competencia === competencia && r.status !== "duplicado" && r.status !== "ignorado");
  return {
    rows: month.filter((r) => promotable.has(`${r.record_id}|${r.message_id}`)),
    pendentes: month.filter((r) => !promotable.has(`${r.record_id}|${r.message_id}`)),
  };
}

/** Link do arquivo da mensagem (nome-base do 2d) nas subpastas do mês. */
export function linkLookupFromFiles(state: AppState, files: DriveFile[]): LinkLookup {
  const byTag = new Map<string, DriveFile>();
  for (const f of files) {
    const tag = /-([0-9a-f]{8})(?: \(\d+\))?\.[A-Za-z0-9]+$/.exec(f.name)?.[1];
    if (tag && !f.name.startsWith("conversa-") && !byTag.has(tag)) byTag.set(tag, f);
  }
  return (row) => {
    const message = state.messages.find((m) => m.externalId === row.message_id || maskJidsInText(m.externalId) === row.message_id);
    if (!message) return undefined;
    const tag = archiveBaseName(message.externalId, message.sentAt).slice(-8);
    const file = byTag.get(tag);
    if (!file) return undefined;
    return { url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`, fileLabel: file.name.replace(/\.[A-Za-z0-9]+$/, "") };
  };
}

type SheetsApi = {
  getSheets(id: string): Promise<Array<{ sheetId: number; title: string }>>;
  readCell(id: string, range: string): Promise<string>;
  insertRows(id: string, sheetId: number, beforeRow: number, count: number): Promise<void>;
  writeValues(id: string, data: Array<{ range: string; values: Array<Array<string | number>> }>): Promise<void>;
};

export function createSheetsApi(token: () => Promise<string>, fetchImpl: typeof fetch = fetch): SheetsApi {
  const base = "https://sheets.googleapis.com/v4/spreadsheets";
  const call = async <T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`sheets http ${res.status}`);
    return JSON.parse(raw || "{}") as T;
  };
  return {
    async getSheets(id) {
      const r = await call<{ sheets?: Array<{ properties: { sheetId: number; title: string } }> }>("GET", `${base}/${id}?fields=sheets(properties(sheetId,title))`);
      return (r.sheets ?? []).map((s) => s.properties);
    },
    async readCell(id, range) {
      const r = await call<{ values?: string[][] }>("GET", `${base}/${id}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`);
      return r.values?.[0]?.[0] ?? "";
    },
    async insertRows(id, sheetId, beforeRow, count) {
      await call("POST", `${base}/${id}:batchUpdate`, {
        requests: [{ insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: beforeRow - 1, endIndex: beforeRow - 1 + count }, inheritFromBefore: true } }],
      });
    },
    async writeValues(id, data) {
      await call("POST", `${base}/${id}/values:batchUpdate`, { valueInputOption: "USER_ENTERED", data });
    },
  };
}

export type ModeloRunResult = {
  status: "disabled" | "dry_run" | "written";
  copyName: string;
  copied?: boolean;
  spreadsheetId?: string;
  fill: ModeloFill;
};

export async function runModeloFill(input: {
  state: AppState;
  competencia: string;
  config: ModeloConfig;
  dryRun?: boolean;
  today?: string;
  drive?: DriveClient;
  sheets?: SheetsApi;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<ModeloRunResult> {
  const log = input.log ?? (() => undefined);
  const today = input.today ?? new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const copyName = hermesCopyName(input.competencia, input.config.suffix);
  const { rows, pendentes } = rowsForModelo(input.state, input.competencia);
  if (input.dryRun || !input.config.enabled) {
    const fill = buildModeloFill({ competencia: input.competencia, rows, pendentes, today });
    return { status: input.dryRun ? "dry_run" : "disabled", copyName, fill };
  }
  if (!copyName.endsWith(" (Hermes)")) throw new Error("modelo: nome da cópia sem sufixo (Hermes)");

  let token: (() => Promise<string>) | undefined;
  if (!input.drive || !input.sheets) {
    if (!input.config.credentialsPath) throw new Error("modelo: GOOGLE_APPLICATION_CREDENTIALS vazio");
    let cached: { t: string; until: number } | undefined;
    token = async () => {
      if (cached && cached.until > Date.now()) return cached.t;
      const account = JSON.parse(readFileSync(input.config.credentialsPath, "utf8")) as ServiceAccountFile;
      const t = await fetchGoogleAccessToken(account, fetch, `${DRIVE_SCOPE} https://www.googleapis.com/auth/spreadsheets`);
      cached = { t, until: Date.now() + 50 * 60_000 };
      return t;
    };
  }
  const drive = input.drive ?? createDriveClient({ token: token! });
  const sheets = input.sheets ?? createSheetsApi(token!);

  const rootKids = await drive.listChildren(input.config.rootFolderId);
  const modelos = rootKids.filter((f) => f.name === "Modelo" && f.mimeType === "application/vnd.google-apps.spreadsheet");
  if (modelos.length !== 1) throw new Error(`modelo: esperado 1 'Modelo' na raiz, achou ${modelos.length}`);
  const modelo = modelos[0]!;
  const month = await ensureMonthFolders(drive, input.config.rootFolderId, input.competencia);
  const monthKids = await drive.listChildren(month.monthId);
  const protectedIds = new Set<string>([modelo.id]);
  for (const f of [...rootKids, ...monthKids]) {
    if (f.mimeType === "application/vnd.google-apps.spreadsheet" && !f.name.endsWith(input.config.suffix)) protectedIds.add(f.id);
  }
  const existing = monthKids.filter((f) => f.name === copyName && f.mimeType === "application/vnd.google-apps.spreadsheet");
  let target: DriveFile;
  let copied = false;
  if (existing[0]) {
    target = existing[0];
  } else {
    target = await drive.copyFile(modelo.id, month.monthId, copyName);
    copied = true;
    log("modelo_copied", { folder: monthFolderName(input.competencia) });
  }
  if (protectedIds.has(target.id) || !target.name.endsWith(input.config.suffix)) throw new Error("modelo: alvo protegido — nada escrito");

  const tabs = await sheets.getSheets(target.id);
  const tab = tabs.find((t) => t.title.trim().toUpperCase() === monitoredVehicle().driver.toUpperCase());
  if (!tab) throw new Error("modelo: aba do motorista não encontrada");
  const indent = /^(\s*)/.exec(await sheets.readCell(target.id, `'${tab.title.replace(/'/g, "''")}'!A18`))?.[1] ?? "";

  // links dos arquivos já no Drive (2d), nas subpastas do mês
  const files: DriveFile[] = [];
  for (const id of [month.sub.fotos, month.sub.comprovantes, month.sub.audios]) files.push(...(await drive.listChildren(id)));
  const fill = buildModeloFill({
    competencia: input.competencia,
    rows,
    pendentes,
    linkFor: linkLookupFromFiles(input.state, files),
    tabTitle: tab.title,
    titleIndent: indent || undefined,
    today,
  });
  const prefix = `'${tab.title.replace(/'/g, "''")}'!`;
  if (!fill.writes.every((w) => w.range.startsWith(prefix))) throw new Error("modelo: escrita fora da aba do motorista");
  if (!copied && fill.inserts.length) throw new Error("modelo: cópia já existente precisaria de linhas novas — refazer numa cópia nova");
  for (const ins of fill.inserts) await sheets.insertRows(target.id, tab.sheetId, ins.beforeRow, ins.count);
  await sheets.writeValues(target.id, fill.writes);
  log("modelo_written", { copied, writes: fill.writes.length, inserts: fill.inserts.length });
  return { status: "written", copyName, copied, spreadsheetId: target.id, fill };
}
