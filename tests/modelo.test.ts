import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOLDER_MIME } from "../src/drive/googleDrive.ts";
import { buildModeloFill, safeText } from "../src/sheets/modelo.ts";
import { hermesCopyName, loadModeloConfig, rowsForModelo, runModeloFill } from "../src/sheets/modeloWriter.ts";
import type { RascunhoRow } from "../src/sheets/rascunho.ts";
import { fakeDrive } from "./fixtures/fakeDrive.ts";
import { ALANA_SETEMBRO_PRINT, setembroManoelState } from "./fixtures/setembroManoel.ts";

const SHEET = "application/vnd.google-apps.spreadsheet";
const ROOT = "root";

function cell(fill: ReturnType<typeof buildModeloFill>, a1: string): string | number | undefined {
  const m = /^([A-Z])(\d+)$/.exec(a1)!;
  for (const w of fill.writes) {
    const r = /!([A-Z])(\d+)(?::([A-Z])(\d+))?$/.exec(w.range)!;
    const c0 = r[1]!.charCodeAt(0);
    const r0 = Number(r[2]);
    const c = m[1]!.charCodeAt(0) - c0;
    const rr = Number(m[2]) - r0;
    if (rr >= 0 && c >= 0 && rr < w.values.length && c < (w.values[rr]?.length ?? 0)) return w.values[rr]![c];
  }
  return undefined;
}

function fakeSheets(titles: string[]) {
  const writes: Array<{ id: string; range: string }> = [];
  const inserts: Array<{ id: string; beforeRow: number; count: number }> = [];
  return {
    writes,
    inserts,
    api: {
      async getSheets() {
        return titles.map((title, i) => ({ sheetId: i + 1, title }));
      },
      async readCell() {
        return "                      MOTORISTA TFA - ";
      },
      async insertRows(id: string, _sheetId: number, beforeRow: number, count: number) {
        inserts.push({ id, beforeRow, count });
      },
      async writeValues(id: string, data: Array<{ range: string }>) {
        for (const d of data) writes.push({ id, range: d.range });
      },
    },
  };
}

