import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState, OperationalRecord } from "../src/domain/types.ts";
import { processMessage } from "../src/engine/process.ts";
import { sheetsDemoState } from "../src/sheets/demo.ts";
import { formatSheetTable } from "../src/sheets/export.ts";
import {
  SHEET_COLUMNS,
  origemWhatsapp,
  recordToRow,
  recordsToRows,
} from "../src/sheets/mapper.ts";

function incompleteFuel(): { state: AppState; record: OperationalRecord } {
  const state = seedState();
  processMessage(
    state,
    {
      externalId: "inc-1",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista",
      sentAt: "2026-09-14T20:53:46.000Z",
      type: "texto",
      text: "abasteci 150 litros, deu 980, assinada",
    },
    { now: () => new Date("2026-09-14T20:53:46.000Z") },
  );
  const record = state.records[0];
  assert.ok(record);
  return { state, record };
}

describe("sheets mapper", () => {
  it("maps demo records into the spreadsheet contract without Google", () => {
    const state = sheetsDemoState();
    const rows = recordsToRows(state);
    assert.ok(rows.length >= 4);

    const fuel = rows.find((r) => r.tipo === "abastecimento" && r.pagamento === "pago");
    assert.equal(fuel?.motorista, "João");
    assert.equal(fuel?.litros, "200");
    assert.equal(fuel?.valor, "1200");
    assert.equal(fuel?.posto_local, "posto X");
    assert.equal(fuel?.valor_despesa, "");
    assert.equal(fuel?.origem, "");

    const signed = rows.find((r) => r.tipo === "abastecimento" && r.pagamento === "assinada");
    assert.ok(signed);
    assert.equal(signed?.status, "incompleto");
    assert.equal(signed?.posto_local, "");
    assert.equal(signed?.data_registro, "");

    const expense = rows.find((r) => r.tipo === "despesa");
    assert.equal(expense?.valor_despesa, "150");
    assert.equal(expense?.descricao_despesa, "almoço");
    assert.equal(expense?.pagamento_despesa, "pago");
    assert.equal(expense?.valor, "");
    assert.equal(expense?.pagamento, "");
    assert.equal(expense?.origem, "");

    const trip = rows.find((r) => r.tipo === "viagem");
    assert.equal(trip?.origem, "Barreiras");
    assert.equal(trip?.destino, "Recife");
    assert.equal(trip?.material, "soja");
    assert.equal(trip?.quantidade, "47");
    assert.equal(trip?.unidade, "m³");
    assert.equal(trip?.litros, "");
    assert.equal(trip?.valor_despesa, "");
    assert.equal(rows.filter((r) => r.tipo === "despesa" && r.origem === "Barreiras").length, 0);
  });

  it("does not turn a viagem record into a despesa row", () => {
    const state = sheetsDemoState();
    const trip = state.records.find((r) => r.kind === "viagem");
    assert.ok(trip);
    const row = recordToRow(state, trip);
    assert.equal(row.tipo, "viagem");
    assert.notEqual(row.tipo, "despesa");
  });

  it("keeps one row for a record with several source messages", () => {
    const state = seedState();
    processMessage(
      state,
      {
        externalId: "inc-1",
        conversationId: "conv-joao",
        authorId: "motorista-joao",
        authorRole: "motorista",
        sentAt: "2026-09-14T20:53:46.000Z",
        type: "texto",
        text: "abasteci 150 litros, deu 980, assinada",
      },
      { now: () => new Date("2026-09-14T20:53:46.000Z") },
    );
    processMessage(
      state,
      {
        externalId: "cmp-place",
        conversationId: "conv-joao",
        authorId: "motorista-joao",
        authorRole: "motorista",
        sentAt: "2026-09-14T20:54:32.000Z",
        type: "texto",
        text: "isso, posto jacinto",
      },
      { now: () => new Date("2026-09-14T20:54:32.000Z") },
    );
    processMessage(
      state,
      {
        externalId: "cmp-date",
        conversationId: "conv-joao",
        authorId: "motorista-joao",
        authorRole: "motorista",
        sentAt: "2026-09-14T20:54:40.000Z",
        type: "texto",
        text: "hoje",
      },
      { now: () => new Date("2026-09-14T20:54:40.000Z") },
    );

    assert.equal(state.records.length, 1);
    const row = recordToRow(state, state.records[0]);
    assert.equal(row.status, "completo");
    assert.equal(row.posto_local, "posto jacinto");
    assert.equal(row.origem_whatsapp, "inc-1 cmp-place cmp-date");
    assert.equal(row.criado_em, "2026-09-14T20:53:46.000Z");
    assert.equal(row.atualizado_em, "2026-09-14T20:54:40.000Z");
    assert.equal(recordsToRows(state).length, 1);
  });

  it("leaves timestamps empty when there is no source message", () => {
    const state = seedState();
    const record: OperationalRecord = {
      id: "orphan",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "incompleto",
      sourceMessageIds: ["missing-id"],
      missing: ["date"],
      despesa: { amountBrl: 80 },
    };
    const row = recordToRow(state, record);
    assert.equal(row.criado_em, "");
    assert.equal(row.atualizado_em, "");
    assert.equal(row.data_registro, "");
    assert.equal(row.valor_despesa, "80");
    assert.equal(row.descricao_despesa, "");
    assert.equal(row.status, "incompleto");
  });

  it("masks a JID if it appears in source ids and never emits the full value", () => {
    const record: OperationalRecord = {
      id: "x",
      kind: "viagem",
      driverId: "motorista-ana",
      status: "incompleto",
      sourceMessageIds: ["5551999887766@g.us", "msg-2"],
      missing: ["date"],
    };
    const origin = origemWhatsapp(record);
    assert.equal(origin.includes("5551999887766"), false);
    assert.equal(origin.includes("…7766@g.us"), true);
    assert.equal(origin.includes("msg-2"), true);
  });
});

describe("sheets export", () => {
  it("prints a TSV header with the contract columns and empty cells for missing fields", () => {
    const { state, record } = incompleteFuel();
    const row = recordToRow(state, record);
    const table = formatSheetTable([row]);
    const header = table.split("\n")[0];
    assert.equal(header, SHEET_COLUMNS.join("\t"));
    assert.equal(row.status, "incompleto");
    assert.equal(row.posto_local, "");
    assert.match(table, /\tincompleto\t/);
    assert.equal(table.includes("undefined"), false);
  });
});
