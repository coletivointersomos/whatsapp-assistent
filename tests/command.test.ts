import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { confirmationForKind, parseCentralCommand, questionForMissing } from "../src/extraction/command.ts";

describe("parseCentralCommand", () => {
  it("parses an explicit suspension", () => {
    const parsed = parseCentralCommand(
      "suspender motorista João de 2026-09-10 até 2026-09-15",
    );
    assert.equal(parsed.ambiguous, false);
    if (parsed.ambiguous || parsed.type !== "suspend") throw new Error("expected suspend");
    assert.equal(parsed.driverName, "João");
    assert.equal(parsed.start, "2026-09-10");
    assert.equal(parsed.end, "2026-09-15");
  });

  it("asks for clarification when suspender is incomplete", () => {
    const parsed = parseCentralCommand("suspender João");
    assert.equal(parsed.ambiguous, true);
    assert.equal(parsed.type, "ambiguous");
  });

  it("ignores ordinary chat that is not a command", () => {
    for (const text of ["oi", "obrigada", "beleza"]) {
      const parsed = parseCentralCommand(text);
      assert.equal(parsed.type, "none");
      assert.equal(parsed.ambiguous, false);
    }
  });
});

describe("perguntas e confirmações curtas", () => {
  it("asks a short question for common missing pairs", () => {
    assert.equal(questionForMissing("abastecimento", ["place"]), "Qual foi o posto?");
    assert.equal(
      questionForMissing("abastecimento", ["date", "place"]),
      "Foi hoje? E qual foi o posto?",
    );
    assert.equal(
      questionForMissing("despesa", ["amountBrl", "date", "payment"], { description: "eletricista" }),
      "Entendi o gasto com eletricista. Qual foi o valor, a forma de pagamento e o dia?",
    );
    assert.equal(
      questionForMissing("despesa", ["date"], { description: "eletricista", amountBrl: 250, payment: "pix" }),
      "Registrei R$ 250 com eletricista no pix. Qual foi o dia exato desse gasto?",
    );
    assert.equal(questionForMissing("despesa", ["payment"]), "Foi pago ou ficou assinada?");
    assert.equal(
      questionForMissing("viagem", ["origin", "destination"]),
      "Qual foi a origem e o destino?",
    );
  });

  it("confirms by record kind", () => {
    assert.equal(confirmationForKind("abastecimento"), "Fechado, registrei esse abastecimento.");
    assert.equal(confirmationForKind("despesa"), "Fechado, registrei essa despesa.");
    assert.equal(confirmationForKind("viagem"), "Fechado, registrei essa viagem.");
  });
});
