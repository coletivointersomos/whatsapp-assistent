import { readFileSync } from "node:fs";
import { monitoredVehicle } from "../config/monitored.ts";
import type { AppState } from "../domain/types.ts";
import { monthFolderName } from "../drive/archive.ts";
import { createDriveClient, DRIVE_SCOPE, type DriveClient, type DriveFile } from "../drive/googleDrive.ts";
import { fetchGoogleAccessToken, type ServiceAccountFile } from "./googleJwt.ts";
import { parseSacosFreight } from "./mapper.ts";
import { CONFIRMAR, hyperlink, safeText, type CellWrite, type LinkLookup } from "./modelo.ts";
import { hermesCopyName, linkLookupFromFiles, rowsForModelo, type ModeloConfig } from "./modeloWriter.ts";
import { asNumber, tripUnitPrice } from "./oficial.ts";
import type { RascunhoRow } from "./rascunho.ts";

/**
 * Planilha EXISTENTE do mês (preenchida à mão), modo SOMENTE ACRESCENTAR (decisão do Bruno, 19/10/2026).
 *   MODELO_SHEET_ENABLED=true
 *   MODELO_TARGET_SPREADSHEET_ID=<id da planilha do mês>   (ex.: "TFA - Outubro 2026")
 *   MODELO_WRITE_MODE=append_only                          (único modo aceito com alvo existente)
 * Garantias (verificadas no código, antes de qualquer escrita):
 *  - a API usada aqui só tem GET (metadados/valores) e values:batchUpdate — sem inserir/apagar
 *    linha, sem limpar, sem formatar, sem mexer em aba;
 *  - cada escrita é UMA célula da aba do motorista que estava VAZIA na leitura feita logo antes;
 *  - só usa linhas livres DEPOIS da última linha ocupada de cada bloco, entre o cabeçalho e o total
 *    (nunca insere linha; bloco cheio → item fica no relatório, não é escrito);
 *  - colunas achadas pelo texto do cabeçalho que já existe na planilha (nada fixo por letra);
 *  - não relança o que já está lá: mesma data + mesmo valor em qualquer bloco = já lançado;
 *    mesma data no mesmo bloco com valor diferente = conflito, não escreve;
 *  - o título da planilha tem que ser o do mês da competência e nunca "TFA - Setembro 2026"/"Modelo";
 *  - células de fórmula (totais, H=F*G…) e o ACERTO MÊS nunca são escritos.
 */
export const APPEND_ONLY = "append_only" as const;
export const PROTECTED_TITLES = ["TFA - Setembro 2026", "Modelo"];

export type AppendTarget = { spreadsheetId: string; mode: typeof APPEND_ONLY };

export function loadAppendTarget(env: Record<string, string | undefined> = process.env): AppendTarget | undefined {
  const spreadsheetId = env.MODELO_TARGET_SPREADSHEET_ID?.trim();
  if (!spreadsheetId) return undefined;
  const mode = env.MODELO_WRITE_MODE?.trim() || APPEND_ONLY;
  if (mode !== APPEND_ONLY) throw new Error("modelo: planilha existente só aceita MODELO_WRITE_MODE=append_only");
  return { spreadsheetId, mode: APPEND_ONLY };
}

/** Grade lida com valueRenderOption=FORMULA; grid[0] é a linha 1. */
export type Grid = string[][];
export type BlockKind = "viagens" | "vista" | "prazo" | "despesas" | "depositos" | "pendencias";

