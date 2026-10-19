import { looksOperationalV2 } from "../assistant-v2/fallback.ts";
import { recordInCurrentSession, parseSessionStart } from "../assistant-v2/session.ts";
import type { AppState, OperationalRecord, StoredMessage } from "../domain/types.ts";
import {
  formatSacosConta,
  isSyncEligible,
  normalizePlaca,
  parseBrl,
  recordToRow,
} from "./mapper.ts";

export type RascunhoTipo =
  | "viagem"
  | "abastecimento_vista"
  | "abastecimento_prazo"
  | "despesa"
  | "deposito"
  | "outro";

export type RascunhoStatus = "novo" | "incompleto" | "promovido" | "ignorado" | "duplicado";

export type RascunhoRow = {
  message_id: string;
  enviado_em: string;
  data_doc: string;
  competencia: string;
  tipo: RascunhoTipo;
  motorista: string;
  placa: string;
  origem: string;
  destino: string;
  material: string;
  toneladas: string;
  valor_unitario: string;
  valor: string;
  posto: string;
  descricao: string;
  pagamento: string;
  source: string;
  status: RascunhoStatus;
  record_id: string;
  fingerprint: string;
  campos_brutos: string;
  arquivo_origem: string;
};

export const RASCUNHO_COLUMNS: (keyof RascunhoRow)[] = [
  "message_id",
  "enviado_em",
  "data_doc",
  "competencia",
  "tipo",
  "motorista",
  "placa",
  "origem",
  "destino",
  "material",
  "toneladas",
  "valor_unitario",
  "valor",
  "posto",
  "descricao",
  "pagamento",
  "source",
  "status",
  "record_id",
  "fingerprint",
  "campos_brutos",
  "arquivo_origem",
];

export function rascunhoKey(row: Pick<RascunhoRow, "record_id" | "message_id">): string {
  return (row.record_id || row.message_id).trim();
}

export function rascunhoToValues(rows: RascunhoRow[]): Array<Array<string | number>> {
  const header: Array<string | number> = [...RASCUNHO_COLUMNS];
  const body = rows.map((row) => RASCUNHO_COLUMNS.map((col) => row[col] ?? ""));
  return [header, ...body];
}

export function parseRascunhoGrid(values: string[][]): RascunhoRow[] {
  if (values.length === 0) return [];
  const header = values[0] ?? [];
  const index = new Map(header.map((name, i) => [name, i]));
  const col = (row: string[], name: keyof RascunhoRow) => row[index.get(name) ?? -1] ?? "";
  return values.slice(1).map((row) => {
    const parsed: RascunhoRow = {
      message_id: col(row, "message_id"),
      enviado_em: col(row, "enviado_em"),
      data_doc: col(row, "data_doc"),
      competencia: col(row, "competencia"),
      tipo: (col(row, "tipo") || "outro") as RascunhoTipo,
      motorista: col(row, "motorista"),
      placa: col(row, "placa"),
      origem: col(row, "origem"),
      destino: col(row, "destino"),
      material: col(row, "material"),
      toneladas: col(row, "toneladas"),
      valor_unitario: col(row, "valor_unitario"),
      valor: col(row, "valor"),
      posto: col(row, "posto"),
      descricao: col(row, "descricao"),
      pagamento: col(row, "pagamento"),
      source: col(row, "source"),
      status: (col(row, "status") || "novo") as RascunhoStatus,
      record_id: col(row, "record_id"),
      fingerprint: col(row, "fingerprint"),
      campos_brutos: col(row, "campos_brutos"),
      arquivo_origem: col(row, "arquivo_origem"),
    };
    if (!parsed.fingerprint) parsed.fingerprint = rascunhoFingerprint(parsed);
    return parsed;
  }).filter((row) => rascunhoKey(row));
}

function isoDate(value?: string): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

export function competenciaFromDoc(dataDoc: string, enviadoEm?: string): string {
  const doc = isoDate(dataDoc);
  if (/^\d{4}-\d{2}/.test(doc)) return doc.slice(0, 7);
  const sent = isoDate(enviadoEm);
  if (/^\d{4}-\d{2}/.test(sent)) return sent.slice(0, 7);
  return "";
}

export function rascunhoFingerprint(row: Pick<RascunhoRow, "competencia" | "tipo" | "data_doc" | "origem" | "destino" | "posto" | "valor" | "descricao" | "placa">): string {
  const norm = (value: string) =>
    value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const money = String(row.valor ?? "").replace(/[^\d]/g, "");
  return [
    norm(row.competencia),
    norm(row.tipo),
    norm(row.data_doc),
    norm(row.origem),
    norm(row.destino),
    norm(row.posto),
    money,
    normalizePlaca(row.placa),
  ].join("|");
}

