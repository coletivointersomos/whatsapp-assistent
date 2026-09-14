import type { AppState, OperationalRecord } from "../domain/types.ts";
import { seedState } from "../config/seed.ts";
import { processMessage } from "../engine/process.ts";

export type SheetRow = {
  data: string;
  motorista: string;
  veiculo: string;
  tipo: string;
  origem: string;
  destino: string;
  material: string;
  quantidade: string;
  unidade: string;
  litros: string;
  valor: string;
  local: string;
  pagamento: string;
  observacao: string;
  status_registro: string;
  mensagem_origem_id: string;
  criado_em: string;
};

export const SHEET_COLUMNS: (keyof SheetRow)[] = [
  "data",
  "motorista",
  "veiculo",
  "tipo",
  "origem",
  "destino",
  "material",
  "quantidade",
  "unidade",
  "litros",
  "valor",
  "local",
  "pagamento",
  "observacao",
  "status_registro",
  "mensagem_origem_id",
  "criado_em",
];

function cell(value: string | number | undefined): string {
  if (value === undefined || value === "") return "";
  return String(value);
}

function driverName(state: AppState, driverId: string): string {
  return state.drivers.find((d) => d.id === driverId)?.name ?? driverId;
}

export function recordToRow(state: AppState, record: OperationalRecord): SheetRow {
  const empty: SheetRow = {
    data: "",
    motorista: driverName(state, record.driverId),
    veiculo: "",
    tipo: record.kind,
    origem: "",
    destino: "",
    material: "",
    quantidade: "",
    unidade: "",
    litros: "",
    valor: "",
    local: "",
    pagamento: "",
    observacao: "",
    status_registro: record.status,
    mensagem_origem_id: record.sourceMessageIds.join(" "),
    criado_em: "",
  };

  const lastMsg = [...state.messages]
    .reverse()
    .find((m) => record.sourceMessageIds.includes(m.externalId));
  empty.criado_em = lastMsg?.processedAt ?? lastMsg?.sentAt ?? "";

  if (record.kind === "abastecimento" && record.abastecimento) {
    const f = record.abastecimento;
    empty.data = cell(f.date);
    empty.veiculo = cell(f.vehicle);
    empty.litros = cell(f.liters);
    empty.valor = cell(f.totalBrl);
    empty.local = cell(f.place);
    empty.pagamento = cell(f.payment);
    empty.observacao = cell(f.note);
  } else if (record.kind === "despesa" && record.despesa) {
    const f = record.despesa;
    empty.data = cell(f.date);
    empty.veiculo = cell(f.vehicle);
    empty.valor = cell(f.amountBrl);
    empty.pagamento = cell(f.payment);
    empty.observacao = cell(f.description ?? f.note);
  } else if (record.kind === "viagem" && record.viagem) {
    const f = record.viagem;
    empty.data = cell(f.date);
    empty.veiculo = cell(f.vehicle);
    empty.origem = cell(f.origin);
    empty.destino = cell(f.destination);
    empty.material = cell(f.material);
    empty.quantidade = cell(f.quantity);
    empty.unidade = cell(f.unit);
    empty.observacao = cell(f.note);
    empty.valor = cell(f.freightTotal);
  }

  return empty;
}

export function recordsToRows(state: AppState): SheetRow[] {
  return state.records.map((r) => recordToRow(state, r));
}

export function formatSheetTable(rows: SheetRow[]): string {
  const header = SHEET_COLUMNS.join("\t");
  const body = rows.map((row) => SHEET_COLUMNS.map((col) => row[col]).join("\t")).join("\n");
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

/** Estado demo previsível, sem data/store.json. */
export function sheetsDemoState(): AppState {
  const state = seedState();
  const messages = [
    {
      externalId: "demo-abast",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista" as const,
      sentAt: "2026-09-09T12:00:00.000Z",
      type: "texto" as const,
      text: "hoje abasteci 200 litros no posto X deu 1200 pago",
    },
    {
      externalId: "demo-despesa",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista" as const,
      sentAt: "2026-09-09T12:10:00.000Z",
      type: "audio_info" as const,
      text: "hoje gastei 150 com almoço pago",
    },
    {
      externalId: "demo-assinada",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista" as const,
      sentAt: "2026-09-09T12:20:00.000Z",
      type: "texto" as const,
      text: "abasteci 150 litros, deu 980, assinada",
    },
    {
      externalId: "demo-viagem",
      conversationId: "conv-ana",
      authorId: "motorista-ana",
      authorRole: "motorista" as const,
      sentAt: "2026-09-09T13:00:00.000Z",
      type: "texto" as const,
      text: "hoje frete de Barreiras para Recife, soja, 47 m3",
    },
  ];

  for (const message of messages) {
    const sentAt = new Date(message.sentAt);
    processMessage(state, message, { now: () => sentAt });
  }
  return state;
}