export function norm(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

const TITLES: Array<[BlockKind, RegExp]> = [
  ["viagens", /^VIAGENS$/],
  ["vista", /^ABASTECIMENTO A VISTA$/],
  ["prazo", /^ABASTECIMENTO A PRAZO$/],
  ["despesas", /^DESPESAS$/],
  ["depositos", /^DEPOSITOS \/ PAGAMENTOS\b/],
  ["pendencias", /^ITENS A CONFIRMAR\b/],
];

/** Campo do Hermes → cabeçalho (normalizado) que já existe no bloco. */
const FIELDS: Record<BlockKind, Record<string, string>> = {
  viagens: { data: "DATA", origem: "ORIGEM", destino: "DESTINO", material: "MATERIAL", kg: "TONELADAS", tons: "COLUNAS1", unit: "VALOR", rate: "%", obs: "COLUNAS3" },
  vista: { data: "DATA", posto: "POSTO", valor: "VALOR", obs: "OBS" },
  prazo: { data: "DATA", posto: "POSTO", valor: "VALOR", prazo: "PRAZO", obs: "OBS" },
  despesas: { data: "DATA", descricao: "DESCRICAO", valor: "VALOR", obs: "OBSERVACAO" },
  depositos: { data: "DATA", descricao: "DESCRICAO", valor: "VALOR", obs: "OBSERVACAO" },
  pendencias: { data: "DATA", descricao: "DESCRICAO", valor: "VALOR", obs: "OBSERVACAO" },
};

export type Block = {
  kind: BlockKind;
  headerRow: number;
  /** cabeçalho normalizado → índice de coluna (0 = A) */
  columns: Map<string, number>;
  /** 1-based, inclusivos: linhas de dados entre o cabeçalho e o total/próximo título */
  firstRow: number;
  lastRow: number;
};

const cellAt = (grid: Grid, row: number, col: number): string => String(grid[row - 1]?.[col] ?? "");
const isEmpty = (v: string) => v.trim() === "";
const isFormula = (v: string) => v.trim().startsWith("=");
const isTotalRow = (grid: Grid, row: number) => (grid[row - 1] ?? []).some((c) => /^=\s*(SUBTOTAL|SUM)\s*\(/i.test(String(c ?? "").trim()));
const titleOf = (grid: Grid, row: number): BlockKind | undefined => TITLES.find(([, re]) => re.test(norm(cellAt(grid, row, 0))))?.[0];
const rowEmpty = (grid: Grid, row: number) => (grid[row - 1] ?? []).every((c) => isEmpty(String(c ?? "")));

export function findBlocks(grid: Grid): Block[] {
  const blocks: Block[] = [];
  for (let r = 1; r <= grid.length; r += 1) {
    const kind = titleOf(grid, r);
    if (!kind) continue;
    const headerRow = r + 1;
    const columns = new Map<string, number>();
    (grid[headerRow - 1] ?? []).forEach((c, i) => {
      const h = norm(c);
      if (h && !columns.has(h)) columns.set(h, i);
    });
    if (!columns.has("DATA")) continue;
    let end = headerRow + 1;
    let closedByTotal = false;
    for (; end <= grid.length; end += 1) {
      if (isTotalRow(grid, end)) {
        closedByTotal = true;
        break;
      }
      if (titleOf(grid, end) || norm(cellAt(grid, end, 0)).startsWith("OBS")) break;
    }
    let lastRow = end - 1;
    // sem linha de total: a última linha vazia antes do próximo bloco é separador, fica como está
    if (!closedByTotal && lastRow > headerRow && rowEmpty(grid, lastRow)) lastRow -= 1;
    if (end > grid.length && !closedByTotal) {
      // fim da grade sem fechamento: não há linha livre segura
      while (lastRow > headerRow && rowEmpty(grid, lastRow)) lastRow -= 1;
    }
    blocks.push({ kind, headerRow, columns, firstRow: headerRow + 1, lastRow });
  }
  return blocks;
}

/** Data de célula (serial do Sheets, =DATE(a,m,d) ou dd/mm/aaaa) → AAAA-MM-DD. */
export function cellDate(value: string): string | undefined {
  const v = value.trim();
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 40000 && n < 60000) return new Date(Math.round((Math.floor(n) - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const f = /^=\s*DATE\(\s*(\d{4})\s*[,;]\s*(\d{1,2})\s*[,;]\s*(\d{1,2})\s*\)$/i.exec(v);
  if (f) return `${f[1]}-${f[2]!.padStart(2, "0")}-${f[3]!.padStart(2, "0")}`;
  const b = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
  if (b) return `${b[3]}-${b[2]!.padStart(2, "0")}-${b[1]!.padStart(2, "0")}`;
  return undefined;
}

export function cellMoney(value: string): number {
  const v = value.trim();
  if (!v || isFormula(v)) return 0;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const s = v.replace(/R\$\s*/i, "").replace(/\s/g, "");
  const n = Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function colLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

type Existing = { kind: BlockKind; date: string; value: number };

function existingEntries(grid: Grid, blocks: Block[]): Existing[] {
  const out: Existing[] = [];
  for (const b of blocks) {
    const dCol = b.columns.get("DATA")!;
    const vCol = b.columns.get("VALOR");
    for (let r = b.firstRow; r <= b.lastRow; r += 1) {
      const date = cellDate(cellAt(grid, r, dCol));
      if (!date) continue;
      out.push({ kind: b.kind, date, value: vCol === undefined ? 0 : cellMoney(cellAt(grid, r, vCol)) });
    }
  }
  return out;
}

export type AppendSkip = { tipo: string; data: string; valor: number; motivo: "ja_lancado" | "conflito_mesma_data" | "sem_linha_livre" | "sem_data" | "bloco_ausente" };
export type AppendPlan = {
  tabTitle: string;
  writes: CellWrite[];
  appended: Array<{ bloco: BlockKind; linha: number; tipo: string; data: string; valor: number }>;
  skipped: AppendSkip[];
};

function kindFor(row: RascunhoRow): BlockKind | undefined {
  switch (row.tipo) {
    case "viagem":
      return "viagens";
    case "abastecimento_vista":
      return "vista";
    case "abastecimento_prazo":
      return "prazo";
    case "despesa":
    case "pedagio":
    case "balanca":
      return "despesas";
    case "deposito":
    case "pagamento":
      return "depositos";
    default:
      return undefined;
  }
}

function dateFormula(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)!;
  return `=DATE(${Number(m[1])},${Number(m[2])},${Number(m[3])})`;
}

function rowValues(kind: BlockKind, row: RascunhoRow, obs: (text: string) => string, rate: number): Record<string, string | number> {
  const up = (v: string | undefined) => safeText(v).toUpperCase();
  const valor = asNumber(row.valor);
  if (kind === "viagens") {
    const tons = asNumber(row.toneladas);
    const sack = parseSacosFreight(row.descricao);
    const unit = tripUnitPrice(row);
    let note = safeText(row.descricao);
    let g: string | number = "";
    // TOTAL (H) tem fórmula na planilha: nunca é sobrescrito; total diferente vai na observação
    if (sack) note = `${sack.sacos} sacos × R$ ${sack.unitPrice} = ${sack.total} — TOTAL (H) com fórmula, conferir ${CONFIRMAR}`;
    else if (unit > 0 && tons > 0) g = unit;
    else if (valor > 0) note = `${note} total R$ ${valor}; R$/t ${CONFIRMAR}`.trim();
    else note = `${note} valor ${CONFIRMAR}`.trim();
    return {
      data: dateFormula(row.data_doc),
      origem: up(row.origem),
      destino: up(row.destino),
      material: up(row.material),
      kg: tons ? Math.round(tons * 1000) : "",
      tons: tons || "",
      unit: g,
      rate,
      obs: obs(note),
    };
  }
  if (kind === "vista" || kind === "prazo") {
    const out: Record<string, string | number> = { data: dateFormula(row.data_doc), posto: up(row.posto || row.descricao), valor: valor || "", obs: obs(safeText(row.descricao || row.posto)) };
    if (kind === "prazo") out.prazo = /assinad/i.test(`${row.pagamento} ${row.descricao}`) ? "ASSINADA" : CONFIRMAR;
    return out;
  }
  if (kind === "pendencias") {
    const why = row.status === "confirmar" ? "mesmo valor de outro lançamento" : row.tipo === "outro" ? "tipo incerto" : "dado incompleto";
    return { data: dateFormula(row.data_doc), descricao: up(row.descricao) || up(row.tipo), valor: valor || "", obs: obs(`${CONFIRMAR} ${why}`) };
  }
  let label = up(row.descricao);
  if (row.tipo === "pedagio" && !/PED[AÁ]GIO/.test(label)) label = `PEDÁGIO ${label}`.trim();
  if (row.tipo === "balanca" && !/BALAN[CÇ]A/.test(label)) label = `BALANÇA ${label}`.trim();
  if (row.tipo === "pagamento" && !/PIX/.test(label)) label = `PIX — ${label}`;
  return { data: dateFormula(row.data_doc), descricao: label || CONFIRMAR, valor: valor || "", obs: obs(safeText(row.descricao)) };
}

/** Monta as escritas célula a célula; nada fora das linhas livres no fim de cada bloco. */
export function planAppend(input: {
  grid: Grid;
  tabTitle: string;
  rows: RascunhoRow[];
  pendentes?: RascunhoRow[];
  linkFor?: LinkLookup;
  today: string;
  commissionRate?: number;
}): AppendPlan {
  const { grid } = input;
  const blocks = findBlocks(grid);
  const existing = existingEntries(grid, blocks);
  const sheet = `'${input.tabTitle.replace(/'/g, "''")}'`;
  const todayBr = `${input.today.slice(8, 10)}/${input.today.slice(5, 7)}`;
  const writes: CellWrite[] = [];
  const appended: AppendPlan["appended"] = [];
  const skipped: AppendSkip[] = [];
  const used = new Set<string>();
  // próxima linha livre: depois da última linha ocupada do bloco
  const nextFree = new Map<BlockKind, number>();
  for (const b of blocks) {
    let last = b.firstRow - 1;
    for (let r = b.firstRow; r <= b.lastRow; r += 1) {
      const occupied = [...b.columns.values()].some((c) => {
        const v = cellAt(grid, r, c);
        return !isEmpty(v) && !isFormula(v);
      }) || (b.columns.has(norm(FIELDS[b.kind].obs)) && !isEmpty(cellAt(grid, r, b.columns.get(norm(FIELDS[b.kind].obs))!)));
      if (occupied) last = r;
    }
    if (!nextFree.has(b.kind)) nextFree.set(b.kind, last + 1);
  }
  const byDate = (a: RascunhoRow, b: RascunhoRow) => a.data_doc.localeCompare(b.data_doc) || a.enviado_em.localeCompare(b.enviado_em);
  const items: Array<{ row: RascunhoRow; kind: BlockKind | undefined }> = [
    ...[...input.rows].sort(byDate).map((row) => ({ row, kind: kindFor(row) })),
    ...[...(input.pendentes ?? [])].sort(byDate).map((row) => ({ row, kind: "pendencias" as BlockKind })),
  ];
  for (const { row, kind } of items) {
    const valor = asNumber(row.valor);
    const info = { tipo: row.tipo, data: row.data_doc, valor };
    const date = /^\d{4}-\d{2}-\d{2}/.test(row.data_doc) ? row.data_doc.slice(0, 10) : "";
    if (!date) {
      skipped.push({ ...info, motivo: "sem_data" });
      continue;
    }
    const block = kind ? blocks.find((b) => b.kind === kind) : undefined;
    if (!kind || !block) {
      skipped.push({ ...info, motivo: "bloco_ausente" });
      continue;
    }
    const sameDate = existing.filter((e) => e.date === date);
    // mesma data + mesmo valor em qualquer bloco = já lançado; sem valor: mesma data no mesmo bloco
    // (pendência sem valor: mesma data em qualquer bloco) = já lançado; mesma data no bloco com outro valor = conflito
    const sameBlock = sameDate.filter((e) => e.kind === kind);
    if ((valor > 0 && sameDate.some((e) => Math.abs(e.value - valor) < 0.01)) || (!valor && (kind === "pendencias" ? sameDate : sameBlock).length > 0)) {
      skipped.push({ ...info, motivo: "ja_lancado" });
      continue;
    }
    if (sameBlock.length) {
      skipped.push({ ...info, motivo: "conflito_mesma_data" });
      continue;
    }
    const fieldMap = FIELDS[kind];
    const targets = Object.entries(fieldMap)
      .map(([field, header]) => ({ field, col: block.columns.get(norm(header)) }))
      .filter((t): t is { field: string; col: number } => t.col !== undefined);
    if (!targets.some((t) => t.field === "data")) {
      skipped.push({ ...info, motivo: "bloco_ausente" });
      continue;
    }
    // linha livre: todas as células-alvo vazias (fórmulas só em colunas que não escrevemos)
    let r = nextFree.get(kind) ?? block.lastRow + 1;
    while (r <= block.lastRow && targets.some((t) => !isEmpty(cellAt(grid, r, t.col)) || used.has(`${r}:${t.col}`))) r += 1;
    if (r > block.lastRow) {
      skipped.push({ ...info, motivo: "sem_linha_livre" });
      continue;
    }
    nextFree.set(kind, r + 1);
    const obs = (text: string) => {
      const tagged = `[Hermes ${todayBr}] ${text}`.trim();
      const link = input.linkFor?.(row);
      return link ? hyperlink(link.url, `${tagged} (${link.fileLabel} — link)`) : safeText(`${tagged} — sem arquivo no Drive ${CONFIRMAR}`);
    };
    const values = rowValues(kind, row, obs, input.commissionRate ?? 0.11);
    for (const t of targets) {
      const v = values[t.field];
      if (v === undefined || v === "") continue;
      used.add(`${r}:${t.col}`);
      writes.push({ range: `${sheet}!${colLetter(t.col)}${r}`, values: [[v]] });
    }
    existing.push({ kind, date, value: valor });
    appended.push({ bloco: kind, linha: r, ...info });
  }
  assertAppendOnly(grid, input.tabTitle, writes);
  return { tabTitle: input.tabTitle, writes, appended, skipped };
}

/** Trava final: cada escrita é 1 célula da aba do motorista, vazia na grade lida, dentro de um bloco. */
export function assertAppendOnly(grid: Grid, tabTitle: string, writes: CellWrite[]): void {
  const prefix = `'${tabTitle.replace(/'/g, "''")}'!`;
  const blocks = findBlocks(grid);
  const seen = new Set<string>();
  for (const w of writes) {
    if (!w.range.startsWith(prefix)) throw new Error("append: escrita fora da aba do motorista");
    const m = /^([A-Z]{1,2})(\d+)$/.exec(w.range.slice(prefix.length));
    if (!m || w.values.length !== 1 || w.values[0]!.length !== 1) throw new Error("append: escrita não é de uma célula só");
    const col = m[1]!.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const row = Number(m[2]);
    if (!isEmpty(cellAt(grid, row, col))) throw new Error(`append: célula ${m[1]}${row} não está vazia — nada escrito`);
    if (!blocks.some((b) => row >= b.firstRow && row <= b.lastRow)) throw new Error(`append: linha ${row} fora dos blocos`);
    if (seen.has(w.range)) throw new Error("append: célula repetida");
    seen.add(w.range);
  }
}

/** API mínima: só leitura + values:batchUpdate. Não existe inserir/apagar/limpar/formatar aqui. */
export type AppendSheetsApi = {
  getMeta(id: string): Promise<{ title: string; sheets: Array<{ sheetId: number; title: string; rowCount: number; columnCount: number }> }>;
  readGrid(id: string, range: string): Promise<Grid>;
  writeValues(id: string, data: CellWrite[]): Promise<void>;
};

export function createAppendSheetsApi(token: () => Promise<string>, fetchImpl: typeof fetch = fetch): AppendSheetsApi {
  const base = "https://sheets.googleapis.com/v4/spreadsheets";
  const call = async <T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> => {
    if (method === "POST" && !/\/values:batchUpdate$/.test(url)) throw new Error("append: só values:batchUpdate é permitido");
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text();
    if (!res.ok) {
      let reason = "";
      try {
        reason = (JSON.parse(raw) as { error?: { status?: string } }).error?.status ?? "";
      } catch {
        reason = "";
      }
      throw new Error(`sheets http ${res.status}${reason ? ` ${reason}` : ""}`);
    }
    return JSON.parse(raw || "{}") as T;
  };
  return {
    async getMeta(id) {
      const r = await call<{ properties?: { title?: string }; sheets?: Array<{ properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }> }>(
        "GET",
        `${base}/${id}?fields=${encodeURIComponent("properties.title,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))")}`,
      );
      return {
        title: r.properties?.title ?? "",
        sheets: (r.sheets ?? []).map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title, rowCount: s.properties.gridProperties?.rowCount ?? 1000, columnCount: s.properties.gridProperties?.columnCount ?? 26 })),
      };
    },
    async readGrid(id, range) {
      const r = await call<{ values?: unknown[][] }>("GET", `${base}/${id}/values/${encodeURIComponent(range)}?valueRenderOption=FORMULA`);
      return (r.values ?? []).map((row) => row.map((c) => (c === null || c === undefined ? "" : String(c))));
    },
    async writeValues(id, data) {
      await call("POST", `${base}/${id}/values:batchUpdate`, { valueInputOption: "USER_ENTERED", data });
    },
  };
}

export type AppendRunResult = {
  status: "disabled" | "dry_run" | "written";
  spreadsheetId: string;
  title?: string;
  plan?: AppendPlan;
};

async function monthFiles(drive: DriveClient, rootFolderId: string, competencia: string): Promise<DriveFile[]> {
  // só leitura: acha "AAAA-MM Mês" e as subpastas; não cria nada
  const month = (await drive.listChildren(rootFolderId, { name: monthFolderName(competencia), foldersOnly: true }))[0];
  if (!month) return [];
  const files: DriveFile[] = [];
  for (const name of ["fotos", "comprovantes", "audios"]) {
    const sub = (await drive.listChildren(month.id, { name, foldersOnly: true }))[0];
    if (sub) files.push(...(await drive.listChildren(sub.id)));
  }
  return files;
}

export async function runAppendExisting(input: {
  state: AppState;
  competencia: string;
  config: ModeloConfig;
  target: AppendTarget;
  dryRun?: boolean;
  today?: string;
  drive?: DriveClient;
  sheets?: AppendSheetsApi;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<AppendRunResult> {
  const log = input.log ?? (() => undefined);
  const id = input.target.spreadsheetId;
  if (input.target.mode !== APPEND_ONLY) throw new Error("append: modo inválido");
  if (!input.config.enabled && !input.dryRun) return { status: "disabled", spreadsheetId: id };
  const today = input.today ?? new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

  let token: (() => Promise<string>) | undefined;
  if (!input.drive || !input.sheets) {
    if (!input.config.credentialsPath) throw new Error("append: GOOGLE_APPLICATION_CREDENTIALS vazio");
    let cached: { t: string; until: number } | undefined;
    token = async () => {
      if (cached && cached.until > Date.now()) return cached.t;
      const account = JSON.parse(readFileSync(input.config.credentialsPath, "utf8")) as ServiceAccountFile;
      const t = await fetchGoogleAccessToken(account, fetch, `${DRIVE_SCOPE} https://www.googleapis.com/auth/spreadsheets`);
      cached = { t, until: Date.now() + 50 * 60_000 };
      return t;
    };
  }
  const sheets = input.sheets ?? createAppendSheetsApi(token!);
  const drive = input.drive ?? createDriveClient({ token: token! });

  const meta = await sheets.getMeta(id);
  const expected = hermesCopyName(input.competencia, "");
  if (PROTECTED_TITLES.includes(meta.title.trim())) throw new Error("append: planilha protegida — nada escrito");
  if (meta.title.trim() !== expected) throw new Error(`append: planilha alvo não é a do mês (${expected}) — nada escrito`);
  const tab = meta.sheets.find((t) => t.title.trim().toUpperCase() === monitoredVehicle().driver.toUpperCase());
  if (!tab) throw new Error("append: aba do motorista não encontrada");
  const range = `'${tab.title.replace(/'/g, "''")}'!A1:${colLetter(Math.max(0, Math.min(tab.columnCount, 26) - 1))}${tab.rowCount}`;

  const { rows, pendentes } = rowsForModelo(input.state, input.competencia);
  let linkFor: LinkLookup | undefined;
  try {
    linkFor = linkLookupFromFiles(input.state, await monthFiles(drive, input.config.rootFolderId, input.competencia));
  } catch (error) {
    log("append_links_unavailable", { reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" });
  }
  const plan = planAppend({ grid: await sheets.readGrid(id, range), tabTitle: tab.title, rows, pendentes, linkFor, today });
  if (input.dryRun) return { status: "dry_run", spreadsheetId: id, title: meta.title, plan };

  // releitura imediatamente antes de escrever: se alguém preencheu algo, o plano é refeito sobre o atual
  const fresh = await sheets.readGrid(id, range);
  const finalPlan = planAppend({ grid: fresh, tabTitle: tab.title, rows, pendentes, linkFor, today });
  assertAppendOnly(fresh, tab.title, finalPlan.writes);
  if (finalPlan.writes.length) await sheets.writeValues(id, finalPlan.writes);
  log("append_written", { cells: finalPlan.writes.length, rows: finalPlan.appended.length, skipped: finalPlan.skipped.length });
  return { status: "written", spreadsheetId: id, title: meta.title, plan: finalPlan };
}
