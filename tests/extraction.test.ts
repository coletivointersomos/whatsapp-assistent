import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractFromText } from "../src/extraction/extract.ts";

const sentAt = new Date("2026-09-09T12:00:00.000Z");

describe("extractFromText", () => {
  it("reads a complete-enough fueling line without turning assinada into pago", () => {
    const a = extractFromText(
      "hoje abasteci 200 litros no posto X deu 1200 pago",
      sentAt,
      "caminhão 1",
    );
    assert.equal(a?.kind, "abastecimento");
    assert.equal(a?.abastecimento?.liters, 200);
    assert.equal(a?.abastecimento?.totalBrl, 1200);
    assert.equal(a?.abastecimento?.place, "posto X");
    assert.equal(a?.abastecimento?.payment, "pago");

    const b = extractFromText("abasteci 150 litros, deu 980, assinada", sentAt);
    assert.equal(b?.abastecimento?.payment, "assinada");
    assert.notEqual(b?.abastecimento?.payment, "pago");
  });

  it("reads an expense", () => {
    const e = extractFromText("hoje gastei 150 com almoço pago", sentAt);
    assert.equal(e?.kind, "despesa");
    assert.equal(e?.despesa?.amountBrl, 150);
    assert.equal(e?.despesa?.description, "almoço");
    assert.equal(e?.despesa?.payment, "pago");
  });

  it("reads trips and does not classify frete as despesa", () => {
    const v = extractFromText(
      "viagem de Luis Eduardo para Simões Dias com milho 35 toneladas",
      sentAt,
    );
    assert.equal(v?.kind, "viagem");
    assert.equal(v?.viagem?.origin, "Luis Eduardo");
    assert.equal(v?.viagem?.destination, "Simões Dias");
    assert.equal(v?.viagem?.material, "milho");
    assert.equal(v?.viagem?.quantity, 35);
    assert.equal(v?.viagem?.unit, "toneladas");

    const f = extractFromText("frete de Barreiras para Recife, soja, 47 m3", sentAt);
    assert.equal(f?.kind, "viagem");
    assert.notEqual(f?.kind, "despesa");
    assert.equal(f?.viagem?.origin, "Barreiras");
    assert.equal(f?.viagem?.destination, "Recife");
    assert.equal(f?.viagem?.material, "soja");
    assert.equal(f?.viagem?.quantity, 47);
    assert.equal(f?.viagem?.unit, "m³");
  });

  it("classifies 'gastei ... frete' as despesa, not viagem", () => {
    const e = extractFromText("gastei 80 com frete pago", sentAt);
    assert.equal(e?.kind, "despesa");
    assert.equal(e?.despesa?.amountBrl, 80);
    assert.equal(e?.despesa?.description, "frete");
    assert.equal(e?.despesa?.payment, "pago");
  });
});
