import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import { decideAdminAlert } from "../src/sheets/adminAlert.ts";
import { ALANA_SETEMBRO_PRINT, buildOficialSheet, oficialTabName, tripTotal } from "../src/sheets/oficial.ts";
import { planPagamento } from "../src/sheets/pagamento.ts";
import {
  buildRascunhoFromState,
  competenciaFromDoc,
  mergeRascunho,
  rascunhoFingerprint,
  rascunhoKey,
  type RascunhoRow,
} from "../src/sheets/rascunho.ts";
import { setembroManoelState } from "../src/sheets/setembroManoel.ts";
import { planGroupSweep } from "../src/sheets/sweep.ts";
import { alertsFromValidation, validateRascunho } from "../src/sheets/validate.ts";
import { writeSessionToSheet, writeStateToGoogleSheet } from "../src/sheets/write.ts";

describe("rascunho + folha oficial Manoel", () => {
  it("keeps competência on the document month, not the WhatsApp day", () => {
    assert.equal(competenciaFromDoc("2026-09-14", "2026-11-10T12:00:00.000Z"), "2026-09");
    const state = seedState();
    state.messages.push({
      externalId: "zap-nov",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista",
      sentAt: "2026-11-10T12:00:00.000Z",
      processedAt: "2026-11-10T12:00:00.000Z",
      type: "anexo_comprovante",
      text: "despesa setembro",
    });
    state.records.push({
      id: "desp-set",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["zap-nov"],
      missing: [],
      despesa: { date: "2026-09-14", amountBrl: 200, description: "Laudo atrasado", vehicle: "TFA7A94" },
    });
    const row = buildRascunhoFromState(state).find((item) => item.record_id === "desp-set");
    assert.equal(row?.enviado_em.startsWith("2026-11-10"), true);
    assert.equal(row?.data_doc, "2026-09-14");
    assert.equal(row?.competencia, "2026-09");
    assert.equal(row?.tipo, "despesa");
  });

  it("appends by record_id so one controle photo keeps all trips", () => {
    const state = setembroManoelState();
    const rows = buildRascunhoFromState(state);
    const trips = rows.filter((item) => item.tipo === "viagem");
    assert.equal(trips.length, 7);
    assert.equal(new Set(trips.map((item) => item.message_id)).size, 1);
    assert.equal(new Set(trips.map((item) => item.record_id)).size, 7);
    const again = mergeRascunho(rows, buildRascunhoFromState(state));
    assert.equal(again.toInsert.length, 0);
  });

  it("replays Manoel/setembro against Alana's print", () => {
    const plan = planPagamento({ state: setembroManoelState(), commissionRate: 0.11 });
    assert.equal(plan.oficialReady, true);
    assert.equal(plan.validation.forgotten.length, 0);
    const sheet = plan.oficial[0];
    assert.ok(sheet);
    assert.equal(sheet.tabName, "TFA-MANOEL-2026-09");
    assert.equal(oficialTabName("2026-09"), "TFA-MANOEL-2026-09");
    assert.equal(sheet.totals.tripCount, 7);
    assert.equal(sheet.totals.freight, ALANA_SETEMBRO_PRINT.freight);
    assert.equal(sheet.totals.diesel, ALANA_SETEMBRO_PRINT.diesel);
    assert.equal(sheet.totals.expenses, ALANA_SETEMBRO_PRINT.expenses);
    assert.equal(sheet.totals.net, ALANA_SETEMBRO_PRINT.net);
    const blob = sheet.values.map((row) => row.map(String).join(" ")).join("\n");
    assert.match(blob, /Luís Eduardo|Luis Eduardo/);
    assert.match(blob, /16\/09|2026-09-16/);
    assert.match(blob, /896 sacos × R\$ 4 = 3584/);
    const milho = plan.validation.promotable.find((row) => row.material === "milho");
    assert.equal(tripTotal(milho!), 3584);
  });

  it("does not promote duplicates or incomplete rows", () => {
    const state = seedState();
    state.drivers[0] = { id: "motorista-joao", name: "Manoel", vehicleHint: "TFA7A94" };
    state.messages.push(
      {
        externalId: "m-a",
        conversationId: "conv-joao",
        authorId: "motorista-joao",
        authorRole: "motorista",
        sentAt: "2026-09-08T12:00:00.000Z",
        processedAt: "2026-09-08T12:00:00.000Z",
        type: "anexo_comprovante",
        text: "viagem",
      },
      {
        externalId: "m-b",
        conversationId: "conv-joao",
        authorId: "motorista-joao",
        authorRole: "motorista",
        sentAt: "2026-09-08T12:05:00.000Z",
        processedAt: "2026-09-08T12:05:00.000Z",
        type: "anexo_comprovante",
        text: "viagem duplicada",
      },
      {
        externalId: "m-foto",
        conversationId: "conv-joao",
        authorId: "motorista-joao",
        authorRole: "motorista",
        sentAt: "2026-09-23T12:00:00.000Z",
        processedAt: "2026-09-23T12:00:00.000Z",
        type: "anexo_comprovante",
        text: "",
      },
    );
    const viagem = {
      date: "2026-09-08",
      origin: "Laranjeiras",
      destination: "Feira de Santana",
      material: "ureia",
      quantity: 47.7,
      unit: "toneladas",
      unitPrice: 120,
      freightTotal: 5724,
      motorista: "Manoel",
      vehicle: "TFA7A94",
    };
    state.records.push(
      {
        id: "dup-1",
        kind: "viagem",
        driverId: "motorista-joao",
        status: "completo",
        sourceMessageIds: ["m-a"],
        missing: [],
        viagem,
      },
      {
        id: "dup-2",
        kind: "viagem",
        driverId: "motorista-joao",
        status: "completo",
        sourceMessageIds: ["m-b"],
        missing: [],
        viagem,
      },
    );
    const plan = planPagamento({ state });
    assert.ok(plan.validation.duplicates.length >= 1);
    assert.ok(plan.validation.incomplete.length >= 1);
    const promotedDups = plan.validation.promotable.filter((row) => row.record_id === "dup-1" || row.record_id === "dup-2");
    assert.equal(promotedDups.length, 1);
    const incomplete = plan.merged.find((row) => row.message_id === "m-foto");
    assert.equal(incomplete?.status, "incompleto");
    assert.equal(incomplete?.tipo, "outro");
  });

  it("flags operational store messages missing from the rascunho as esquecido", () => {
    const state = setembroManoelState();
    const rows = buildRascunhoFromState(state).filter((row) => row.message_id !== "zap-laudo");
    const validation = validateRascunho({ state, rows });
    assert.ok(validation.forgotten.some((item) => item.messageId === "zap-laudo"));
    assert.equal(validation.clean, false);
    const blocked = planPagamento({ state: setembroManoelState(), existing: rows });
    assert.equal(blocked.oficialReady, true);
  });

  it("never sends admin alerts to the driver group", () => {
    const runtime = {
      liveSend: true,
      channel: { conversations: [{ conversationId: "grupo-motoristas@g.us" }] },
    };
    const group = decideAdminAlert({
      runtime,
      adminJid: "grupo-motoristas@g.us",
      text: "TFA setembro: foto 23/09 sem valor — conferir",
    });
    assert.equal(group.allowed, false);
    if (!group.allowed) assert.equal(group.reason, "admin_is_group");
    const pending = decideAdminAlert({
      runtime: { ...runtime, liveSend: false, channel: { conversations: [{ conversationId: "admin@c.us" }] } },
      adminJid: "admin@c.us",
      text: "TFA setembro: foto 23/09 sem valor — conferir",
    });
    assert.equal(pending.allowed, false);
    if (!pending.allowed) {
      assert.equal(pending.reason, "live_send_disabled");
      assert.equal(pending.pendingEvent, "admin_alert_pending");
    }
  });

  it("sweep marks gaps without talking in the group", () => {
    const state = seedState();
    state.messages.push({
      externalId: "buraco",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista",
      sentAt: "2026-09-23T12:00:00.000Z",
      processedAt: "2026-09-23T12:00:00.000Z",
      type: "anexo_comprovante",
      text: "",
    });
    const sweep = planGroupSweep({
      state: {
        ...state,
        drivers: [{ id: "motorista-joao", name: "Manoel", vehicleHint: "TFA7A94" }],
      },
    });
    assert.ok(sweep.validation.incomplete.length >= 1);
    assert.ok(sweep.alerts.some((text) => /TFA/.test(text) && /conferir/.test(text)));
    assert.doesNotMatch(sweep.alerts.join(" "), /@g\.us|@c\.us/);
  });

  it("writes rascunho append and official tab through mocked Google APIs", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      calls.push(`${init?.method ?? "GET"} ${href}`);
      if (href.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
      }
      if (href.includes("/values") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ values: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ sheets: [{ properties: { title: "Sheet1", sheetId: 1 } }] }), { status: 200 });
    }) as typeof fetch;
    const result = await writeStateToGoogleSheet({
      state: setembroManoelState(),
      config: {
        enabled: true,
        credentialsPath: "inline",
        spreadsheetId: "sheet123",
        tabName: "registros",
        tabMode: "vehicle_month",
        appsScriptUrl: "",
        appsScriptToken: "",
        rascunhoTabName: "Rascunho",
        commissionRate: 0.11,
        adminAlertJid: "",
        sweepIntervalMs: 0,
      },
      account: {
        client_email: "bot@example.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.ok(calls.some((item) => item.includes(":clear") || item.includes(":batchUpdate") || item.includes("/values/")));
    assert.ok(calls.some((item) => item.includes("TFA-MANOEL-2026-09") || item.includes("Rascunho")));
  });

  it("does not send vehicle_month pagamento to Apps Script even if the URL is set", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      calls.push(`${init?.method ?? "GET"} ${href}`);
      if (href.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
      }
      if (href.includes("/values") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ values: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ sheets: [{ properties: { title: "Sheet1", sheetId: 1 } }] }), { status: 200 });
    }) as typeof fetch;
    const result = await writeSessionToSheet({
      state: setembroManoelState(),
      config: {
        enabled: true,
        credentialsPath: "inline",
        spreadsheetId: "sheet123",
        tabName: "registros",
        tabMode: "vehicle_month",
        appsScriptUrl: "https://script.google.com/macros/s/abc/exec",
        appsScriptToken: "secret-token",
        rascunhoTabName: "Rascunho",
        commissionRate: 0.11,
        adminAlertJid: "",
        sweepIntervalMs: 0,
      },
      account: {
        client_email: "bot@example.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.some((item) => item.includes("script.google.com")), false);
    assert.ok(calls.some((item) => item.includes(":clear") || item.includes("/values/") || item.includes("TFA-MANOEL")));
  });
});

