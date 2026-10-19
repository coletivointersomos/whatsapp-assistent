import { maskJid } from "../inspect/mask.ts";
import { maskFields, maskJidsInText, MASK_MARK } from "../privacy/pii.ts";
import type { AppState, OperationalRecord, StoredMessage } from "../domain/types.ts";
import { monitoredVehicle } from "../config/monitored.ts";

export type SheetRow = {
  codigo: string;
  fluxo: string;
  record_id: string;
  data_registro: string;
  tipo: string;
  motorista: string;
  veiculo: string;
  status: string;
  origem_whatsapp: string;
  criado_em: string;
  atualizado_em: string;
  observacoes: string;
  litros: string;
  valor: string;
  posto_local: string;
  pagamento: string;
  valor_despesa: string;
  descricao_despesa: string;
  pagamento_despesa: string;
  origem: string;
  destino: string;
  material: string;
  quantidade: string;
  unidade: string;
  peso_carga: string;
  valor_movimento: string;
};

export const SHEET_COLUMNS: (keyof SheetRow)[] = [
  "codigo",
  "fluxo",
  "record_id",
  "data_registro",
  "tipo",
  "motorista",
  "veiculo",
  "status",
  "origem_whatsapp",
  "criado_em",
  "atualizado_em",
  "observacoes",
  "litros",
  "valor",
  "posto_local",
  "pagamento",
  "valor_despesa",
  "descricao_despesa",
  "pagamento_despesa",
  "origem",
  "destino",
  "material",
  "quantidade",
  "unidade",
  "peso_carga",
  "valor_movimento",
];

function cell(value: string | number | undefined): string {
  if (value === undefined || value === "") return "";
  return String(value);
}

function driverName(state: AppState, driverId: string): string {
  return state.drivers.find((d) => d.id === driverId)?.name ?? driverId;
}

function sourceMessages(state: AppState, record: OperationalRecord): StoredMessage[] {
  return record.sourceMessageIds
    .map((id) => state.messages.find((item) => item.externalId === id))
    .filter((item): item is StoredMessage => Boolean(item));
}

