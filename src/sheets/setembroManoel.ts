import { seedState } from "../config/seed.ts";
import type { AppState, OperationalRecord, StoredMessage } from "../domain/types.ts";

function msg(partial: Pick<StoredMessage, "externalId" | "sentAt"> & Partial<StoredMessage>): StoredMessage {
  return {
    conversationId: "conv-joao",
    authorId: "motorista-joao",
    authorRole: "motorista",
    processedAt: partial.sentAt,
    type: "anexo_comprovante",
    ...partial,
  };
}

function rec(partial: OperationalRecord): OperationalRecord {
  return partial;
}

/** Store Manoel/setembro alinhado ao print da Alana (frete 54148, diesel 25619.60, despesas 4974). */
export function setembroManoelState(): AppState {
  const state = seedState();
  const controleId = "zap-controle-setembro";
  state.messages.push(
    msg({
      externalId: controleId,
      sentAt: "2026-10-08T17:00:00.000Z",
      type: "anexo_comprovante",
      text: "CONTROLE DE VIAGENS TFA Manoel setembro",
    }),
    msg({
      externalId: "zap-diesel-vista-1",
      sentAt: "2026-09-12T14:00:00.000Z",
      text: "diesel à vista",
    }),
    msg({
      externalId: "zap-diesel-vista-2",
      sentAt: "2026-09-20T14:00:00.000Z",
      text: "diesel à vista",
    }),
    msg({
      externalId: "zap-diesel-prazo",
      sentAt: "2026-09-25T14:00:00.000Z",
      text: "diesel a prazo",
    }),
    msg({
      externalId: "zap-laudo",
      sentAt: "2026-09-18T11:00:00.000Z",
      text: "laudo",
    }),
    msg({
      externalId: "zap-pedagio",
      sentAt: "2026-09-19T11:00:00.000Z",
      text: "pedágio",
    }),
    msg({
      externalId: "zap-borracharia",
      sentAt: "2026-09-21T11:00:00.000Z",
      text: "borracharia",
    }),
    msg({
      externalId: "zap-caderno",
      sentAt: "2026-09-22T11:00:00.000Z",
      text: "caderno de gastos",
    }),
    msg({
      externalId: "zap-danfe",
      sentAt: "2026-09-27T11:00:00.000Z",
      text: "DANFE",
    }),
  );

  const vehicle = "TFA7A94";
  const trips: Array<OperationalRecord["viagem"] & { id: string }> = [
    { id: "tfa-sep-08", date: "2026-09-08", origin: "Laranjeiras", destination: "Feira de Santana", material: "ureia", quantity: 47.7, unit: "toneladas", unitPrice: 120, freightTotal: 5724, note: "5.724 RECEBI", motorista: "Manoel", vehicle },
    { id: "tfa-sep-09", date: "2026-09-09", origin: "Laranjeiras", destination: "Feira de Santana", material: "ureia", quantity: 47.7, unit: "toneladas", unitPrice: 120, freightTotal: 5724, note: "5.724 RECEBI", motorista: "Manoel", vehicle },
    { id: "tfa-sep-10", date: "2026-09-10", origin: "Laranjeiras", destination: "Feira de Santana", material: "ureia", quantity: 47.7, unit: "toneladas", unitPrice: 120, freightTotal: 5724, note: "5.724 RECEBI", motorista: "Manoel", vehicle },
    { id: "tfa-sep-15", date: "2026-09-15", origin: "Laranjeiras", destination: "Feira de Santana", material: "ureia", quantity: 47.61667, unit: "toneladas", unitPrice: 120, freightTotal: 5714, note: "5.714 RECEBI", motorista: "Manoel", vehicle },
    { id: "tfa-sep-16", date: "2026-09-16", origin: "Laranjeiras", destination: "Luís Eduardo", material: "ureia", quantity: 46.89, unit: "toneladas", unitPrice: 200, freightTotal: 9378, note: "9.378 RECEBI (papel 46.98 t)", motorista: "Manoel", vehicle },
    { id: "tfa-sep-23", date: "2026-09-23", origin: "Natividade", destination: "Conceição Feira", material: "sorgo", quantity: 61, unit: "toneladas", unitPrice: 300, freightTotal: 18300, note: "18.300 RECEBI", motorista: "Manoel", vehicle },
    { id: "tfa-sep-29", date: "2026-09-29", origin: "Nova Soure", destination: "Lagarto", material: "milho", quantity: 53.75, unit: "toneladas", freightTotal: 3584, note: "3.586 = 896 SACOS A 4.00", motorista: "Manoel", vehicle },
  ];

  for (const trip of trips) {
    const { id, ...viagem } = trip;
    state.records.push(
      rec({
        id,
        kind: "viagem",
        driverId: "motorista-joao",
        status: "completo",
        sourceMessageIds: [controleId],
        missing: [],
        viagem,
      }),
    );
  }

  state.records.push(
    rec({
      id: "tfa-diesel-v1",
      kind: "abastecimento",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["zap-diesel-vista-1"],
      missing: [],
      abastecimento: { date: "2026-09-12", totalBrl: 8000, place: "Posto Vista", payment: "à vista", vehicle },
    }),
    rec({
      id: "tfa-diesel-v2",
      kind: "abastecimento",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["zap-diesel-vista-2"],
      missing: [],
      abastecimento: { date: "2026-09-20", totalBrl: 5619.6, place: "Posto Vista 2", payment: "à vista", vehicle },
    }),
    rec({
      id: "tfa-diesel-p1",
      kind: "abastecimento",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["zap-diesel-prazo"],
      missing: [],
      abastecimento: { date: "2026-09-25", totalBrl: 12000, place: "Posto Prazo", payment: "a prazo", vehicle },
    }),
    rec({
      id: "tfa-laudo",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["zap-laudo"],
      missing: [],
      despesa: { date: "2026-09-18", amountBrl: 850, description: "Laudo", payment: "pago", vehicle },
    }),
    rec({
      id: "tfa-pedagio",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["zap-pedagio"],
      missing: [],
      despesa: { date: "2026-09-19", amountBrl: 1200, description: "Pedágio", payment: "pago", vehicle },
    }),
    rec({
      id: "tfa-borracharia",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["zap-borracharia"],
      missing: [],
      despesa: { date: "2026-09-21", amountBrl: 420, description: "Borracharia", payment: "pago", vehicle },
    }),
    rec({
      id: "tfa-caderno",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["zap-caderno"],
      missing: [],
      despesa: { date: "2026-09-22", amountBrl: 1504, description: "Caderno de gastos", payment: "pago", vehicle },
    }),
    rec({
      id: "tfa-danfe",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["zap-danfe"],
      missing: [],
      despesa: { date: "2026-09-27", amountBrl: 1000, description: "DANFE", payment: "pago", vehicle },
    }),
  );

  return state;
}
