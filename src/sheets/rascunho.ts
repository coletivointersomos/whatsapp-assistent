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
import { maskFields, maskJidsInText } from "../privacy/pii.ts";

export type RascunhoTipo =
  | "viagem"
  | "abastecimento_vista"
  | "abastecimento_prazo"
  | "despesa"
  | "deposito"
  | "outro";

export type RascunhoStatus = "novo" | "incompleto" | "promovido" | "ignorado" | "duplicado" | "confirmar";

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

const RASCUNHO_TEXT: (keyof RascunhoRow)[] = [
  "origem",
  "destino",
  "material",
  "posto",
  "descricao",
  "pagamento",
  "campos_brutos",
];
const RASCUNHO_IDS: (keyof RascunhoRow)[] = ["message_id", "record_id", "arquivo_origem"];

/**
 * PII fora do rascunho/oficial: texto livre mascarado; ids só com JID mascarado
 * (o hash da mensagem fica, então a chave continua única e estável entre leituras).
 * Idempotente: linha já mascarada volta igual.
 */
export function maskRascunhoRowPii(row: RascunhoRow): RascunhoRow {
  let next = maskFields(row, RASCUNHO_TEXT);
  for (const key of RASCUNHO_IDS) {
    const value = next[key];
    const masked = maskJidsInText(value);
    if (masked !== value) next = { ...next, [key]: masked };
  }
  if (next === row) return row;
  const printChanged = (["origem", "destino", "posto"] as const).some((col) => next[col] !== row[col]);
  return printChanged ? { ...next, fingerprint: rascunhoFingerprint(next) } : next;
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

export type SameValorDecision = "diferente" | "igual" | "incerto";

export type SameValorVerdict = { decision: SameValorDecision; reason: string };

export type SameValorCheck = {
  status: "novo" | "duplicado" | "confirmar";
  peer?: RascunhoRow;
  verdict?: SameValorVerdict;
};

/** Valor numérico normalizado (2 casas); undefined se vazio ou <= 0. */
export function rascunhoValorNumber(value: string): number | undefined {
  const text = (value ?? "").trim();
  if (!text) return undefined;
  let n: number | undefined;
  if (/^\d+(\.\d{1,2})?$/.test(text)) n = Number(text);
  else if (/^\d+,\d{1,2}$/.test(text)) n = Number(text.replace(",", "."));
  else n = parseBrl(text);
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 100) / 100;
}

function evidenceNorm(value: string): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rawNote(row: Pick<RascunhoRow, "campos_brutos">): string {
  try {
    const parsed = JSON.parse(row.campos_brutos || "{}") as { note?: unknown; text?: unknown };
    return [parsed.note, parsed.text].filter((item) => typeof item === "string").join(" ");
  } catch {
    return "";
  }
}

/** Números de DANFE/NF/cupom citados na descrição ou na observação bruta. */
export function rascunhoDocNumbers(row: Pick<RascunhoRow, "descricao" | "campos_brutos">): Set<string> {
  const found = new Set<string>();
  const text = `${row.descricao ?? ""} ${rawNote(row)}`;
  const pattern = /\b(?:danfe|nf-?e?|nota\s+fiscal|cupom|coo|documento|doc)\b\s*(?:n[º°o.]*|num(?:ero)?\.?|#)?\s*[:\-]?\s*(\d[\d.\-]*\d)(?![\d/])/gi;
  for (const match of text.matchAll(pattern)) {
    const digits = (match[1] ?? "").replace(/\D/g, "").replace(/^0+/, "");
    if (digits.length >= 3) found.add(digits);
  }
  return found;
}

function shortDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? `${value.slice(8, 10)}/${value.slice(5, 7)}` : value || "sem data";
}

function originNote(row: RascunhoRow, other: RascunhoRow): string {
  if (row.message_id && row.message_id === other.message_id) return "mesma mensagem";
  return `mensagens diferentes (${shortDate(other.enviado_em.slice(0, 10))} e ${shortDate(row.enviado_em.slice(0, 10))})`;
}

/**
 * Compara duas linhas com mesmo valor e mesma competência (impressões digitais diferentes).
 * "diferente" = evidência mostra dois gastos reais; "igual" = mesmo documento; "incerto" = pedir confirmação.
 */