function arquivoOrigem(message?: StoredMessage): string {
  const id = message?.externalId?.trim() || "";
  const ref = message?.attachmentRef?.trim() || message?.media?.mime || "";
  return [id, ref].filter(Boolean).join(" | ");
}

function messageSource(message?: StoredMessage): string {
  if (!message) return "texto";
  if (message.type === "anexo_comprovante" || message.media || message.attachmentRef) return "foto";
  if (message.type === "audio_info") return "audio";
  return "texto";
}

function motoristaOf(state: AppState, record: OperationalRecord, placa: string): string {
  const named = record.viagem?.motorista?.trim();
  if (named && !/^jo[aã]o$/i.test(named)) return named;
  if (placa === "TFA7A94") return "Manoel";
  return state.drivers.find((d) => d.id === record.driverId)?.name ?? record.driverId;
}

function abastecimentoTipo(payment?: string): RascunhoTipo {
  return /prazo|fiado|assinada|a prazo/i.test(payment ?? "") ? "abastecimento_prazo" : "abastecimento_vista";
}

function despesaTipo(description?: string, note?: string): RascunhoTipo {
  return /dep[oó]sit/i.test(`${description ?? ""} ${note ?? ""}`) ? "deposito" : "despesa";
}

export function isManoelTfaRow(row: Pick<RascunhoRow, "motorista" | "placa">): boolean {
  if (normalizePlaca(row.placa) === "TFA7A94") return true;
  return /manoel/i.test(row.motorista);
}

export function isOperationalStoreMessage(message: StoredMessage, botIds: string[]): boolean {
  if (botIds.includes(message.authorId) || message.authorRole === "bot") return false;
  if (!message.externalId?.trim()) return false;
  if (message.type === "anexo_comprovante") return true;
  if (message.attachmentRef || message.media) return true;
  const text = message.text ?? "";
  if (!text.trim()) return message.type === "audio_info";
  if (looksOperationalV2(text, false)) return true;
  return /ped[aá]gio|danfe|borracharia|caderno|laudo|diesel|posto|depositou|abastec|frete|viagem/i.test(text);
}

function firstSourceMessage(state: AppState, record: OperationalRecord): StoredMessage | undefined {
  for (const id of record.sourceMessageIds) {
    const found = state.messages.find((item) => item.externalId === id);
    if (found) return found;
  }
  return undefined;
}

function moneyCell(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const parsed = parseBrl(value);
  return parsed !== undefined ? String(parsed) : value ? String(value) : "";
}

export function recordToRascunho(state: AppState, record: OperationalRecord): RascunhoRow | undefined {
  const message = firstSourceMessage(state, record);
  const messageId = message?.externalId?.trim() || record.sourceMessageIds.find((id) => id.trim()) || "";
  if (!messageId) return undefined;
  const mapped = recordToRow(state, record);
  const placa = normalizePlaca(mapped.veiculo) || mapped.veiculo;
  let tipo: RascunhoTipo = "outro";
  let dataDoc = mapped.data_registro;
  let valor = mapped.valor_movimento;
  let valorUnitario = "";
  let descricao = mapped.observacoes;
  if (record.kind === "viagem") {
    tipo = "viagem";
    const conta = formatSacosConta(mapped.observacoes);
    if (conta) {
      valor = String(conta.valor);
      descricao = conta.observacao;
    } else if (!valor) {
      const paper = parseBrl(mapped.observacoes);
      if (paper !== undefined) valor = String(paper);
    }
    if (record.viagem?.unitPrice) valorUnitario = String(record.viagem.unitPrice);
  } else if (record.kind === "abastecimento") {
    tipo = abastecimentoTipo(record.abastecimento?.payment);
    valor = moneyCell(record.abastecimento?.totalBrl);
    descricao = record.abastecimento?.note ?? mapped.posto_local;
  } else if (record.kind === "despesa") {
    tipo = despesaTipo(record.despesa?.description, record.despesa?.note);
    valor = moneyCell(record.despesa?.amountBrl);
    descricao = record.despesa?.description || record.despesa?.note || "";
  }
  const enviado = message?.sentAt || mapped.criado_em;
  const incompleto =
    record.status === "incompleto" ||
    tipo === "outro" ||
    (tipo === "viagem" && (!dataDoc || (!valor && !mapped.origem))) ||
    (tipo !== "viagem" && !valor);
  const row: RascunhoRow = {
    message_id: messageId,
    enviado_em: enviado,
    data_doc: isoDate(dataDoc),
    competencia: "",
    tipo,
    motorista: motoristaOf(state, record, placa),
    placa,
    origem: mapped.origem,
    destino: mapped.destino,
    material: mapped.material,
    toneladas: mapped.quantidade || mapped.peso_carga,
    valor_unitario: valorUnitario,
    valor,
    posto: mapped.posto_local,
    descricao,
    pagamento: mapped.pagamento || mapped.pagamento_despesa,
    source: messageSource(message),
    status: incompleto ? "incompleto" : "novo",
    record_id: record.id,
    fingerprint: "",
    campos_brutos: JSON.stringify({
      kind: record.kind,
      missing: record.missing,
      note: mapped.observacoes,
    }),
    arquivo_origem: arquivoOrigem(message),
  };
  row.competencia = competenciaFromDoc(row.data_doc, row.enviado_em);
  row.fingerprint = rascunhoFingerprint(row);
  return row;
}

