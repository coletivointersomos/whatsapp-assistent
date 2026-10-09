import { jidEquals } from "../domain/identity.ts";
import type { AppState, OperationalRecord } from "../domain/types.ts";
import { fingerprint, maskJid } from "./mask.ts";

export type RecordsPreviewOptions = {
  conversationId?: string;
  since?: Date;
  kind?: OperationalRecord["kind"];
};

export type RecordPreviewLine = {
  kind: OperationalRecord["kind"];
  status: OperationalRecord["status"];
  missing: string[];
  conversationMasked: string;
  conversationFp: string;
  sourceCount: number;
  lastActivity?: string;
  date?: string;
  place?: string;
  origin?: string;
  destination?: string;
  material?: string;
  liters?: number;
  totalBrl?: number;
  amountBrl?: number;
  payment?: string;
  quantity?: number;
  unit?: string;
};

export function conversationIdForRecord(state: AppState, record: OperationalRecord): string | undefined {
  for (const id of record.sourceMessageIds) {
    const message = state.messages.find((item) => item.externalId === id);
    if (message?.conversationId) return message.conversationId;
  }
  return undefined;
}

export function lastActivityForRecord(state: AppState, record: OperationalRecord): Date | undefined {
  let latest: Date | undefined;
  for (const id of record.sourceMessageIds) {
    const message = state.messages.find((item) => item.externalId === id);
    const raw = message?.sentAt ?? message?.processedAt;
    if (!raw) continue;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) continue;
    if (!latest || date > latest) latest = date;
  }
  return latest;
}

export function previewRecords(state: AppState, options: RecordsPreviewOptions = {}): RecordPreviewLine[] {
  const lines: RecordPreviewLine[] = [];
  for (const record of state.records) {
    if (options.kind && record.kind !== options.kind) continue;
    const conversationId = conversationIdForRecord(state, record);
    if (options.conversationId) {
      if (!conversationId || !jidEquals(conversationId, options.conversationId)) continue;
    }
    const activity = lastActivityForRecord(state, record);
    if (options.since) {
      if (!activity || activity < options.since) continue;
    }
    const fuel = record.abastecimento;
    const expense = record.despesa;
    const trip = record.viagem;
    lines.push({
      kind: record.kind,
      status: record.status,
      missing: [...record.missing],
      conversationMasked: conversationId ? maskJid(conversationId) : "(sem conversa)",
      conversationFp: conversationId ? fingerprint(conversationId) : "",
      sourceCount: record.sourceMessageIds.length,
      lastActivity: activity?.toISOString(),
      date: (fuel?.date ?? expense?.date ?? trip?.date) as string | undefined,
      place: fuel?.place,
      origin: trip?.origin,
      destination: trip?.destination,
      material: trip?.material,
      liters: fuel?.liters,
      totalBrl: fuel?.totalBrl,
      amountBrl: expense?.amountBrl,
      payment: (fuel?.payment ?? expense?.payment) as string | undefined,
      quantity: trip?.quantity,
      unit: trip?.unit,
    });
  }
  return lines.sort((a, b) => (a.lastActivity ?? "").localeCompare(b.lastActivity ?? ""));
}

export function formatRecordsPreview(
  lines: RecordPreviewLine[],
  meta: { source: string; conversation?: string; since?: string },
): string {
  const header = [
    `Fonte: ${meta.source}`,
    meta.conversation
      ? `Conversa: ${maskJid(meta.conversation)} (fp ${fingerprint(meta.conversation)})`
      : "Conversa: todas",
    meta.since ? `Desde: ${meta.since}` : "Desde: (sem filtro de data)",
    `Registros: ${lines.length}`,
    "",
  ];
  if (lines.length === 0) {
    return `${header.join("\n")}Nenhum registro neste recorte.\n`;
  }
  const body = lines.map((line, index) => {
    const bits = [
      `${index + 1}. ${line.kind} ${line.status}`,
      `   conversa ${line.conversationMasked} fp ${line.conversationFp}`,
      `   fontes ${line.sourceCount}` + (line.lastActivity ? ` · última ${line.lastActivity}` : ""),
    ];
    if (line.date) bits.push(`   data ${line.date}`);
    if (line.place) bits.push(`   posto ${line.place}`);
    if (line.liters !== undefined) bits.push(`   litros ${line.liters}`);
    if (line.totalBrl !== undefined) bits.push(`   total ${line.totalBrl}`);
    if (line.amountBrl !== undefined) bits.push(`   valor ${line.amountBrl}`);
    if (line.payment) bits.push(`   pagamento ${line.payment}`);
    if (line.origin || line.destination) {
      bits.push(`   rota ${line.origin ?? "?"} → ${line.destination ?? "?"}`);
    }
    if (line.material) bits.push(`   material ${line.material}`);
    if (line.quantity !== undefined) bits.push(`   quantidade ${line.quantity}${line.unit ? ` ${line.unit}` : ""}`);
    if (line.missing.length) bits.push(`   faltam ${line.missing.join(", ")}`);
    return bits.join("\n");
  });
  return `${header.join("\n")}${body.join("\n\n")}\n`;
}