describe("oficial layout helpers", () => {
  it("builds the Alana header blocks", () => {
    const plan = planPagamento({ state: setembroManoelState() });
    const sheet = buildOficialSheet({ competencia: "2026-09", rows: plan.validation.promotable });
    assert.match(String(sheet.values[8]?.[0] ?? ""), /MOTORISTA TFA/);
    assert.match(String(sheet.values[8]?.[0] ?? ""), /SETEMBRO/);
    assert.equal(sheet.values[5]?.[0], "A PAGAR");
    assert.ok(sheet.values.some((row) => row.some((cell) => String(cell) === "=47.7" || String(cell) === "=47.61667")));
    assert.ok(sheet.fills.some((item) => item.color.red === 1 && item.startCol === 0));
    assert.ok(rascunhoKey(plan.merged[0]!));
  });

  it("drops João/CAMINHO1 from rascunho and still rewrites the official tab", () => {
    const state = setembroManoelState();
    state.drivers.push({ id: "motorista-lab", name: "João", vehicleHint: "CAMINHO1" });
    state.messages.push({
      externalId: "lab-joao",
      conversationId: "conv-lab",
      authorId: "motorista-lab",
      authorRole: "motorista",
      sentAt: "2026-09-10T12:00:00.000Z",
      processedAt: "2026-09-10T12:00:00.000Z",
      type: "anexo_comprovante",
      text: "viagem lab",
    });
    state.records.push({
      id: "lab-trip",
      kind: "viagem",
      driverId: "motorista-lab",
      status: "completo",
      sourceMessageIds: ["lab-joao"],
      missing: [],
      viagem: {
        date: "2026-09-10",
        origin: "Lab",
        destination: "Lab",
        material: "teste",
        quantity: 1,
        unit: "toneladas",
        unitPrice: 1,
        freightTotal: 1,
        motorista: "João",
        vehicle: "CAMINHO1",
      },
    });
    const plan = planPagamento({ state, commissionRate: 0.11 });
    assert.equal(plan.merged.some((row) => /jo[aã]o/i.test(row.motorista) || /CAMINHO1/i.test(row.placa)), false);
    assert.equal(plan.oficialReady, true);
    assert.equal(plan.oficial[0]?.totals.tripCount, 7);
  });

  it("collapses TFA7A54 OCR into the same fingerprint as TFA7A94", () => {
    const a = {
      competencia: "2026-09",
      tipo: "viagem" as const,
      data_doc: "2026-09-08",
      origem: "Laranjeiras",
      destino: "F. Santana",
      posto: "",
      valor: "5.724",
      descricao: "RECEBI",
      placa: "TFA7A54",
    };
    const b = { ...a, placa: "TFA7A94", valor: "5724" };
    assert.equal(rascunhoFingerprint(a), rascunhoFingerprint(b));
  });
});

