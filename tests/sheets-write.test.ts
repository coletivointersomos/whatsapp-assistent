import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import { signServiceAccountJwt } from "../src/sheets/googleJwt.ts";
import { rowsToValueRange } from "../src/sheets/googleSheets.ts";
import { SHEET_COLUMNS } from "../src/sheets/mapper.ts";
import { controleGroupsFromState, recordsForSheet, sheetRowsFromState, writeStateToGoogleSheet } from "../src/sheets/write.ts";
import { canWriteGoogleSheets, loadSheetsWriteConfig, sheetsWriteSkipReason } from "../src/sheets/config.ts";

describe("sheets google write", () => {
  it("does not write without spreadsheet id and credentials file", () => {
    const config = loadSheetsWriteConfig({
      SHEETS_SYNC_ENABLED: "true",
      SHEETS_SPREADSHEET_ID: "",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/missing-sa.json",
    });
    assert.equal(canWriteGoogleSheets(config), false);
    assert.equal(sheetsWriteSkipReason(config), "missing_spreadsheet_id");
  });

  it("signs a service-account JWT with three segments", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = signServiceAccountJwt({
      clientEmail: "bot@example.iam.gserviceaccount.com",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      nowMs: Date.parse("2026-09-17T20:00:00.000Z"),
    });
    assert.equal(jwt.split(".").length, 3);
  });

  it("puts the contract header first when building sheet values", () => {
    const state = seedState();
    state.messages.push({
      externalId: "m1",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista",
      sentAt: "2026-09-17T20:10:00.000Z",
      processedAt: "2026-09-17T20:10:00.000Z",
      type: "texto",
      text: "nova viagem",
    });
    state.records.push({
      id: "reg-m1",
      kind: "viagem",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["m1"],
      missing: [],
      viagem: { origin: "Curitiba", destination: "Nova Veneza", material: "arroz", quantity: 55, unit: "m³" },
    });
    const values = rowsToValueRange(sheetRowsFromState(state));
    assert.deepEqual(values[0], [...SHEET_COLUMNS]);
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("record_id")], "reg-m1");
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("codigo")], "VIAGEM001");
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("fluxo")], "entrada");
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("origem")], "Curitiba");
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("material")], "arroz");
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("quantidade")], "55");
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("unidade")], "m³");
  });

  it("builds a trip-control tab that answers destination and RECEBI", () => {
    const state = seedState();
    state.records.push({
      id: "reg-ctrl",
      kind: "viagem",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["m1"],
      missing: [],
      viagem: {
        date: "2026-09-08",
        origin: "Laranjeiras",
        destination: "Feira de Santana",
        material: "ureia",
        quantity: 47.7,
        unit: "toneladas",
        note: "5.724 RECEBI",
        freightTotal: 5724,
        vehicle: "TFA7A94",
      },
    });
    const groups = controleGroupsFromState(state);
    assert.equal(groups[0]?.tabName, "Caixa-TFA7A94-2026-09");
    assert.equal(groups[0]?.resumoTab, "Resumo-TFA7A94-2026-09");
    assert.equal(groups[0]?.rows[0]?.codigo, "VIAGEM001");
    assert.equal(groups[0]?.rows[0]?.fluxo, "entrada");
    assert.equal(groups[0]?.rows[0]?.recebido, "SIM");
    assert.equal(groups[0]?.rows[0]?.destino, "Feira de Santana");
    assert.equal(groups[0]?.rows[0]?.toneladas, "47.7");
    assert.equal(groups[0]?.rows[0]?.valor, "5724");
    assert.match(groups[0]?.rows[0]?.observacao ?? "", /5\.724/);
  });

  it("multiplies sacks times unit price into the valor column", () => {
    const state = seedState();
    state.records.push({
      id: "reg-sacks",
      kind: "viagem",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["m1"],
      missing: [],
      viagem: {
        date: "2026-09-29",
        origin: "Nova Soure",
        destination: "Lagarto",
        material: "milho",
        quantity: 53.75,
        unit: "toneladas",
        note: "3.586 = 896 SACOS A 4.00",
        freightTotal: 3586,
        vehicle: "TFA7A94",
      },
    });
    const row = controleGroupsFromState(state)[0]?.rows[0];
    assert.equal(row?.valor, "3584");
    assert.match(row?.observacao ?? "", /896 sacos × R\$ 4 = 3584/i);
  });

  it("puts expenses on the same month tab as red exits", () => {
    const state = seedState();
    state.records.push({
      id: "reg-in",
      kind: "viagem",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["m1"],
      missing: [],
      viagem: { date: "2026-09-08", origin: "Laranjeiras", destination: "Feira de Santana", vehicle: "TFA7A94" },
    });
    state.records.push({
      id: "reg-out",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["m2"],
      missing: [],
      despesa: { date: "2026-09-18", amountBrl: 100, description: "Borracharia", vehicle: "TFA7A94" },
    });
    const groups = controleGroupsFromState(state);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.rows.map((row) => row.fluxo).sort().join(","), "entrada,saida");
    assert.equal(groups[0]?.rows.find((row) => row.fluxo === "saida")?.codigo, "SAIDA001");
    assert.equal(groups[0]?.rows.find((row) => row.fluxo === "saida")?.observacao, "Borracharia");
  });

  it("keeps pre-session records off the Thursday sheet", () => {
    const state = seedState();
    state.messages.push({
      externalId: "old",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista",
      sentAt: "2026-09-01T12:00:00.000Z",
      processedAt: "2026-09-01T12:00:00.000Z",
      type: "texto",
      text: "viagem antiga",
    });
    state.records.push({
      id: "reg-old",
      kind: "viagem",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["old"],
      missing: [],
      viagem: { origin: "Recife", destination: "Salvador" },
    });
    state.messages.push({
      externalId: "new",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista",
      sentAt: "2026-09-17T20:10:00.000Z",
      processedAt: "2026-09-17T20:10:00.000Z",
      type: "texto",
      text: "nova viagem",
    });
    state.records.push({
      id: "reg-new",
      kind: "viagem",
      driverId: "motorista-joao",
      status: "completo",
      sourceMessageIds: ["new"],
      missing: [],
      viagem: { origin: "Curitiba", destination: "Nova Veneza" },
    });
    const rows = recordsForSheet(state, "2026-09-17T20:00:00.000Z");
    assert.deepEqual(rows.map((item) => item.id), ["reg-new"]);
  });

  it("writes header and rows through the Google API with a mocked fetch", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      calls.push(`${init?.method ?? "GET"} ${href}`);
      if (href.includes("oauth2.googleapis.com/token")) {
        assert.match(String(init?.body ?? ""), /urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
        assert.doesNotMatch(String(init?.body ?? ""), /oauth2%3Agrant-type/);
        return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
      }
      if (href.includes("/spreadsheets/") && !href.includes("/values") && !href.includes(":batchUpdate")) {
        return new Response(JSON.stringify({ sheets: [{ properties: { title: "Sheet1" } }] }), { status: 200 });
      }
      if (href.includes(":batchUpdate")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await writeStateToGoogleSheet({
      state: seedState(),
      config: {
        enabled: true,
        credentialsPath: "inline",
        spreadsheetId: "sheet123",
        tabName: "registros",
        tabMode: "fixed",
        appsScriptUrl: "",
        appsScriptToken: "",
      },
      account: {
        client_email: "bot@example.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      fetchImpl,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.rowCount, 0);
    assert.ok(calls.some((item) => item.includes("oauth2.googleapis.com/token")));
    assert.ok(calls.some((item) => item.includes("fields=sheets.properties.title") || item.includes("spreadsheets/sheet123")));
    assert.ok(calls.some((item) => item.includes(":batchUpdate")));
    assert.ok(calls.some((item) => item.includes(":clear")));
  });
});
