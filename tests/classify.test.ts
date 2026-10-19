import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildAssistantV2SystemPrompt } from "../src/assistant-v2/prompt.ts";
import { loadMonitoredVehicle, setMonitoredVehicleForTest } from "../src/config/monitored.ts";
import type { AppState, OperationalRecord } from "../src/domain/types.ts";
import { classifyAbastecimento, classifyDespesa } from "../src/sheets/classify.ts";
import { normalizePlaca, sourceSentAt, tabForRecord } from "../src/sheets/mapper.ts";
import { buildOficialSheet } from "../src/sheets/oficial.ts";
import { planPagamento } from "../src/sheets/pagamento.ts";
import { buildRascunhoFromState, isMonitoredRow, mergeRascunho, type RascunhoRow } from "../src/sheets/rascunho.ts";
import { ALANA_SETEMBRO_PRINT, setembroManoelState } from "./fixtures/setembroManoel.ts";

function addMsg(state: AppState, externalId: string, sentAt: string, text = "comprovante"): void {
  state.messages.push({
    externalId,
    conversationId: "conv-joao",
    authorId: "motorista-joao",
    authorRole: "motorista",
    sentAt,
    processedAt: sentAt,
    type: "anexo_comprovante",
    text,
  });
}

function despesa(id: string, msgId: string, fields: NonNullable<OperationalRecord["despesa"]>): OperationalRecord {
  return { id, kind: "despesa", driverId: "motorista-joao", status: "completo", sourceMessageIds: [msgId], missing: [], despesa: fields };
}

afterEach(() => setMonitoredVehicleForTest(undefined));

