import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordToRow, recordsToRows, sheetsDemoState } from "../src/sheets/preview.ts";

describe("sheets preview", () => {
  it("maps demo records into spreadsheet columns without Google", () => {
    const state = sheetsDemoState();
    const rows = recordsToRows(state);
    assert.ok(rows.length >= 4);

    const fuel = rows.find((r) => r.tipo === "abastecimento" && r.pagamento === "pago");
    assert.equal(fuel?.motorista, "João");
    assert.equal(fuel?.litros, "200");
    assert.equal(fuel?.valor, "1200");
    assert.equal(fuel?.local, "posto X");

    const signed = rows.find((r) => r.pagamento === "assinada");
    assert.ok(signed);
    assert.notEqual(signed?.pagamento, "pago");

    const expense = rows.find((r) => r.tipo === "despesa");
    assert.equal(expense?.valor, "150");
    assert.equal(expense?.observacao, "almoço");
    assert.equal(expense?.pagamento, "pago");

    const trip = rows.find((r) => r.tipo === "viagem");
    assert.equal(trip?.origem, "Barreiras");
    assert.equal(trip?.destino, "Recife");
    assert.equal(trip?.material, "soja");
    assert.equal(trip?.quantidade, "47");
    assert.equal(trip?.unidade, "m³");
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
});