export function messageToRascunho(state: AppState, message: StoredMessage): RascunhoRow {
  const enviado = message.sentAt;
  const row: RascunhoRow = {
    message_id: message.externalId,
    enviado_em: enviado,
    data_doc: isoDate(enviado),
    competencia: competenciaFromDoc(enviado, enviado),
    tipo: "outro",
    motorista: state.drivers.find((d) => d.id === message.authorId)?.name || "",
    placa: "",
    origem: "",
    destino: "",
    material: "",
    toneladas: "",
    valor_unitario: "",
    valor: "",
    posto: "",
    descricao: (message.text ?? "").slice(0, 180),
    pagamento: "",
    source: messageSource(message),
    status: "incompleto",
    record_id: "",
    fingerprint: "",
    campos_brutos: JSON.stringify({ type: message.type, text: message.text ?? "" }),
    arquivo_origem: arquivoOrigem(message),
  };
  row.fingerprint = rascunhoFingerprint(row);
  return row;
}

function recordsForRascunho(state: AppState, sessionStartedAt?: string): OperationalRecord[] {
  const sessionMs = parseSessionStart(sessionStartedAt);
  if (!sessionMs) return state.records.filter((item) => isSyncEligible(item));
  const conversations = state.conversations.filter((item) => item.active);
  return state.records.filter((record) => {
    if (!isSyncEligible(record)) return false;
    return conversations.some((conversation) => recordInCurrentSession(state, record, conversation, sessionMs));
  });
}

export function buildRascunhoFromState(state: AppState, sessionStartedAt?: string): RascunhoRow[] {
  const records = recordsForRascunho(state, sessionStartedAt);
  const rows: RascunhoRow[] = [];
  const seenKeys = new Set<string>();
  const coveredMessages = new Set<string>();
  for (const record of records) {
    const row = recordToRascunho(state, record);
    if (!row) continue;
    const key = rascunhoKey(row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    rows.push(row);
    coveredMessages.add(row.message_id);
    for (const id of record.sourceMessageIds) coveredMessages.add(id);
  }
  const sessionMsgs = sessionStartedAt
    ? state.messages.filter((item) => Date.parse(item.sentAt) >= Date.parse(sessionStartedAt))
    : state.messages;
  for (const message of sessionMsgs) {
    if (!isOperationalStoreMessage(message, state.botIds)) continue;
    if (coveredMessages.has(message.externalId)) continue;
    const row = messageToRascunho(state, message);
    const key = rascunhoKey(row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    rows.push(row);
  }
  return rows;
}

export function mergeRascunho(existing: RascunhoRow[], incoming: RascunhoRow[]): {
  merged: RascunhoRow[];
  toInsert: RascunhoRow[];
} {
  const merged = [...existing];
  const known = new Set(existing.map(rascunhoKey).filter(Boolean));
  const fingerprints = new Map<string, string[]>();
  for (const row of existing) {
    const list = fingerprints.get(row.fingerprint) ?? [];
    list.push(rascunhoKey(row));
    fingerprints.set(row.fingerprint, list);
  }
  const toInsert: RascunhoRow[] = [];
  for (const row of incoming) {
    const key = rascunhoKey(row);
    if (!key) continue;
    if (known.has(key)) continue;
    const twins = fingerprints.get(row.fingerprint) ?? [];
    const next = twins.length ? { ...row, status: "duplicado" as const } : row;
    known.add(key);
    const list = fingerprints.get(next.fingerprint) ?? [];
    list.push(key);
    fingerprints.set(next.fingerprint, list);
    merged.push(next);
    toInsert.push(next);
  }
  return { merged, toInsert };
}

export function markFingerprintDuplicates(rows: RascunhoRow[]): RascunhoRow[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    if (row.status === "ignorado") return row;
    if (!row.fingerprint) return row;
    if (seen.has(row.fingerprint)) return { ...row, status: "duplicado" };
    seen.add(row.fingerprint);
    return row;
  });
}
