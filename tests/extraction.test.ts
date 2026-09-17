import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractComplement, extractFromText } from "../src/extraction/extract.ts";

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

describe("extractComplement", () => {
  it("fills abastecimento date and place without repeating the category", () => {
    const a = extractComplement("abastecimento", "foi hoje no posto X", sentAt);
    assert.equal(a.abastecimento?.date, "2026-09-09");
    assert.equal(a.abastecimento?.place, "posto X");
    assert.equal(extractFromText("foi hoje no posto X", sentAt), undefined);

    const b = extractComplement("abastecimento", "ontem no posto São João", sentAt);
    assert.equal(b.abastecimento?.date, "2026-09-08");
    assert.equal(b.abastecimento?.place, "posto São João");

    const c = extractComplement("abastecimento", "posto X", sentAt);
    assert.equal(c.abastecimento?.place, "posto X");
    assert.equal(c.abastecimento?.date, undefined);

    const d = extractComplement("abastecimento", "foi no posto São João hoje", sentAt);
    assert.equal(d.abastecimento?.place, "posto São João");
    assert.equal(d.abastecimento?.date, "2026-09-09");

    const e = extractComplement("abastecimento", "foi hoje lá no posto X", sentAt);
    assert.equal(e.abastecimento?.date, "2026-09-09");
    assert.equal(e.abastecimento?.place, "posto X");
  });

  it("fills despesa payment and description without gastei", () => {
    const a = extractComplement("despesa", "foi almoço, assinada", sentAt);
    assert.equal(a.despesa?.description, "almoço");
    assert.equal(a.despesa?.payment, "assinada");

    const b = extractComplement("despesa", "foi pago", sentAt);
    assert.equal(b.despesa?.payment, "pago");
    assert.equal(b.despesa?.description, undefined);

    const c = extractComplement("despesa", "com almoço", sentAt);
    assert.equal(c.despesa?.description, "almoço");

    const d = extractComplement("despesa", "isso foi pago", sentAt);
    assert.equal(d.despesa?.payment, "pago");

    const e = extractComplement("despesa", "pode colocar como assinada", sentAt);
    assert.equal(e.despesa?.payment, "assinada");

    const f = extractComplement("despesa", "foi com almoço", sentAt);
    assert.equal(f.despesa?.description, "almoço");

    const pix = extractComplement("despesa", "o gasto do eletricista foi 250 no pix", sentAt);
    assert.equal(pix.despesa?.amountBrl, 250);
    assert.equal(pix.despesa?.payment, "pix");
    assert.equal(pix.despesa?.description, "eletricista");
  });

  it("fills viagem quantity, unit, route and material without repeating viagem", () => {
    const qty = extractComplement("viagem", "47 m3", sentAt);
    assert.equal(qty.viagem?.quantity, 47);
    assert.equal(qty.viagem?.unit, "m³");

    const tons = extractComplement("viagem", "35 toneladas", sentAt);
    assert.equal(tons.viagem?.quantity, 35);
    assert.equal(tons.viagem?.unit, "toneladas");

    const route = extractComplement("viagem", "de Barreiras pra Recife", sentAt);
    assert.equal(route.viagem?.origin, "Barreiras");
    assert.equal(route.viagem?.destination, "Recife");

    const material = extractComplement("viagem", "era soja", sentAt);
    assert.equal(material.viagem?.material, "soja");

    const foram = extractComplement("viagem", "foram 47 m3", sentAt);
    assert.equal(foram.viagem?.quantity, 47);
    assert.equal(foram.viagem?.unit, "m³");
  });
});