describe("2e Modelo (cópia + aba MANOEL)", () => {
  it("fills September in the Modelo layout with the Alana totals and the formulas of the SKILL", () => {
    const { rows, pendentes } = rowsForModelo(setembroManoelState(), "2026-09");
    const fill = buildModeloFill({ competencia: "2026-09", rows, pendentes, today: "2026-10-19" });
    assert.equal(fill.summary.totals.frete, ALANA_SETEMBRO_PRINT.freight);
    assert.equal(fill.summary.totals.diesel, ALANA_SETEMBRO_PRINT.diesel);
    assert.equal(fill.summary.totals.despesas, ALANA_SETEMBRO_PRINT.expenses);
    assert.equal(fill.summary.viagens, 7);
    assert.deepEqual(fill.inserts, []);
    assert.equal(cell(fill, "A18"), "                      MOTORISTA TFA - SETEMBRO 26");
    assert.equal(cell(fill, "A19"), "TFA 7A94 - MANOEL");
    assert.equal(cell(fill, "C2"), "=J30");
    assert.equal(cell(fill, "C7"), "=C2-C3-C4-C5");
    assert.equal(cell(fill, "I4"), "=H30");
    assert.equal(cell(fill, "I5"), "=E42+E46");
    assert.equal(cell(fill, "I6"), "=C59");
    assert.equal(cell(fill, "H30"), "=SUBTOTAL(109,H22:H29)");
    assert.equal(cell(fill, "E46"), "=SUBTOTAL(109,E44:E45)");
    assert.equal(cell(fill, "E42"), "=SUBTOTAL(109,Tabela613[VALOR])");
    assert.equal(cell(fill, "A22"), "=DATE(2026,9,8)");
    assert.equal(cell(fill, "E22"), 47700);
    assert.equal(cell(fill, "F22"), 47.7);
    assert.equal(cell(fill, "G22"), 120);
    assert.equal(cell(fill, "H22"), "=F22*G22");
    // frete por saco: G vazio, H = valor, conta na observação
    const sackRow = [22, 23, 24, 25, 26, 27, 28].find((r) => String(cell(fill, `K${r}`)).includes("896 sacos"));
    assert.ok(sackRow);
    assert.equal(cell(fill, `G${sackRow}`), "");
    assert.equal(cell(fill, `H${sackRow}`), 3584);
    // sem link no Drive → [A CONFIRMAR]
    assert.match(String(cell(fill, "K22")), /\[A CONFIRMAR\]/);
    assert.equal(cell(fill, "F45"), "[A CONFIRMAR]");
    assert.ok(fill.writes.every((w) => w.range.startsWith("'MANOEL '!")));
  });

  it("inserts rows inside the block when it overflows and moves the totals", () => {
    const base = rowsForModelo(setembroManoelState(), "2026-09").rows.find((r) => r.tipo === "viagem")!;
    const many: RascunhoRow[] = Array.from({ length: 12 }, (_, i) => ({ ...base, record_id: `v${i}`, data_doc: `2026-09-${String(i + 1).padStart(2, "0")}` }));
    const fill = buildModeloFill({ competencia: "2026-09", rows: many, today: "2026-10-19" });
    assert.deepEqual(fill.inserts, [{ beforeRow: 23, count: 4 }]);
    assert.equal(cell(fill, "H34"), "=SUBTOTAL(109,H22:H33)");
    assert.equal(cell(fill, "C2"), "=J34");
    assert.equal(cell(fill, "I5"), "=E46+E50");
    assert.equal(cell(fill, "I6"), "=C63");
  });

  it("puts links as HYPERLINK and never lets message text become a formula", () => {
    assert.equal(safeText("=IMPORTXML(1)"), "'=IMPORTXML(1)");
    assert.equal(safeText("+5"), "'+5");
    const row = rowsForModelo(setembroManoelState(), "2026-09").rows.find((r) => r.tipo === "despesa")!;
    const fill = buildModeloFill({ competencia: "2026-09", rows: [{ ...row, descricao: '=HACK("x")' }], today: "2026-10-19", linkFor: () => ({ url: "https://drive.google.com/file/d/abc/view", fileLabel: "2026-09-18 080000-deadbeef" }) });
    assert.equal(cell(fill, "B49"), "'=HACK(\"X\")");
    assert.equal(cell(fill, "D49"), '=HYPERLINK("https://drive.google.com/file/d/abc/view","\'=HACK(""x"") (2026-09-18 080000-deadbeef — link)")');
  });

  it("disabled flag: no Drive/Sheets call at all", async () => {
    const d = fakeDrive();
    const s = fakeSheets(["MANOEL "]);
    const res = await runModeloFill({ state: setembroManoelState(), competencia: "2026-10", config: loadModeloConfig({}), drive: d.client, sheets: s.api });
    assert.equal(res.status, "disabled");
    assert.equal(d.calls.length, 0);
    assert.equal(s.writes.length, 0);
    assert.equal(hermesCopyName("2026-10"), "TFA - Outubro 2026 (Hermes)");
  });

  it("enabled: copies Modelo into the month folder as '(Hermes)', writes only its MANOEL tab, never the protected sheets", async () => {
    const d = fakeDrive([
      { id: "modelo", name: "Modelo", mimeType: SHEET, parents: [ROOT] },
      { id: "m10", name: "2026-10 Outubro", mimeType: FOLDER_MIME, parents: [ROOT] },
      { id: "out", name: "TFA - Outubro 2026", mimeType: SHEET, parents: ["m10"] },
    ]);
    const s = fakeSheets(["MANOEL ", "JOAO RAFAEL  ", "FABIO"]);
    const config = { ...loadModeloConfig({ MODELO_SHEET_ENABLED: "true", GOOGLE_APPLICATION_CREDENTIALS: "/x" }), rootFolderId: ROOT };
    const res = await runModeloFill({ state: setembroManoelState(), competencia: "2026-10", config, drive: d.client, sheets: s.api, today: "2026-10-19" });
    assert.equal(res.status, "written");
    assert.equal(res.copied, true);
    const copy = [...d.files.values()].find((f) => f.name === "TFA - Outubro 2026 (Hermes)")!;
    assert.deepEqual(copy.parents, ["m10"]);
    assert.ok(s.writes.length > 0);
    assert.ok(s.writes.every((w) => w.id === copy.id && w.range.startsWith("'MANOEL '!")));
    assert.ok(!s.writes.some((w) => w.id === "out" || w.id === "modelo"));
    assert.equal(d.files.get("out")!.name, "TFA - Outubro 2026");
    assert.equal(d.files.get("modelo")!.name, "Modelo");
    // segunda execução reusa a cópia (não cria outra)
    await runModeloFill({ state: setembroManoelState(), competencia: "2026-10", config, drive: d.client, sheets: s.api, today: "2026-10-19" });
    assert.equal([...d.files.values()].filter((f) => f.name === "TFA - Outubro 2026 (Hermes)").length, 1);
    assert.ok(d.calls.every((c) => c.method === "GET" || c.method === "POST"));
  });
});