function diesel(over: Partial<RascunhoRow>): RascunhoRow {
  const row: RascunhoRow = {
    message_id: "zap-1",
    enviado_em: "2026-10-08T12:00:00.000Z",
    data_doc: "2026-10-08",
    competencia: "2026-10",
    tipo: "abastecimento_vista",
    motorista: "Manoel",
    placa: "TFA7A94",
    origem: "",
    destino: "",
    material: "",
    toneladas: "",
    valor_unitario: "",
    valor: "350",
    posto: "Posto Alfa",
    descricao: "diesel",
    pagamento: "à vista",
    source: "foto",
    status: "novo",
    record_id: "abs-1",
    fingerprint: "",
    campos_brutos: "{}",
    arquivo_origem: "",
    ...over,
  };
  row.fingerprint = rascunhoFingerprint(row);
  return row;
}

describe("rascunho: mesmo valor no mesmo mês", () => {
  const first = diesel({});
  const statusOf = (rows: RascunhoRow[], id: string) => rows.find((row) => row.record_id === id)?.status;

  it("keeps exact fingerprint duplicates as duplicado", () => {
    const twin = diesel({ message_id: "zap-2", record_id: "abs-2", enviado_em: "2026-10-09T12:00:00.000Z" });
    const { merged } = mergeRascunho([first], [twin]);
    assert.equal(statusOf(merged, "abs-2"), "duplicado");
  });

  it("asks to confirm when the evidence is ambiguous, and blocks promotion until then", () => {
    const second = diesel({
      message_id: "zap-2",
      record_id: "abs-2",
      enviado_em: "2026-10-09T12:00:00.000Z",
      data_doc: "2026-10-09",
      descricao: "diesel cupom",
    });
    const { merged } = mergeRascunho([first], [second]);
    assert.equal(statusOf(merged, "abs-2"), "confirmar");
    const validation = validateRascunho({ state: seedState(), rows: merged });
    const issue = validation.sameValue.find((item) => item.recordId === "abs-2");
    assert.ok(issue);
    assert.match(issue.detail, /mesmo valor R\$ 350,00/);
    assert.match(issue.detail, /confirmar antes de registrar/);
    assert.equal(validation.promotable.some((row) => row.record_id === "abs-2"), false);
    assert.equal(validation.promotable.some((row) => row.record_id === "abs-1"), true);
    assert.ok(alertsFromValidation(validation, merged).some((text) => /outubro/.test(text) && /mesmo valor/.test(text)));
  });

  it("accepts as novo when the evidence shows two different expenses", () => {
    const danfe = mergeRascunho(
      [diesel({ descricao: "diesel DANFE 001234" })],
      [diesel({ message_id: "zap-2", record_id: "abs-2", data_doc: "2026-10-09", descricao: "diesel DANFE 5678" })],
    );
    assert.equal(statusOf(danfe.merged, "abs-2"), "novo");
    const postos = mergeRascunho([first], [diesel({ message_id: "zap-2", record_id: "abs-2", data_doc: "2026-10-20", posto: "Posto Beta" })]);
    assert.equal(statusOf(postos.merged, "abs-2"), "novo");
    const otherMonth = mergeRascunho(
      [first],
      [diesel({ message_id: "zap-2", record_id: "abs-2", data_doc: "2026-11-08", competencia: "2026-11", descricao: "diesel cupom" })],
    );
    assert.equal(statusOf(otherMonth.merged, "abs-2"), "novo");
    const otherValue = mergeRascunho(
      [diesel({ valor: "3500" })],
      [diesel({ message_id: "zap-2", record_id: "abs-2", data_doc: "2026-10-09", valor: "3666.9" })],
    );
    assert.equal(statusOf(otherValue.merged, "abs-2"), "novo");
  });

  it("treats the same document as duplicado even when the fingerprint differs", () => {
    const sameDanfe = mergeRascunho(
      [diesel({ descricao: "diesel DANFE 5678" })],
      [diesel({ message_id: "zap-2", record_id: "abs-2", valor: "350,00", descricao: "abastecimento NF 5.678" })],
    );
    assert.equal(statusOf(sameDanfe.merged, "abs-2"), "duplicado");
    const samePlace = mergeRascunho([first], [diesel({ message_id: "zap-2", record_id: "abs-2", descricao: "óleo diesel S10" })]);
    assert.equal(statusOf(samePlace.merged, "abs-2"), "duplicado");
  });

  it("re-checks confirmar rows on every merge until the evidence resolves them", () => {
    const peer = diesel({ descricao: "diesel DANFE 9999" });
    const pending = diesel({ message_id: "zap-2", record_id: "abs-2", data_doc: "2026-10-09", descricao: "diesel", status: "confirmar" });
    const still = mergeRascunho([peer, pending], [diesel({ message_id: "zap-2", record_id: "abs-2", data_doc: "2026-10-09" })]);
    assert.equal(statusOf(still.merged, "abs-2"), "confirmar");
    const different = mergeRascunho(
      [peer, pending],
      [diesel({ message_id: "zap-2", record_id: "abs-2", data_doc: "2026-10-09", descricao: "diesel DANFE 12345" })],
    );
    assert.equal(statusOf(different.merged, "abs-2"), "novo");
    assert.match(different.merged.find((row) => row.record_id === "abs-2")?.descricao ?? "", /12345/);
    const same = mergeRascunho(
      [peer, pending],
      [diesel({ message_id: "zap-2", record_id: "abs-2", data_doc: "2026-10-09", descricao: "diesel DANFE 9999" })],
    );
    assert.equal(statusOf(same.merged, "abs-2"), "duplicado");
    const peerIgnored = mergeRascunho([{ ...peer, status: "ignorado" }, pending], []);
    assert.equal(statusOf(peerIgnored.merged, "abs-2"), "novo");
  });

  it("respects a row a human set back to novo and promotes it", () => {
    const approved = diesel({ message_id: "zap-2", record_id: "abs-2", data_doc: "2026-10-09", descricao: "diesel cupom", status: "novo" });
    const { merged } = mergeRascunho([first, approved], [approved]);
    assert.equal(statusOf(merged, "abs-2"), "novo");
    const validation = validateRascunho({ state: seedState(), rows: merged });
    assert.equal(validation.sameValue.length, 0);
    assert.equal(validation.promotable.some((row) => row.record_id === "abs-2"), true);
  });

  it("does not flag trips with the same freight on different days", () => {
    const trip = (over: Partial<RascunhoRow>) =>
      diesel({ tipo: "viagem", posto: "", origem: "Laranjeiras", destino: "Feira de Santana", valor: "5724", descricao: "5.724 RECEBI", ...over });
    const { merged } = mergeRascunho([trip({})], [trip({ record_id: "trip-2", data_doc: "2026-10-12" })]);
    assert.equal(statusOf(merged, "trip-2"), "novo");
  });
});
