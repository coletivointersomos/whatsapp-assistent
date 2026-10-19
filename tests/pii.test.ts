import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { isValidCpf, maskJidsInText, maskPii } from "../src/privacy/pii.ts";
import { maskRecordPiiInPlace, maskStateRecordsPii } from "../src/privacy/records.ts";
import { seedState } from "../src/config/seed.ts";
import type { OperationalRecord } from "../src/domain/types.ts";

// CPF de teste com dígito verificador válido (gerado, não pertence a ninguém conhecido).
const CPF = "529.982.247-25";
const CPF_BARE = "52998224725";

describe("máscara de PII (módulo puro)", () => {
  // Máscara desligada por padrão desde 19/10/2026; aqui testa o comportamento religado.
  before(() => {
    process.env.PII_MASK_ENABLED = "true";
  });
  after(() => {
    delete process.env.PII_MASK_ENABLED;
  });

  it("CPF formatado ou só dígitos (DV válido) vira ***.***.***-NN", () => {
    assert.equal(isValidCpf(CPF), true);
    assert.equal(isValidCpf("11111111111"), false);
    assert.equal(maskPii(`CPF ${CPF} do motorista`), "CPF ***.***.***-25 do motorista");
    assert.equal(maskPii(`cpf ${CPF_BARE}`), "cpf ***.***.***-25");
    assert.equal(maskPii("cpf 529982247-25"), "cpf ***.***.***-25");
    // CPF já mascarado pelo banco também é normalizado
    assert.equal(maskPii("CPF ***.982.247-**"), "CPF ***.***.***-**");
  });

  it("telefone fica só com os 4 últimos dígitos", () => {
    assert.equal(maskPii("ligar (11) 98765-4321"), "ligar …4321");
    assert.equal(maskPii("whats +55 11 98765-4321"), "whats …4321");
    assert.equal(maskPii("tel 5511987654321"), "tel …4321");
    assert.equal(maskPii("cel 11987654321"), "cel …4321");
    assert.equal(maskPii("cel 98765-4321"), "cel …4321");
    assert.equal(maskPii("fixo (11) 3333-4444"), "fixo …4444");
  });

  it("JID fica só com os 4 últimos dígitos e o servidor; id OpenWA mantém o hash", () => {
    assert.equal(maskPii("grupo 120363012345678901@g.us"), "grupo …8901@g.us");
    assert.equal(maskPii("autor 5511987654321@c.us / 123456789012345@lid"), "autor …4321@c.us / …2345@lid");
    const id = "false_120363012345678901@g.us_3EB0C0FFEE1234567890_123456789012345@lid";
    assert.equal(maskJidsInText(id), "false_…8901@g.us_3EB0C0FFEE1234567890_…2345@lid");
    assert.equal(maskPii(id), maskJidsInText(id));
  });

  it("agência e conta bancária são removidas", () => {
    assert.equal(maskPii("Agência: 0001 Conta: 12345678-9"), "agência [removida] conta [removida]");
    assert.equal(maskPii("ag 1234 cc 98765-0 banco itau"), "agência [removida] conta [removida] banco itau");
    assert.equal(maskPii("conta corrente 123456"), "conta [removida]");
    assert.equal(maskPii("Conta: 1234567"), "conta [removida]");
  });

  it("chave/ID Pix fica só com os 6 últimos caracteres (CPF/telefone seguem a regra mais restrita)", () => {
    assert.equal(maskPii("Chave Pix: 7d9f8e2a-1b3c-4d5e-8f90-a1b2c3d4e5f6"), "Chave Pix: …d4e5f6");
    assert.equal(maskPii("pix joao.silva@example.com"), "pix …le.com");
    assert.equal(maskPii("ID da transação: E18236120202610191430s0123456789a"), "ID da transação: …56789a");
    assert.equal(maskPii("pix 11987654321 valor R$ 150,00"), "pix …4321 valor R$ 150,00");
    assert.equal(maskPii(`pix cpf ${CPF}`), "pix cpf ***.***.***-25");
    assert.equal(maskPii("pix cnpj 12.345.678/0001-90"), "pix cnpj …001-90");
  });

  it("não mascara dinheiro, litros, toneladas, datas, placas, NF/DANFE, CNPJ, CEP", () => {
    const keep = [
      "Abasteci 350,5 litros R$ 2.135,40 em 19/10/2026 placa TFA7A94 posto Shell",
      "896 SACOS A 4.00 = 3584 RECEBI 5.724",
      "32.500 kg / 47,7 t de areia, frete 1.234.567,89",
      "DANFE 000123456 chave 35261012345678000190550010001234561123456789",
      "NF 52998224725",
      "Pedido 11987654321",
      "CNPJ 12.345.678/0001-90 CEP 12345-678",
      "período 2025-2026 km 123.456 às 14:30",
      "conta: 40 sacos x 5",
      "fechei a conta 1.500,00",
      "pagamento pix feito, pix de R$ 300,00",
      "2026-10-19T14:36:32.227Z",
      "cupom 0012345678",
    ];
    for (const text of keep) assert.equal(maskPii(text), text, text);
  });

  it("é idempotente", () => {
    const text = `CPF ${CPF}, (11) 98765-4321, 120363012345678901@g.us, ag 1234 cc 98765-0, pix 7d9f8e2a-1b3c-4d5e-8f90-a1b2c3d4e5f6`;
    const once = maskPii(text);
    assert.equal(maskPii(once), once);
    assert.doesNotMatch(once, /98765|529\.982|0123456789|7d9f8e2a/);
  });

  it("mascara só os campos de texto livre do registro, no lugar", () => {
    const record: OperationalRecord = {
      id: "r-false_120363012345678901@g.us_3EB0AA",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["false_120363012345678901@g.us_3EB0AA"],
      missing: [],
      despesa: {
        date: "2026-10-19",
        amountBrl: 150,
        vehicle: "TFA7A94",
        description: `borracharia, pix ${CPF}`,
        payment: "pix 11987654321",
        note: "ag 1234 cc 98765-0",
      },
    };
    assert.equal(maskRecordPiiInPlace(record), true);
    assert.equal(record.despesa?.description, "borracharia, pix ***.***.***-25");
    assert.equal(record.despesa?.payment, "pix …4321");
    assert.equal(record.despesa?.note, "agência [removida] conta [removida]");
    assert.equal(record.despesa?.amountBrl, 150);
    assert.equal(record.despesa?.vehicle, "TFA7A94");
    assert.equal(record.despesa?.date, "2026-10-19");
    // ids não mudam (são chave de dedupe no store)
    assert.equal(record.id, "r-false_120363012345678901@g.us_3EB0AA");
    assert.deepEqual(record.sourceMessageIds, ["false_120363012345678901@g.us_3EB0AA"]);
    assert.equal(maskRecordPiiInPlace(record), false);

    const state = seedState();
    state.records.push({ ...record, id: "r2", despesa: { ...record.despesa, note: "cel 11987654321" } });
    assert.equal(maskStateRecordsPii(state), 1);
    assert.equal(state.records.at(-1)?.despesa?.note, "cel …4321");
  });
});

describe("máscara desligada (padrão, decisão de 19/10/2026)", () => {
  it("maskPii / maskJidsInText / maskFields / registros são no-op sem PII_MASK_ENABLED=true", async () => {
    delete process.env.PII_MASK_ENABLED;
    const { maskPii, maskJidsInText, maskFields, piiMaskEnabled } = await import("../src/privacy/pii.ts");
    const { maskStateRecordsPii } = await import("../src/privacy/records.ts");
    assert.equal(piiMaskEnabled(), false);
    const text = "CPF 529.982.247-25 tel (11) 98765-4321 pix 11987654321 ag 1234 conta 12345-6 5511999990000@c.us";
    assert.equal(maskPii(text), text);
    const id = "false_120363000000007200@g.us_ABCDEF_5511999990000@lid";
    assert.equal(maskJidsInText(id), id);
    const obj = { a: text };
    assert.equal(maskFields(obj, ["a"]), obj);
    const state = { records: [{ id: "r1", kind: "despesa", despesa: { description: text } }] } as never;
    assert.equal(maskStateRecordsPii(state), 0);
  });
});
