import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AppState, StoredMessage } from "../domain/types.ts";
import { brtParts, buildArchiveItems, monthFolderName } from "../drive/archive.ts";
import type { DriveClient, DriveFile } from "../drive/googleDrive.ts";
import { PROTECTED_TITLES, type AppendSheetsApi, type Grid } from "./appendExisting.ts";
import { hyperlink, safeText, type CellWrite } from "./modelo.ts";

/**
 * Aba EXISTENTE "Conversa WhatsApp" da planilha do mês: uma linha por mensagem do grupo, mesmas
 * colunas das linhas manuais. Atrás de CONVERSA_SHEET_ENABLED=false.
 *   CONVERSA_SHEET_ENABLED=true
 *   CONVERSA_SINCE=2026-10-19T12:11:44Z        (só mensagens enviadas DEPOIS; padrão = última linha manual, 09:11:44 BRT)
 *   CONVERSA_REMETENTES=<jid>=Manoel;<jid>=…   (opcional; sem mapa → pushName → nome do contato → [A CONFIRMAR])
 *   CONVERSA_REGISTRY_PATH=/data/conversa-sheet.json  (ids já escritos + links pendentes)
 * Regras: nunca cria aba; nunca altera/apaga linha; escreve só em células vazias a partir da primeira
 * linha vazia depois da última ocupada (relida antes); sem values:append; sem inserir linha.
 * Conteúdo vai como veio (sem máscara); só safeText contra fórmula.
 * Links (F/H): preenchidos quando o arquivo já está no Drive; senão ficam pendentes e um passo
 * seguinte escreve SÓ se a célula ainda estiver vazia e a linha ainda for a mesma mensagem.
 */
export const CONVERSA_TAB = "Conversa WhatsApp";
export const DEFAULT_SINCE = "2026-10-19T12:11:44Z";
const HEADERS = ["DATA", "HORA", "REMETENTE", "TIPO", "CONTEÚDO DA MENSAGEM", "ARQUIVO NO DRIVE (LINK)", "TRANSCRIÇÃO / OBSERVAÇÃO", "TRANSCRIÇÃO NO DRIVE (LINK)"];
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export type ConversaConfig = { enabled: boolean; since: string; names: Map<string, string>; registryPath: string; chatIds: string[] };