describe("2c classificador", () => {
  it("classifies despesa families", () => {
    assert.equal(classifyDespesa("Adiantamento ao motorista"), "adiantamento");
    assert.equal(classifyDespesa("Pedágio BR-116"), "pedagio");
    assert.equal(classifyDespesa("Vale-pedágio"), "pedagio");
    assert.equal(classifyDespesa("Ticket de balança"), "balanca");
    assert.equal(classifyDespesa("Pesagem"), "balanca");
    assert.equal(classifyDespesa("Depositou saldo de frete"), "deposito");
    assert.equal(classifyDespesa("Cliente pagou frete na conta"), "deposito");
    assert.equal(classifyDespesa("Pagamento Pix acerto"), "pagamento");
    assert.equal(classifyDespesa("Pix para Arnaldo"), "pagamento");
    assert.equal(classifyDespesa("Pagamento", undefined, "pix"), "pagamento");
    // Pix só como forma de pagar um gasto continua despesa
    assert.equal(classifyDespesa("Borracharia", undefined, "pix"), "despesa");
    assert.equal(classifyDespesa("Borracharia pix"), "despesa");
    assert.equal(classifyDespesa("Laudo"), "despesa");
    assert.equal(classifyDespesa("DANFE 12345"), "despesa");
  });

  it("classifies abastecimento à vista / a prazo", () => {
    assert.equal(classifyAbastecimento("à vista"), "abastecimento_vista");
    assert.equal(classifyAbastecimento("a prazo"), "abastecimento_prazo");
    assert.equal(classifyAbastecimento("nota assinada"), "abastecimento_prazo");
    assert.equal(classifyAbastecimento("faturado"), "abastecimento_prazo");
    assert.equal(classifyAbastecimento("não pago"), "abastecimento_prazo");
    assert.equal(classifyAbastecimento("NOTA PAGA"), "abastecimento_vista");
    assert.equal(classifyAbastecimento(undefined, "diesel a prazo"), "abastecimento_prazo");
    assert.equal(classifyAbastecimento(undefined, undefined), "abastecimento_vista");
  });

  it("keeps the September totals with the new types (pedágio counted in DESPESAS)", () => {
    const plan = planPagamento({ state: setembroManoelState(), commissionRate: 0.11 });
    const sheet = plan.oficial.find((item) => item.tabName.endsWith("2026-09"));
    assert.ok(sheet);
    assert.equal(sheet.totals.freight, ALANA_SETEMBRO_PRINT.freight);
    assert.equal(sheet.totals.diesel, ALANA_SETEMBRO_PRINT.diesel);
    assert.equal(sheet.totals.expenses, ALANA_SETEMBRO_PRINT.expenses);
    assert.equal(sheet.totals.net, ALANA_SETEMBRO_PRINT.net);
    assert.equal(sheet.tabName, "TFA-MANOEL-2026-09");
    assert.ok(plan.merged.some((row) => row.tipo === "pedagio"));
  });

  it("puts adiantamento, pagamento Pix and balança in the right blocks", () => {
    const state = setembroManoelState();
    addMsg(state, "zap-adiant", "2026-09-05T12:00:00.000Z");
    addMsg(state, "zap-pix", "2026-09-30T12:00:00.000Z");
    addMsg(state, "zap-balanca", "2026-09-24T12:00:00.000Z");
    state.records.push(
      despesa("r-adiant", "zap-adiant", { date: "2026-09-05", amountBrl: 1100, description: "Adiantamento", vehicle: "TFA7A94" }),
      despesa("r-pix", "zap-pix", { date: "2026-09-30", amountBrl: 2000, description: "Pagamento Pix acerto", payment: "pix", vehicle: "TFA7A94" }),
      despesa("r-balanca", "zap-balanca", { date: "2026-09-24", amountBrl: 30, description: "Balança", vehicle: "TFA7A94" }),
    );
    const plan = planPagamento({ state, commissionRate: 0.11 });
    const tipos = Object.fromEntries(plan.merged.map((row) => [row.record_id, row.tipo]));
    assert.equal(tipos["r-adiant"], "adiantamento");
    assert.equal(tipos["r-pix"], "pagamento");
    assert.equal(tipos["r-balanca"], "balanca");
    const sheet = plan.oficial.find((item) => item.tabName.endsWith("2026-09"));
    assert.ok(sheet);
    assert.equal(sheet.totals.expenses, ALANA_SETEMBRO_PRINT.expenses + 30);
    assert.equal(sheet.totals.deposits, 2000);
    assert.equal(sheet.values[3]?.[1], "=1100");
    assert.equal(sheet.totals.freight, ALANA_SETEMBRO_PRINT.freight);
  });

  it("leaves other plates (SCF 4D04) out, even with the driver's name", () => {
    const base = { motorista: "Manoel", placa: "" };
    assert.equal(isMonitoredRow({ ...base, placa: "TFA7A94" }), true);
    assert.equal(isMonitoredRow({ ...base, placa: "TFA 7A54" }), true);
    assert.equal(isMonitoredRow({ ...base, placa: "SCF4D04" }), false);
    assert.equal(isMonitoredRow({ ...base, placa: "SCF 4D04" }), false);
    assert.equal(isMonitoredRow({ ...base, descricao: "Diesel SCF 4D04" }), false);
    assert.equal(isMonitoredRow({ ...base, descricao: "Diesel" }), true);
    assert.equal(isMonitoredRow({ ...base, descricao: "NFE 1234 diesel" }), true);
    assert.equal(isMonitoredRow({ motorista: "Outro", placa: "", descricao: "pedágio TFA7A94" }), true);
    const state = setembroManoelState();
    addMsg(state, "zap-scf", "2026-09-13T12:00:00.000Z");
    state.records.push({
      id: "r-scf",
      kind: "abastecimento",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["zap-scf"],
      missing: [],
      abastecimento: { date: "2026-09-13", totalBrl: 999, payment: "à vista", vehicle: "SCF4D04" },
    });
    const plan = planPagamento({ state, commissionRate: 0.11 });
    assert.equal(plan.merged.some((row) => row.record_id === "r-scf"), false);
    assert.equal(plan.oficial[0]?.totals.diesel, ALANA_SETEMBRO_PRINT.diesel);
  });

  it("takes the month from the fact date, then from the source message (BRT), never the clock first", () => {
    const state = setembroManoelState();
    addMsg(state, "zap-late", "2026-10-01T01:30:00.000Z"); // 30/09 22:30 em Brasília
    const noDate = despesa("r-late", "zap-late", { amountBrl: 50, description: "Laudo", vehicle: "TFA7A94" });
    const dated = despesa("r-dated", "zap-late", { date: "2026-08-31", amountBrl: 50, description: "Laudo", vehicle: "TFA7A94" });
    const clock = new Date("2026-12-15T12:00:00.000Z");
    assert.equal(sourceSentAt(state, noDate), "2026-09-30");
    assert.equal(tabForRecord(noDate, clock, sourceSentAt(state, noDate)), "Caixa-TFA7A94-2026-09");
    assert.equal(tabForRecord(dated, clock, sourceSentAt(state, dated)), "Caixa-TFA7A94-2026-08");
    assert.equal(tabForRecord(noDate, clock), "Caixa-TFA7A94-2026-12");
    state.records.push({ ...dated, id: "r-dated-2", sourceMessageIds: ["zap-late"] });
    const row = buildRascunhoFromState(state).find((item) => item.record_id === "r-dated-2");
    assert.equal(row?.competencia, "2026-08");
  });

  it("does not duplicate: same pedágio twice, and a legacy 'despesa' row of the same pedágio", () => {
    const state = setembroManoelState();
    addMsg(state, "zap-ped-a", "2026-09-26T12:00:00.000Z");
    addMsg(state, "zap-ped-b", "2026-09-26T12:05:00.000Z");
    const fields = { date: "2026-09-26", amountBrl: 47.9, description: "Pedágio", place: "Praça 1", vehicle: "TFA7A94" };
    state.records.push(despesa("r-ped-a", "zap-ped-a", fields), despesa("r-ped-b", "zap-ped-b", fields));
    const plan = planPagamento({ state, commissionRate: 0.11 });
    const a = plan.merged.find((row) => row.record_id === "r-ped-a");
    const b = plan.merged.find((row) => row.record_id === "r-ped-b");
    assert.equal(a?.tipo, "pedagio");
    assert.equal(a?.fingerprint, b?.fingerprint);
    assert.equal([a?.status, b?.status].filter((s) => s === "duplicado").length, 1);
    assert.equal(plan.oficial[0]?.totals.expenses, ALANA_SETEMBRO_PRINT.expenses + 47.9);

    // linha já gravada antes do 2c com tipo "despesa" (mesmo pedágio, outra mensagem)
    const legacy: RascunhoRow = { ...(a as RascunhoRow), tipo: "despesa", record_id: "old-ped", message_id: "zap-old" };
    const merged = mergeRascunho([legacy], [a as RascunhoRow]);
    assert.equal(merged.toInsert[0]?.status, "duplicado");
  });

  it("generalizes plate/driver via env and drops fixed September from the prompt", () => {
    const prompt = buildAssistantV2SystemPrompt({ today: new Date("2026-10-19T12:00:00.000Z") });
    assert.doesNotMatch(prompt, /2026-09/);
    assert.match(prompt, /Placa TFA7A94 \(não 7A54\)/);
    assert.match(prompt, /"date":"2026-10-19"/);
    const other = loadMonitoredVehicle({ MONITORED_PLATE: "abc-1d23", MONITORED_DRIVER: "José" });
    assert.deepEqual(other, { plate: "ABC1D23", driver: "José", ocrAliases: [] });
    setMonitoredVehicleForTest(other);
    assert.equal(normalizePlaca("TFA7A54"), "TFA7A54");
    assert.equal(normalizePlaca("ABC1D28", "ABC1D23"), "ABC1D23");
    assert.equal(isMonitoredRow({ motorista: "Manoel", placa: "TFA7A94" }), false);
    assert.equal(isMonitoredRow({ motorista: "José", placa: "" }), true);
    const sheet = buildOficialSheet({ competencia: "2026-10", rows: [] });
    assert.equal(sheet.tabName, "ABC-JOSE-2026-10");
    assert.match(buildAssistantV2SystemPrompt(), /Placa ABC1D23\. Motorista do papel \(José\)/);
  });
});
