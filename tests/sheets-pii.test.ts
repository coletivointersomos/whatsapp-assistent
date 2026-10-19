import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import type { AppState } from "../src/domain/types.ts";
import { parseBrl, recordToRow } from "../src/sheets/mapper.ts";
import { planPagamento } from "../src/sheets/pagamento.ts";
import { buildRascunhoFromState, maskRascunhoRowPii, parseRascunhoGrid, rascunhoToValues } from "../src/sheets/rascunho.ts";

const GROUP = "120363012345678901@g.us";
const MSG = `false_${GROUP}_3EB0C0FFEE1234567890_123456789012345@lid`;
const MSG2 = `false_${GROUP}_3EB0C0FFEEABCDEF0011_123456789012345@lid`;
const LEAKS = /98765|529\.982|52998224725|120363012345678901|123456789012345|7d9f8e2a/;

function stateWithPii(): AppState {
  const state = seedState();
  state.drivers.push({ id: "motorista-manoel", name: "Manoel" });
  state.messages.push(
    {
      externalId: MSG,
      conversationId: GROUP,
      authorId: "motorista-joao",
      authorRole: "motorista",
      sentAt: "2026-10-10T12:00:00.000Z",
      processedAt: "2026-10-10T12:00:00.000Z",
      type: "anexo_comprovante",
      text: "borracharia TFA7A94",
    },
    {
      externalId: MSG2,
      conversationId: GROUP,
      authorId: "motorista-manoel",
      authorRole: "motorista",
      sentAt: "2026-10-11T12:00:00.000Z",
      processedAt: "2026-10-11T12:00:00.000Z",
      type: "texto",
      text: "depositou pix 7d9f8e2a-1b3c-4d5e-8f90-a1b2c3d4e5f6 cpf 529.982.247-25 TFA7A94 manoel",
    },
  );
  state.records.push({
    id: `r-${MSG}`,
    kind: "despesa",
    driverId: "motorista-joao",
    status: "completo",
    sourceMessageIds: [MSG],
    missing: [],
    despesa: {
      date: "2026-10-10",
      amountBrl: 180,
      vehicle: "TFA7A94",
      description: "borracharia, pix (11) 98765-4321",
      payment: "pix cpf 529.982.247-25",
      note: "ag 1234 cc 98765-0",
    },
  });
  return state;
}

describe("PII fora da planilha", () => {
  // Máscara desligada por padrão desde 19/10/2026; aqui testa o comportamento religado.
  before(() => {
    process.env.PII_MASK_ENABLED = "true";
  });
  after(() => {
    delete process.env.PII_MASK_ENABLED;
  });

  it("SheetRow (record mapping) sai mascarado, valores intactos", () => {
    const state = stateWithPii();
    const row = recordToRow(state, state.records[0]!);
    assert.equal(row.descricao_despesa, "borracharia, pix …4321");
    assert.equal(row.pagamento_despesa, "pix cpf ***.***.***-25");
    assert.equal(row.observacoes, "agência [removida] conta [removida]");
    assert.equal(row.valor_despesa, "180");
    assert.equal(row.veiculo, "TFA7A94");
    assert.equal(row.record_id, "r-false_…8901@g.us_3EB0C0FFEE1234567890_…2345@lid");
    assert.doesNotMatch(JSON.stringify(row), LEAKS);
  });

  it("rascunho e oficial gravados não têm CPF/telefone/JID/conta/Pix", () => {
    const plan = planPagamento({ state: stateWithPii() });
    assert.ok(plan.merged.length >= 2);
    assert.doesNotMatch(JSON.stringify(rascunhoToValues(plan.merged)), LEAKS);
    assert.doesNotMatch(JSON.stringify(plan.oficial.map((sheet) => sheet.values)), LEAKS);
    const despesa = plan.merged.find((row) => row.tipo === "despesa");
    assert.equal(despesa?.valor, "180");
    assert.equal(despesa?.placa, "TFA7A94");
  });

  it("mensagem no store com id mascarado na planilha não conta como esquecida", () => {
    const plan = planPagamento({ state: stateWithPii() });
    assert.ok(plan.merged.some((row) => row.message_id === "false_…8901@g.us_3EB0C0FFEEABCDEF0011_…2345@lid"));
    assert.equal(plan.validation.forgotten.length, 0);
  });

  it("linhas antigas (sem máscara) lidas da planilha não duplicam depois da máscara", () => {
    const state = stateWithPii();
    const legacy = buildRascunhoFromState(state).map((row) => ({ ...row, status: "novo" as const }));
    const existing = parseRascunhoGrid(rascunhoToValues(legacy).map((line) => line.map(String)));
    const plan = planPagamento({ state, existing });
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.merged.length, legacy.length);
    assert.doesNotMatch(JSON.stringify(rascunhoToValues(plan.merged)), LEAKS);
    // e uma segunda passada sobre a planilha já mascarada é estável
    const again = planPagamento({ state, existing: parseRascunhoGrid(rascunhoToValues(plan.merged).map((l) => l.map(String))) });
    assert.equal(again.toInsert.length, 0);
    assert.deepEqual(rascunhoToValues(again.merged), rascunhoToValues(plan.merged));
  });

  it("maskRascunhoRowPii é idempotente", () => {
    const rows = buildRascunhoFromState(stateWithPii()).map(maskRascunhoRowPii);
    assert.deepEqual(rows.map(maskRascunhoRowPii), rows);
  });

  it("parseBrl não lê pedaço mascarado como dinheiro", () => {
    assert.equal(parseBrl("pix …654321"), undefined);
    assert.equal(parseBrl("tel …4321 frete R$ 1.234,56"), 1234.56);
    assert.equal(parseBrl("cpf ***.***.***-25 valor 1500"), 1500);
    assert.equal(parseBrl("R$ 2.135,40"), 2135.4);
  });
});