export function loadConversaConfig(env: Record<string, string | undefined> = process.env): ConversaConfig {
  const names = new Map<string, string>();
  for (const pair of (env.CONVERSA_REMETENTES ?? "").split(";")) {
    const i = pair.indexOf("=");
    if (i > 0) names.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return {
    enabled: env.CONVERSA_SHEET_ENABLED === "true",
    since: env.CONVERSA_SINCE?.trim() || DEFAULT_SINCE,
    names,
    registryPath: env.CONVERSA_REGISTRY_PATH?.trim() || "/data/conversa-sheet.json",
    chatIds: (env.MODELO_AUTO_FILL_CHAT_IDS ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
  };
}

type Raw = { data?: { body?: unknown; caption?: unknown; media?: { mimetype?: unknown; filename?: unknown }; contact?: { pushName?: unknown; name?: unknown; shortName?: unknown }; notifyName?: unknown; pushname?: unknown } };
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function senderName(m: StoredMessage, names: Map<string, string>): string {
  for (const id of [m.participantId, m.authorId]) if (id && names.has(id)) return names.get(id)!;
  const d = (m.raw as Raw | undefined)?.data;
  return str(d?.contact?.pushName) || str(d?.notifyName) || str(d?.pushname) || str(d?.contact?.name) || str(d?.contact?.shortName) || "[A CONFIRMAR]";
}

export function mediaOf(m: StoredMessage): { kind: "TEXTO" | "FOTO" | "PDF" | "ÁUDIO"; mime: string; filename: string } {
  const d = (m.raw as Raw | undefined)?.data;
  const mime = str(d?.media?.mimetype).toLowerCase();
  const filename = str(d?.media?.filename);
  if (m.type === "audio_info" || mime.startsWith("audio/")) return { kind: "ÁUDIO", mime: mime || "audio/ogg", filename };
  if (mime === "application/pdf") return { kind: "PDF", mime, filename };
  if (m.type === "anexo_comprovante" || mime.startsWith("image/")) return { kind: "FOTO", mime: mime || "image/jpeg", filename };
  return { kind: "TEXTO", mime: "", filename: "" };
}

/** Nomes/pastas esperados no Drive para a mensagem (mesma regra do arquivo 2d). */
export function expectedFiles(m: StoredMessage, transcript?: string): { main?: { folder: string; name: string }; transcript?: { folder: string; name: string } } {
  const { kind, mime, filename } = mediaOf(m);
  if (kind === "TEXTO") return {};
  const tiny = { mime, base64: "AA==" };
  const items = buildArchiveItems({
    externalId: m.externalId,
    sentAt: m.sentAt,
    photo: kind === "FOTO" ? tiny : undefined,
    pdf: kind === "PDF" ? tiny : undefined,
    audio: kind === "ÁUDIO" ? tiny : undefined,
    transcript: kind === "ÁUDIO" ? transcript || "x" : undefined,
    originalName: filename || undefined,
  });
  const main = items.find((i) => i.folder === "fotos" || i.folder === "comprovantes" || i.folder === "audios");
  const tr = items.find((i) => i.folder === "transcricoes");
  return { main: main && { folder: main.folder, name: main.name }, transcript: tr && { folder: tr.folder, name: tr.name } };
}

function observation(state: AppState, m: StoredMessage, kind: string): string {
  if (kind === "ÁUDIO") return m.text?.trim() ? `TRANSCRIÇÃO AUTOMÁTICA (pode conter erros): ${m.text.trim()}` : "";
  const recs = state.records.filter((r) => r.sourceMessageIds.includes(m.externalId));
  const parts = recs.map((r) => {
    const f = (r.abastecimento ?? r.despesa ?? r.viagem ?? {}) as Record<string, unknown>;
    const desc = [f.description, f.place, f.note].filter((x) => typeof x === "string" && x).join(" — ");
    const val = typeof f.totalBrl === "number" ? f.totalBrl : typeof f.amountBrl === "number" ? f.amountBrl : undefined;
    return `${r.kind}${desc ? `: ${desc}` : ""}${val !== undefined ? ` | valor R$ ${val.toFixed(2)}` : ""}`;
  });
  return parts.join(" || ");
}

export type ConversaRow = { externalId: string; date: string; time: string; values: Array<string>; want: { F?: { folder: string; name: string }; H?: { folder: string; name: string } } };

export function buildConversaRow(state: AppState, m: StoredMessage, names: Map<string, string>): ConversaRow {
  const { date, time } = brtParts(m.sentAt);
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm, ss] = [time.slice(0, 2), time.slice(2, 4), time.slice(4, 6)].map(Number);
  const { kind, filename } = mediaOf(m);
  const raw = (m.raw as Raw | undefined)?.data;
  const content = kind === "TEXTO" ? m.text ?? str(raw?.body) : kind === "PDF" ? filename || str(raw?.caption) : kind === "FOTO" ? str(raw?.caption) : "";
  const files = expectedFiles(m, kind === "ÁUDIO" ? m.text : undefined);
  return {
    externalId: m.externalId,
    date,
    time,
    values: [`=DATE(${y},${mo},${d})`, `=TIME(${hh},${mm},${ss})`, safeText(senderName(m, names)), kind, safeText(content), "", safeText(observation(state, m, kind)), ""],
    want: { F: files.main, H: files.transcript },
  };
}

/** Data/hora de célula: =DATE()/=TIME(), serial ou texto. */
export function cellKey(a: string, b: string): string | undefined {
  const da = /^=\s*DATE\((\d{4}),(\d{1,2}),(\d{1,2})\)$/i.exec(a.replace(/\s/g, "")) ?? undefined;
  let date: string | undefined;
  if (da) date = `${da[1]}-${da[2]!.padStart(2, "0")}-${da[3]!.padStart(2, "0")}`;
  else if (/^\d{5}(\.\d+)?$/.test(a.trim())) date = new Date(Math.round((Math.floor(Number(a)) - 25569) * 86400000)).toISOString().slice(0, 10);
  else {
    const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(a.trim());
    if (br) date = `${br[3]}-${br[2]!.padStart(2, "0")}-${br[1]!.padStart(2, "0")}`;
  }
  const tb = /^=\s*TIME\((\d{1,2}),(\d{1,2}),(\d{1,2})\)$/i.exec(b.replace(/\s/g, ""));
  let time: string | undefined;
  if (tb) time = [tb[1], tb[2], tb[3]].map((x) => x!.padStart(2, "0")).join("");
  else if (/^0?\.\d+$/.test(b.trim())) {
    const s = Math.round(Number(b) * 86400);
    time = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, "0")).join("");
  } else {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(b.trim());
    if (t) time = [t[1], t[2], t[3] ?? "00"].map((x) => x!.padStart(2, "0")).join("");
  }
  return date && time ? `${date}|${time}` : undefined;
}

const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim().toUpperCase();
const cell = (g: Grid, r: number, c: number) => String(g[r - 1]?.[c] ?? "");
const COLS = "ABCDEFGH";

export type Registry = { [spreadsheetId: string]: { [externalId: string]: { row: number; key: string; pendingF?: { folder: string; name: string }; pendingH?: { folder: string; name: string } } } };

export function readRegistry(path: string): Registry {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Registry;
  } catch {
    return {};
  }
}

