import { maskJid } from "../inspect/mask.ts";
import type { AppState, OperationalRecord, StoredMessage } from "../domain/types.ts";

export type SheetRow = {
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
};

export const SHEET_COLUMNS: (keyof SheetRow)[] = [
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
    row.posto_local = cell(f.place);
    row.pagamento = cell(f.payment);
    row.observacoes = cell(f.note);
  } else if (record.kind === "despesa" && record.despesa) {
    const f = record.despesa;
    row.data_registro = cell(f.date);
    row.veiculo = cell(f.vehicle);
    row.valor_despesa = cell(f.amountBrl);
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
    row.observacoes = cell(f.note);
  }

  return row;
}

export function recordsToRows(state: AppState): SheetRow[] {
  return state.records.map((r) => recordToRow(state, r));
}

/** Sem `record_id` o registro não entra no sync. */
export function isSyncEligible(row: Pick<SheetRow, "record_id"> | OperationalRecord): boolean {
  const id = "record_id" in row ? row.record_id : row.id;
  return Boolean(id?.trim());
}
