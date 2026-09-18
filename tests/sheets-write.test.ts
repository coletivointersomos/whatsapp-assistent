import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import { signServiceAccountJwt } from "../src/sheets/googleJwt.ts";
import { rowsToValueRange } from "../src/sheets/googleSheets.ts";
import { SHEET_COLUMNS } from "../src/sheets/mapper.ts";
import { recordsForSheet, sheetRowsFromState, writeStateToGoogleSheet } from "../src/sheets/write.ts";
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
    assert.equal(values[1]?.[0], "reg-m1");
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("origem")], "Curitiba");
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("material")], "arroz");
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("quantidade")], "55");
    assert.equal(values[1]?.[SHEET_COLUMNS.indexOf("unidade")], "m³");
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