function writeRegistry(path: string, reg: Registry): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg), { mode: 0o600 });
  renameSync(tmp, path);
}

export function competenciaFromTitle(title: string): string | undefined {
  const m = /-\s*([\p{L}ç]+)\s+(\d{4})\s*$/u.exec(title.trim());
  const idx = m ? MESES.indexOf(m[1]!.toLowerCase()) : -1;
  return idx >= 0 ? `${m![2]}-${String(idx + 1).padStart(2, "0")}` : undefined;
}

export type ConversaPlan = { tab: string; gid: number; writes: CellWrite[]; rows: Array<{ linha: number; externalId: string; valores: string[] }>; links: Array<{ celula: string; arquivo: string }>; skipped: Array<{ motivo: string; quando: string }>; firstFreeRow: number };

type FileIndex = Map<string, DriveFile>; // "<folder>/<name>" → arquivo

export function planConversa(input: {
  state: AppState;
  grid: Grid;
  tab: { title: string; sheetId: number; rowCount: number };
  competencia: string;
  config: ConversaConfig;
  registry: Registry[string];
  files?: FileIndex;
}): ConversaPlan {
  const { grid, config } = input;
  const header = (grid[0] ?? []).map(norm);
  HEADERS.forEach((h, i) => {
    if (header[i] !== norm(h)) throw new Error(`conversa: cabeçalho ${COLS[i]}1 diferente do esperado ("${h}") — nada escrito`);
  });
  const sheet = `'${input.tab.title.replace(/'/g, "''")}'`;
  let last = 1;
  grid.forEach((row, i) => {
    if (row.some((c) => String(c ?? "").trim() !== "")) last = i + 1;
  });
  const existingKeys = new Set<string>();
  for (let r = 2; r <= last; r += 1) {
    const k = cellKey(cell(grid, r, 0), cell(grid, r, 1));
    if (k) existingKeys.add(`${k}|${norm(cell(grid, r, 2))}|${norm(cell(grid, r, 3))}`);
  }
  const sinceMs = Date.parse(config.since);
  const msgs = input.state.messages
    .filter((m) => config.chatIds.includes(m.conversationId) && m.authorRole !== "bot" && Date.parse(m.sentAt) > sinceMs && brtParts(m.sentAt).date.slice(0, 7) === input.competencia)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.externalId.localeCompare(b.externalId));
  const writes: CellWrite[] = [];
  const rows: ConversaPlan["rows"] = [];
  const links: ConversaPlan["links"] = [];
  const skipped: ConversaPlan["skipped"] = [];
  const link = (want: { folder: string; name: string } | undefined) => (want ? input.files?.get(`${want.folder}/${want.name}`) : undefined);
  let next = last + 1;
  for (const m of msgs) {
    if (input.registry[m.externalId]) continue;
    const row = buildConversaRow(input.state, m, config.names);
    const key = `${row.date}|${row.time}|${norm(row.values[2])}|${norm(row.values[3])}`;
    if (existingKeys.has(key)) {
      skipped.push({ motivo: "ja_na_aba", quando: `${row.date} ${row.time}` });
      continue;
    }
    if (next > input.tab.rowCount) {
      skipped.push({ motivo: "sem_linha_livre (não insere linha)", quando: `${row.date} ${row.time}` });
      continue;
    }
    const f = link(row.want.F);
    const h = link(row.want.H);
    if (f) row.values[5] = hyperlink(f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, f.name);
    if (h) row.values[7] = hyperlink(h.webViewLink || `https://drive.google.com/file/d/${h.id}/view`, h.name);
    row.values.forEach((v, c) => {
      if (v !== "") writes.push({ range: `${sheet}!${COLS[c]}${next}`, values: [[v]] });
    });
    existingKeys.add(key);
    rows.push({ linha: next, externalId: m.externalId, valores: row.values });
    input.registry[m.externalId] = { row: next, key, pendingF: f ? undefined : row.want.F, pendingH: h ? undefined : row.want.H };
    next += 1;
  }
  // 2º passo: links pendentes, só em célula vazia e se a linha ainda é a mesma mensagem
  for (const [id, entry] of Object.entries(input.registry)) {
    if (rows.some((r) => r.externalId === id)) continue;
    for (const [col, want] of [["F", entry.pendingF], ["H", entry.pendingH]] as const) {
      if (!want) continue;
      const file = link(want);
      if (!file) continue;
      const c = COLS.indexOf(col);
      const same = (() => {
        const k = cellKey(cell(grid, entry.row, 0), cell(grid, entry.row, 1));
        return k && `${k}|${norm(cell(grid, entry.row, 2))}|${norm(cell(grid, entry.row, 3))}` === entry.key;
      })();
      if (!same || cell(grid, entry.row, c).trim() !== "") {
        if (col === "F") entry.pendingF = undefined;
        else entry.pendingH = undefined;
        continue;
      }
      writes.push({ range: `${sheet}!${col}${entry.row}`, values: [[hyperlink(file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`, file.name)]] });
      links.push({ celula: `${col}${entry.row}`, arquivo: file.name });
      if (col === "F") entry.pendingF = undefined;
      else entry.pendingH = undefined;
    }
  }
  assertConversaAppendOnly(grid, input.tab.title, writes);
  return { tab: input.tab.title, gid: input.tab.sheetId, writes, rows, links, skipped, firstFreeRow: last + 1 };
}

export function assertConversaAppendOnly(grid: Grid, tabTitle: string, writes: CellWrite[]): void {
  const prefix = `'${tabTitle.replace(/'/g, "''")}'!`;
  const seen = new Set<string>();
  for (const w of writes) {
    if (!w.range.startsWith(prefix)) throw new Error("conversa: escrita fora da aba Conversa WhatsApp");
    const m = /^([A-H])(\d+)$/.exec(w.range.slice(prefix.length));
    if (!m || w.values.length !== 1 || w.values[0]!.length !== 1) throw new Error("conversa: escrita não é de uma célula A–H");
    const row = Number(m[2]);
    if (row < 2) throw new Error("conversa: cabeçalho nunca é escrito");
    if (cell(grid, row, COLS.indexOf(m[1]!)).trim() !== "") throw new Error(`conversa: ${m[1]}${row} não está vazia — nada escrito`);
    if (seen.has(w.range)) throw new Error("conversa: célula repetida");
    seen.add(w.range);
  }
}

async function indexMonthFiles(drive: DriveClient, rootFolderId: string, competencia: string): Promise<FileIndex> {
  const idx: FileIndex = new Map();
  const month = (await drive.listChildren(rootFolderId, { name: monthFolderName(competencia), foldersOnly: true }))[0];
  if (!month) return idx;
  for (const folder of ["fotos", "comprovantes", "audios", "transcricoes"]) {
    const sub = (await drive.listChildren(month.id, { name: folder, foldersOnly: true }))[0];
    if (!sub) continue;
    for (const f of await drive.listChildren(sub.id)) if (!idx.has(`${folder}/${f.name}`)) idx.set(`${folder}/${f.name}`, f);
  }
  return idx;
}

export async function runConversaFill(input: {
  state: AppState;
  spreadsheetId: string;
  config: ConversaConfig;
  sheets: AppendSheetsApi;
  drive?: DriveClient;
  rootFolderId: string;
  dryRun?: boolean;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<{ status: "disabled" | "dry_run" | "written"; plan?: ConversaPlan; title?: string }> {
  const log = input.log ?? (() => undefined);
  if (!input.config.enabled && !input.dryRun) return { status: "disabled" };
  const meta = await input.sheets.getMeta(input.spreadsheetId);
  if (PROTECTED_TITLES.includes(meta.title.trim())) throw new Error("conversa: planilha protegida — nada escrito");
  const competencia = competenciaFromTitle(meta.title);
  if (!competencia || meta.title.trim().endsWith(")")) throw new Error("conversa: título da planilha não é de mês — nada escrito");
  const tab = meta.sheets.find((t) => t.title.trim() === CONVERSA_TAB);
  if (!tab) throw new Error("conversa: aba 'Conversa WhatsApp' não existe — nada criado");
  const range = `'${tab.title.replace(/'/g, "''")}'!A1:H${tab.rowCount}`;
  let files: FileIndex | undefined;
  if (input.drive) {
    try {
      files = await indexMonthFiles(input.drive, input.rootFolderId, competencia);
    } catch (error) {
      log("conversa_links_unavailable", { reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" });
    }
  }
  const registryAll = readRegistry(input.config.registryPath);
  const reg = structuredClone(registryAll[input.spreadsheetId] ?? {});
  const grid = await input.sheets.readGrid(input.spreadsheetId, range);
  const plan = planConversa({ state: input.state, grid, tab, competencia, config: input.config, registry: reg, files });
  if (input.dryRun) return { status: "dry_run", plan, title: meta.title };
  // releitura imediatamente antes de escrever
  const fresh = await input.sheets.readGrid(input.spreadsheetId, range);
  const reg2 = structuredClone(registryAll[input.spreadsheetId] ?? {});
  const finalPlan = planConversa({ state: input.state, grid: fresh, tab, competencia, config: input.config, registry: reg2, files });
  if (finalPlan.writes.length) await input.sheets.writeValues(input.spreadsheetId, finalPlan.writes);
  registryAll[input.spreadsheetId] = reg2;
  writeRegistry(input.config.registryPath, registryAll);
  log("conversa_written", { rows: finalPlan.rows.length, links: finalPlan.links.length, cells: finalPlan.writes.length, skipped: finalPlan.skipped.length });
  return { status: "written", plan: finalPlan, title: meta.title };
}