export function compareSameValor(row: RascunhoRow, other: RascunhoRow): SameValorVerdict {
  const origin = originNote(row, other);
  if (row.tipo !== other.tipo) return { decision: "diferente", reason: `tipos diferentes; ${origin}` };
  const docsA = rascunhoDocNumbers(row);
  const docsB = rascunhoDocNumbers(other);
  if (docsA.size && docsB.size) {
    const shared = [...docsA].find((item) => docsB.has(item));
    if (shared) return { decision: "igual", reason: `mesmo nº de documento ${shared}; ${origin}` };
    return { decision: "diferente", reason: `nº de documento diferente (${[...docsB][0]} e ${[...docsA][0]}); ${origin}` };
  }
  const placaA = normalizePlaca(row.placa);
  const placaB = normalizePlaca(other.placa);
  if (placaA && placaB && placaA !== placaB) {
    return { decision: "diferente", reason: `caminhões diferentes (${placaB} e ${placaA}); ${origin}` };
  }
  const samePlaca = Boolean(placaA && placaA === placaB);
  const sameDate = Boolean(row.data_doc && row.data_doc === other.data_doc);
  const diffDate = Boolean(row.data_doc && other.data_doc && row.data_doc !== other.data_doc);
  const dates = `${shortDate(other.data_doc)} e ${shortDate(row.data_doc)}`;
  if (row.tipo === "viagem") {
    const routeA = `${evidenceNorm(row.origem)}>${evidenceNorm(row.destino)}`;
    const routeB = `${evidenceNorm(other.origem)}>${evidenceNorm(other.destino)}`;
    const hasRoutes = routeA !== ">" && routeB !== ">";
    if (diffDate) return { decision: "diferente", reason: `datas diferentes (${dates}); ${origin}` };
    if (hasRoutes && routeA !== routeB) return { decision: "diferente", reason: `rotas diferentes; ${origin}` };
    if (sameDate && hasRoutes && samePlaca) {
      return { decision: "igual", reason: `mesma data, rota e caminhão (${shortDate(row.data_doc)}, ${placaA}); ${origin}` };
    }
    return { decision: "incerto", reason: `sem DANFE/nº e sem data/rota que diferencie; ${origin}` };
  }
  const postoA = evidenceNorm(row.posto);
  const postoB = evidenceNorm(other.posto);
  const diffPosto = Boolean(postoA && postoB && postoA !== postoB);
  const samePosto = Boolean(postoA && postoA === postoB);
  if (diffDate && diffPosto) return { decision: "diferente", reason: `datas e postos diferentes (${dates}); ${origin}` };
  if (diffDate && row.message_id && row.message_id === other.message_id) {
    return { decision: "diferente", reason: `linhas de datas diferentes na mesma mensagem (${dates})` };
  }
  if (sameDate && samePosto && samePlaca) {
    return { decision: "igual", reason: `mesma data, posto e caminhão (${shortDate(row.data_doc)}, ${placaA}); ${origin}` };
  }
  return { decision: "incerto", reason: `sem DANFE/nº e sem data+posto que diferencie; ${origin}` };
}

/** Linhas anteriores com mesmo valor (> 0) e mesma competência, que não sejam a mesma impressão digital. */
export function sameValorPeers(row: RascunhoRow, earlier: RascunhoRow[]): RascunhoRow[] {
  const valor = rascunhoValorNumber(row.valor);
  if (valor === undefined || !row.competencia) return [];
  const key = rascunhoKey(row);
  return earlier.filter(
    (item) =>
      item.status !== "ignorado" &&
      item.status !== "duplicado" &&
      rascunhoKey(item) !== key &&
      item.fingerprint !== row.fingerprint &&
      item.competencia === row.competencia &&
      rascunhoValorNumber(item.valor) === valor,
  );
}

export function checkSameValor(row: RascunhoRow, earlier: RascunhoRow[]): SameValorCheck {
  let unsure: SameValorCheck | undefined;
  let different: SameValorCheck | undefined;
  for (const peer of sameValorPeers(row, earlier)) {
    const verdict = compareSameValor(row, peer);
    if (verdict.decision === "igual") return { status: "duplicado", peer, verdict };
    if (verdict.decision === "incerto") unsure ??= { status: "confirmar", peer, verdict };
    else different ??= { status: "novo", peer, verdict };
  }
  return unsure ?? different ?? { status: "novo" };
}

/** Linha "confirmar" ainda não aceita: completa campos vazios (e nº de documento) com a versão atual do store. */
function refreshConfirmar(row: RascunhoRow, fresh?: RascunhoRow): RascunhoRow {
  if (!fresh) return row;
  const next = { ...row };
  for (const col of ["data_doc", "posto", "placa", "origem", "destino", "descricao"] as const) {
    if (!next[col].trim() && fresh[col].trim()) next[col] = fresh[col];
  }
  if (rascunhoDocNumbers(next).size === 0 && rascunhoDocNumbers(fresh).size > 0) {
    next.descricao = fresh.descricao;
    next.campos_brutos = fresh.campos_brutos;
  }
  const changed = (["data_doc", "posto", "placa", "origem", "destino", "descricao", "campos_brutos"] as const).some(
    (col) => next[col] !== row[col],
  );
  if (changed) next.fingerprint = rascunhoFingerprint(next);
  return next;
}

export function mergeRascunho(existing: RascunhoRow[], incoming: RascunhoRow[]): {
  merged: RascunhoRow[];
  toInsert: RascunhoRow[];
} {
  const incomingByKey = new Map(incoming.map((row) => [rascunhoKey(row), row]));
  const merged: RascunhoRow[] = [];
  for (const row of existing) {
    if (row.status !== "confirmar") {
      merged.push(row);
      continue;
    }
    const refreshed = refreshConfirmar(row, incomingByKey.get(rascunhoKey(row)));
    merged.push({ ...refreshed, status: checkSameValor(refreshed, merged).status });
  }
  const known = new Set(existing.map(rascunhoKey).filter(Boolean));
  const fingerprints = new Map<string, string[]>();
  for (const row of merged) {
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
    let next: RascunhoRow = twins.length ? { ...row, status: "duplicado" as const } : row;
    if (!twins.length && row.status === "novo") {
      const check = checkSameValor(row, merged);
      if (check.status !== "novo") next = { ...row, status: check.status };
    }
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