function messageInstant(message: StoredMessage): Date | undefined {
  for (const raw of [message.sentAt, message.processedAt]) {
    if (!raw) continue;
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

function sourceBounds(state: AppState, record: OperationalRecord): { criadoEm: string; atualizadoEm: string } {
  const instants = sourceMessages(state, record)
    .map(messageInstant)
    .filter((item): item is Date => Boolean(item))
    .sort((a, b) => a.getTime() - b.getTime());
  if (instants.length === 0) return { criadoEm: "", atualizadoEm: "" };
  return {
    criadoEm: instants[0].toISOString(),
    atualizadoEm: instants[instants.length - 1].toISOString(),
  };
}

/** Ids de mensagem; se algum parecer JID, mascara. Nunca imprime JID completo. */
export function origemWhatsapp(record: OperationalRecord): string {
  return record.sourceMessageIds
    .map((id) => (id.includes("@") ? maskJid(id) : id))
    .join(" ");
}

function emptyRow(state: AppState, record: OperationalRecord): SheetRow {
  const bounds = sourceBounds(state, record);
  return {
    codigo: "",
    fluxo: record.kind === "viagem" ? "entrada" : "saida",
    record_id: cell(record.id),
    data_registro: "",
    tipo: record.kind,
    motorista: driverName(state, record.driverId),
    veiculo: "",
    status: record.status,
    origem_whatsapp: origemWhatsapp(record),
    criado_em: bounds.criadoEm,
    atualizado_em: bounds.atualizadoEm,
    observacoes: "",
    litros: "",
    valor: "",
    posto_local: "",
    pagamento: "",
    valor_despesa: "",
    descricao_despesa: "",
    pagamento_despesa: "",
    origem: "",
    destino: "",
    material: "",
    quantidade: "",
    unidade: "",
    peso_carga: "",
    valor_movimento: "",
  };
}

export function recordToRow(state: AppState, record: OperationalRecord): SheetRow {
  const row = emptyRow(state, record);

  if (record.kind === "abastecimento" && record.abastecimento) {
    const f = record.abastecimento;
    row.data_registro = cell(f.date);
    row.veiculo = cell(f.vehicle);
    row.litros = cell(f.liters);
    row.valor = cell(f.totalBrl);
    row.valor_movimento = cell(f.totalBrl);
    row.posto_local = cell(f.place);
    row.pagamento = cell(f.payment);
    row.observacoes = cell(f.note);
  } else if (record.kind === "despesa" && record.despesa) {
    const f = record.despesa;
    row.data_registro = cell(f.date);
    row.veiculo = cell(f.vehicle);
    row.valor_despesa = cell(f.amountBrl);
    row.valor_movimento = cell(f.amountBrl);
    row.descricao_despesa = cell(f.description);
    row.pagamento_despesa = cell(f.payment);
    row.observacoes = cell(f.note);
  } else if (record.kind === "viagem" && record.viagem) {
    const f = record.viagem;
    row.data_registro = cell(f.date);
    row.veiculo = cell(f.vehicle);
    row.origem = cell(f.origin);
    row.destino = cell(f.destination);
    row.material = cell(f.material);
    row.quantidade = cell(f.quantity);
    row.unidade = cell(f.unit);
    row.peso_carga = cell(f.quantity);
    row.valor_movimento = cell(f.freightTotal);
    row.observacoes = cell(f.note);
  }

  return maskSheetRowPii(row);
}

/** Colunas de texto livre do SheetRow que passam pela máscara de PII. */
const SHEET_ROW_TEXT: (keyof SheetRow)[] = [
  "observacoes",
  "posto_local",
  "pagamento",
  "descricao_despesa",
  "pagamento_despesa",
  "origem",
  "destino",
  "material",
];

/** PII fora da planilha: texto livre mascarado; record_id só com JID mascarado (continua único). */
export function maskSheetRowPii(row: SheetRow): SheetRow {
  const masked = maskFields(row, SHEET_ROW_TEXT);
  const recordId = maskJidsInText(masked.record_id);
  return recordId === masked.record_id ? masked : { ...masked, record_id: recordId };
}

export function recordsToRows(state: AppState): SheetRow[] {
  return assignSheetCodes(state.records.map((r) => recordToRow(state, r)));
}

const CODE_PREFIX: Record<string, string> = {
  viagem: "VIAGEM",
  despesa: "DESP",
  abastecimento: "ABAST",
};

export function assignSheetCodes(rows: SheetRow[]): SheetRow[] {
  const counts: Record<string, number> = { viagem: 0, despesa: 0, abastecimento: 0 };
  return rows.map((row) => {
    const tipo = row.tipo || "viagem";
    counts[tipo] = (counts[tipo] ?? 0) + 1;
    const prefix = CODE_PREFIX[tipo] ?? "REG";
    return { ...row, codigo: `${prefix}${String(counts[tipo]).padStart(3, "0")}` };
  });
}

export function compactPlaca(raw?: string): string {
  return (raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function oneCharSlip(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
  return diff === 1;
}

/** OCR do papel: alias conhecido (padrão TFA7A54) ≈ placa acompanhada; com dica da placa, 1 caractere trocado também. */
export function normalizePlaca(raw?: string, hint?: string): string {
  const compact = compactPlaca(raw);
  const hintC = compactPlaca(hint);
  const isPlate = /^[A-Z]{3}\d[A-Z0-9]{3}$/.test(compact);
  const monitored = monitoredVehicle();
  if (isPlate && (monitored.ocrAliases.includes(compact) || (hintC === monitored.plate && oneCharSlip(compact, monitored.plate)))) {
    return monitored.plate;
  }
  if (isPlate) return compact;
  return hintC && /^[A-Z]{3}\d[A-Z0-9]{3}$/.test(hintC) ? hintC : compact;
}

export function vehicleMonthTab(vehicle: string | undefined, dateIso: string | undefined, now = new Date()): string {
  const month = dateIso && /^\d{4}-\d{2}/.test(dateIso) ? dateIso.slice(0, 7) : now.toISOString().slice(0, 7);
  const plate = normalizePlaca(vehicle);
  const source = /^[A-Z]{3}\d/.test(plate) ? plate : vehicle || "Caminhao";
  let slug =
    (source || "Caminhao")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join("")
      .slice(0, 24) || "Caminhao";
  if (/^[A-Za-z]{3}\d/.test(slug)) slug = slug.toUpperCase();
  return `${slug}-${month}`;
}

export function viagensTabName(vehicle: string | undefined, dateIso: string | undefined, now = new Date()): string {
  return `Viagens-${vehicleMonthTab(vehicle, dateIso, now)}`;
}

export function caixaTabName(vehicle: string | undefined, dateIso: string | undefined, now = new Date()): string {
  return `Caixa-${vehicleMonthTab(vehicle, dateIso, now)}`;
}

export function resumoTabName(vehicle: string | undefined, dateIso: string | undefined, now = new Date()): string {
  return `Resumo-${vehicleMonthTab(vehicle, dateIso, now)}`;
}

export type ControleRow = {
  codigo: string;
  fluxo: string;
  data: string;
  origem: string;
  destino: string;
  material: string;
  toneladas: string;
  valor: string;
  observacao: string;
  recebido: string;
  motorista: string;
  placa: string;
  mes: string;
};

export const CONTROLE_COLUMNS: (keyof ControleRow)[] = [
  "codigo",
  "fluxo",
  "data",
  "origem",
  "destino",
  "material",
  "toneladas",
  "valor",
  "observacao",
  "recebido",
  "motorista",
  "placa",
  "mes",
];

export function asToneladas(value: string | number | undefined): string {
  if (value === undefined || value === "") return "";
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(n) || n === 0) return String(value);
  const tons = n >= 1000 ? n / 1000 : n;
  return String(Math.round(tons * 1000) / 1000);
}

/** Observação do papel (ex. 5.724 RECEBI) → reais. Não pega 47.7 (toneladas). */
/** 896 SACOS A 4.00 → 896 × 4 = 3584. */
export function parseSacosFreight(text: unknown): { sacos: number; unitPrice: number; total: number } | undefined {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  const match =
    s.match(/(\d{2,5})\s*(?:sacos?|sc)\s*(?:a|à|por|x|×|=)?\s*(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/i) ??
    s.match(/(\d{2,5})\s*sacos?.*?(\d+(?:[.,]\d{1,2})?)\s*(?:reais?|r\$)/i);
  if (!match) return undefined;
  const sacos = Number(match[1]);
  const unitPrice = Number(String(match[2]).replace(",", "."));
  if (!Number.isFinite(sacos) || !Number.isFinite(unitPrice) || sacos <= 0 || unitPrice <= 0) return undefined;
  return { sacos, unitPrice, total: Math.round(sacos * unitPrice * 100) / 100 };
}

export function formatSacosConta(note: string): { valor: number; observacao: string } | undefined {
  const sack = parseSacosFreight(note);
  if (!sack) return undefined;
  const paper = parseBrl(note);
  const conta = `${sack.sacos} sacos × R$ ${sack.unitPrice} = ${sack.total}`;
  const extra = paper !== undefined && paper !== sack.total ? ` (papel ${paper})` : "";
  return { valor: sack.total, observacao: `${conta}${extra}` };
}

/** Pedaços já mascarados (…1234, ***.***.***-12) nunca são dinheiro. */
const MASKED_TOKEN = new RegExp(String.raw`${MASK_MARK}[^\s,;]*|\*{3}\.\*{3}\.\*{3}-[\d*]{2}`, "g");

export function parseBrl(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === undefined || value === null) return undefined;
  const s = String(value)
    .replace(MASKED_TOKEN, " ")
    .replace(/r\$/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = s.match(/(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{2}|\d{4,})/);
  if (!match) return undefined;
  let token = match[1];
  token = /\.\d{3}/.test(token) ? token.replace(/\./g, "").replace(",", ".") : token.replace(",", ".");
  const n = Number(token);
  return Number.isFinite(n) ? n : undefined;
}

export function recebidoFlag(note?: string, receipt?: string, freightTotal?: number): string {
  const raw = `${note ?? ""} ${receipt ?? ""}`;
  if (/passei/i.test(raw)) return "NÃO";
  if (/recebi/i.test(raw)) return "SIM";
  if (freightTotal && freightTotal > 0) return "SIM";
  if (parseBrl(note) !== undefined) return "SIM";
  return "";
}

export function recordFluxo(record: OperationalRecord): "entrada" | "saida" {
  return record.kind === "viagem" ? "entrada" : "saida";
}

export function recordToControleRow(state: AppState, record: OperationalRecord): ControleRow {
  const mapped = recordToRow(state, record);
  const date = mapped.data_registro;
  const fluxo = recordFluxo(record);
  return {
    codigo: "",
    fluxo,
    data: date,
    origem: mapped.origem,
    destino: mapped.destino,
    material: mapped.material,
    toneladas: fluxo === "entrada" ? asToneladas(mapped.quantidade || mapped.peso_carga) : "",
    valor: (() => {
      const conta = formatSacosConta(mapped.observacoes);
      if (conta) return String(conta.valor);
      if (mapped.valor_movimento) return mapped.valor_movimento;
      const paper = parseBrl(mapped.observacoes);
      return paper !== undefined ? String(paper) : "";
    })(),
    observacao: formatSacosConta(mapped.observacoes)?.observacao || mapped.observacoes || mapped.descricao_despesa || mapped.posto_local,
    recebido:
      record.kind === "viagem"
        ? recebidoFlag(record.viagem?.note, record.viagem?.receipt, record.viagem?.freightTotal)
        : "",
    motorista: record.viagem?.motorista?.trim() || (normalizePlaca(mapped.veiculo) === monitoredVehicle().plate ? monitoredVehicle().driver : mapped.motorista),
    placa: normalizePlaca(mapped.veiculo) || mapped.veiculo,
    mes: date.slice(0, 7),
  };
}

export function assignControleCodes(rows: ControleRow[]): ControleRow[] {
  const counts: Record<string, number> = { entrada: 0, saida: 0 };
  return rows.map((row) => {
    const fluxo = row.fluxo === "saida" ? "saida" : "entrada";
    counts[fluxo] += 1;
    const prefix = fluxo === "saida" ? "SAIDA" : "VIAGEM";
    return { ...row, codigo: `${prefix}${String(counts[fluxo]).padStart(3, "0")}` };
  });
}

export function controleToValues(rows: ControleRow[]): Array<Array<string | number>> {
  const header: Array<string | number> = [...CONTROLE_COLUMNS];
  const body = rows.map((row) =>
    CONTROLE_COLUMNS.map((col) => {
      const raw = row[col] ?? "";
      if ((col === "toneladas" || col === "valor") && raw !== "") {
        const n = Number(String(raw).replace(",", "."));
        if (Number.isFinite(n)) return n;
      }
      return raw;
    }),
  );
  return [header, ...body];
}

function quotedTab(tabName: string): string {
  return `'${tabName.replace(/'/g, "''")}'`;
}

/** Aba-resumo: KPIs à esquerda; QUERY de destino/material em colunas D e F para não se sobrepor. */
export function resumoGrid(caixaTab: string): string[][] {
  const t = quotedTab(caixaTab);
  const destino = `=QUERY(${t}!A:M;"select E, sum(G) where E <> '' group by E label E 'destino', sum(G) 'toneladas'";1)`;
  const material = `=QUERY(${t}!A:M;"select F, sum(G) where F <> '' group by F label F 'material', sum(G) 'toneladas'";1)`;
  return [
    ["pergunta", "resposta", "", "por destino", "", "por material"],
    ["entradas (verde)", `=COUNTIF(${t}!B2:B;"entrada")`, "", destino, "", material],
    ["saídas (vermelho)", `=COUNTIF(${t}!B2:B;"saida")`],
    ["total toneladas", `=SUM(${t}!G2:G)`],
    ["total recebido (R$)", `=SUM(${t}!H2:H)`],
    ["RECEBI", `=COUNTIF(${t}!J2:J;"SIM")`],
  ];
}

/**
 * Mês da aba = data do FATO (campo date do registro). Sem data no registro: data de envio da
 * mensagem de origem (factFallbackIso). Só sem nenhuma das duas cai no relógio.
 */
export function tabForRecord(record: OperationalRecord, now = new Date(), factFallbackIso?: string): string {
  const body = record.viagem ?? record.despesa ?? record.abastecimento;
  const factDate = body?.date && /^\d{4}-\d{2}/.test(body.date) ? body.date : factFallbackIso;
  return caixaTabName(normalizePlaca(body?.vehicle) || body?.vehicle, factDate, now);
}

/** Data (AAAA-MM-DD, horário de Brasília, UTC-3) de envio da 1ª mensagem de origem — fallback do mês do fato. */
export function sourceSentAt(state: AppState, record: OperationalRecord): string | undefined {
  for (const id of record.sourceMessageIds) {
    const found = state.messages.find((item) => item.externalId === id);
    const ms = found?.sentAt ? Date.parse(found.sentAt) : NaN;
    if (Number.isFinite(ms)) return new Date(ms - 3 * 3600_000).toISOString().slice(0, 10);
  }
  return undefined;
}

/** Sem `record_id` o registro não entra no sync. */
export function isSyncEligible(row: Pick<SheetRow, "record_id"> | OperationalRecord): boolean {
  const id = "record_id" in row ? row.record_id : row.id;
  return Boolean(id?.trim());
}
