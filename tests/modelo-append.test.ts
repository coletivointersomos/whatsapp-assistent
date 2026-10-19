import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRIVE_TEST_FOLDER, loadDriveConfig } from "../src/drive/config.ts";
import {
  assertAppendOnly,
  cellDate,
  cellMoney,
  createAppendSheetsApi,
  findBlocks,
  loadAppendTarget,
  planAppend,
  runAppendExisting,
  type Grid,
} from "../src/sheets/appendExisting.ts";
import { loadModeloConfig } from "../src/sheets/modeloWriter.ts";
import type { RascunhoRow } from "../src/sheets/rascunho.ts";
import { fakeDrive } from "./fixtures/fakeDrive.ts";
import { setembroManoelState } from "./fixtures/setembroManoel.ts";

const TAB = "MANOEL ";

/** Layout da "TFA - Outubro 2026" lido em 19/10/2026 (valores sintéticos). */
function outubroGrid(): Grid {
  const g: Grid = Array.from({ length: 75 }, () => []);
  const set = (row: number, cells: string[]) => (g[row - 1] = cells);
  set(1, ["", "ACERTO MÊS ", "VALORES", "OBS"]);
  set(2, ["", "COMISSAO", "=J30", "nota"]);
  set(7, ["", "", "=C2-C3-C5", "A PAGAR "]);
  set(18, ["                      MOTORISTA TFA - OUTUBRO 26"]);
  set(20, ["VIAGENS"]);
  set(21, ["DATA", "ORIGEM", "DESTINO", "MATERIAL", "TONELADAS", "Colunas1", "VALOR", "TOTAL", "%", "Colunas2", "Colunas3"]);
  set(22, ["", "SEM VIAGENS INFORMADAS", "", "", "", "", "", "='MANOEL '!$F22*'MANOEL '!$G22", "", "=H22*I22", '=HYPERLINK("u","x")']);
  for (let r = 23; r <= 29; r += 1) set(r, ["", "", "", "", "", "", "", `='MANOEL '!$F${r}*'MANOEL '!$G${r}`, "", `=H${r}*I${r}`]);
  set(30, ["", "", "", "", "", "", "", "=SUBTOTAL(109,H22:H29)", "", "=SUBTOTAL(109,J22:J29)"]);
  set(31, ["ABASTECIMENTO À VISTA"]);
  set(32, ["DATA", "POSTO ", "CIDADE", "LITROS", "VALOR", "A VISTA", "OBS"]);
  const vista: Array<[number, string]> = [[46300, "500"], [46301, "2499.99"], [46303, "3500"], [46304, "3753"], [46310, "1963.42"], [46311, "1500.15"], [46311, "4878"]];
  vista.forEach(([d, v], i) => set(33 + i, [String(d), "POSTO", "CIDADE", "100", v, "", '=HYPERLINK("u","x")']));
  set(42, ["", "", "", "", "=SUBTOTAL(109,Tabela613[VALOR])"]);
  set(43, ["ABASTECIMENTO À PRAZO"]);
  set(44, ["DATA", "POSTO ", "CIDADE", "LITROS", "VALOR", "PRAZO", "OBS"]);
  set(45, ["", "", "", "", "", "", '=HYPERLINK("u","nenhum a prazo")']);
  set(46, ["", "", "", "", "=SUBTOTAL(109,E44:E45)"]);
  set(47, ["DESPESAS"]);
  set(48, ["DATA", "DESCRIÇÃO ", "VALOR ", "OBSERVAÇÃO"]);
  const desp: Array<[number, string]> = [[46300, "150"], [46302, "150"], [46302, "95"], [46310, "73.95"], [46311, "304"], [46312, "199.6"]];
  desp.forEach(([d, v], i) => set(49 + i, [String(d), "DESPESA", v, '=HYPERLINK("u","x")']));
  set(59, ["", "", "=SUBTOTAL(109,C49:C58)"]);
  set(61, ["DEPÓSITOS / PAGAMENTOS — OUT/2026"]);
  set(62, ["DATA", "DESCRIÇÃO ", "VALOR ", "OBSERVAÇÃO"]);
  set(63, ["46298", "REPASSE", "", "x"]);
  set(64, ["46300", "ADIANTAMENTO SET", "", "x"]);
  set(65, ["46312", "PIX", "", "x"]);
  set(66, ["", "", "=SUM(C63:C65)"]);
  set(68, ["ITENS A CONFIRMAR / PENDÊNCIAS — OUT/2026"]);
  set(69, ["DATA", "DESCRIÇÃO ", "VALOR ", "OBSERVAÇÃO"]);
  for (let r = 70; r <= 73; r += 1) set(r, ["46300", "PENDENCIA", "", "x"]);
  set(75, ["OBS:", "notas"]);
  return g;
}

function row(p: Partial<RascunhoRow>): RascunhoRow {
  return {
    message_id: "m", enviado_em: "2026-10-18T12:00:00Z", data_doc: "", competencia: "2026-10", tipo: "despesa", motorista: "Manoel", placa: "TFA7A94",
    origem: "", destino: "", material: "", toneladas: "", valor_unitario: "", valor: "", posto: "", descricao: "", pagamento: "", source: "", status: "novo",
    record_id: "r", fingerprint: "", campos_brutos: "", arquivo_origem: "", ...p,
  } as RascunhoRow;
}

const cells = (plan: ReturnType<typeof planAppend>) => plan.writes.map((w) => w.range.replace(`'${TAB}'!`, ""));

describe("planilha existente do mês — somente acrescentar", () => {
  it("acha os blocos pelos cabeçalhos que existem, sem pegar total nem separador", () => {
    const b = Object.fromEntries(findBlocks(outubroGrid()).map((x) => [x.kind, [x.firstRow, x.lastRow]]));
    assert.deepEqual(b, { viagens: [22, 29], vista: [33, 41], prazo: [45, 45], despesas: [49, 58], depositos: [63, 65], pendencias: [70, 73] });
    assert.equal(cellDate("46300"), "2026-10-05");
    assert.equal(cellDate("=DATE(2026,10,4)"), "2026-10-04");
    assert.equal(cellDate("05/10/2026"), "2026-10-05");
    assert.equal(cellMoney("R$ 1.234,56"), 1234.56);
    assert.equal(cellMoney("R$ 18,594.56"), 18594.56);
  });

  it("o que o Hermes tem hoje de outubro já está na planilha: não escreve nada", () => {
    const rows = [
      row({ tipo: "despesa", data_doc: "2026-10-05", valor: "150" }),
      row({ tipo: "despesa", data_doc: "2026-10-07", valor: "95" }),
      row({ tipo: "despesa", data_doc: "2026-10-08", valor: "3500" }), // mesmo valor está no à vista
      row({ tipo: "abastecimento_vista", data_doc: "2026-10-09", valor: "3666.9" }), // mesma data, valor diferente
    ];
    const pendentes = [row({ tipo: "abastecimento_prazo", status: "incompleto", data_doc: "2026-10-05" })];
    const plan = planAppend({ grid: outubroGrid(), tabTitle: TAB, rows, pendentes, today: "2026-10-19" });
    assert.equal(plan.writes.length, 0);
    assert.deepEqual(plan.skipped.map((s) => s.motivo), ["ja_lancado", "ja_lancado", "ja_lancado", "conflito_mesma_data", "ja_lancado"]);
  });

  it("item novo vai para a 1ª linha livre do bloco, só em células vazias, colunas pelo cabeçalho", () => {
    const rows = [
      row({ tipo: "despesa", data_doc: "2026-10-18", valor: "80", descricao: "Borracharia" }),
      row({ tipo: "abastecimento_vista", data_doc: "2026-10-18", valor: "1000", posto: "Posto X" }),
      row({ tipo: "viagem", data_doc: "2026-10-18", origem: "LEM", destino: "Cristópolis", material: "KCL", toneladas: "40", valor_unitario: "100" }),
    ];
    const grid = outubroGrid();
    const plan = planAppend({ grid, tabTitle: TAB, rows, today: "2026-10-19" });
    assert.deepEqual(cells(plan).sort(), ["A23", "A40", "A55", "B23", "B40", "B55", "C23", "C55", "D23", "D55", "E23", "E40", "F23", "G23", "G40", "I23", "K23"].sort());
    // nunca as fórmulas (H/J), nunca linhas ocupadas, nunca ACERTO MÊS/totais
    assert.ok(!cells(plan).some((c) => /^(H|J)\d+$/.test(c) || /^[A-K](2|7|30|42|46|59)$/.test(c)));
    assert.ok(plan.writes.every((w) => w.values.length === 1 && w.values[0]!.length === 1));
    assert.match(String(plan.writes.find((w) => w.range.endsWith("!D55"))!.values[0]![0]), /^\[Hermes 19\/10\] .*\[A CONFIRMAR\]/);
  });

  it("bloco cheio ou sem linha livre: não insere linha, item fica de fora", () => {
    const rows = [
      row({ tipo: "deposito", data_doc: "2026-10-18", valor: "200" }),
      row({ tipo: "abastecimento_prazo", data_doc: "2026-10-18", valor: "900" }),
      ...Array.from({ length: 6 }, (_, i) => row({ tipo: "despesa", data_doc: `2026-10-${20 + i}`, valor: String(10 + i), record_id: `d${i}` })),
    ];
    const pendentes = [row({ tipo: "outro", status: "incompleto", data_doc: "2026-10-18", valor: "5" })];
    const plan = planAppend({ grid: outubroGrid(), tabTitle: TAB, rows, pendentes, today: "2026-10-19" });
    const motivos = plan.skipped.map((s) => `${s.tipo}:${s.motivo}`);
    assert.ok(motivos.includes("deposito:sem_linha_livre"));
    assert.ok(motivos.includes("abastecimento_prazo:sem_linha_livre"));
    assert.ok(motivos.includes("outro:sem_linha_livre"));
    assert.equal(plan.appended.filter((a) => a.bloco === "despesas").length, 4); // linhas 55–58
    assert.equal(motivos.filter((m) => m === "despesa:sem_linha_livre").length, 2);
  });

  it("trava: escrever em célula ocupada ou fora da aba é recusado", () => {
    const grid = outubroGrid();
    assert.throws(() => assertAppendOnly(grid, TAB, [{ range: `'${TAB}'!E33`, values: [[1]] }]), /não está vazia/);
    assert.throws(() => assertAppendOnly(grid, TAB, [{ range: `'${TAB}'!H23`, values: [[1]] }]), /não está vazia/);
    assert.throws(() => assertAppendOnly(grid, TAB, [{ range: `'Conversa WhatsApp'!A68`, values: [["x"]] }]), /fora da aba/);
    assert.throws(() => assertAppendOnly(grid, TAB, [{ range: `'${TAB}'!A12`, values: [["x"]] }]), /fora dos blocos/);
    assert.throws(() => assertAppendOnly(grid, TAB, [{ range: `'${TAB}'!A55:B55`, values: [["x", "y"]] }]), /uma célula/);
  });

  it("config: só append_only com alvo existente; flags de Drive", () => {
    assert.equal(loadAppendTarget({}), undefined);
    assert.deepEqual(loadAppendTarget({ MODELO_TARGET_SPREADSHEET_ID: "abc" }), { spreadsheetId: "abc", mode: "append_only" });
    assert.throws(() => loadAppendTarget({ MODELO_TARGET_SPREADSHEET_ID: "abc", MODELO_WRITE_MODE: "overwrite" }), /append_only/);
    assert.equal(DRIVE_TEST_FOLDER, "_teste-hermes");
    assert.deepEqual(loadDriveConfig({ DRIVE_ENABLED: "true", DRIVE_CHAT_IDS: "1@g.us" }).chatIds, ["1@g.us"]);
  });

  it("API só faz GET e values:batchUpdate", async () => {
    const seen: string[] = [];
    const api = createAppendSheetsApi(async () => "t", (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${new URL(url).pathname}`);
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    await api.getMeta("id");
    await api.readGrid("id", "'MANOEL '!A1:Z10");
    await api.writeValues("id", []);
    assert.ok(seen.every((s) => s.startsWith("GET ") || s.endsWith("/values:batchUpdate")));
    assert.ok(!("insertRows" in api));
  });

  function fakeApi(title: string, grids: Grid[]) {
    const writes: Array<{ range: string }> = [];
    let reads = 0;
    return {
      writes,
      get reads() {
        return reads;
      },
      api: {
        async getMeta() {
          return { title, sheets: [{ sheetId: 1, title: TAB, rowCount: 1000, columnCount: 26 }, { sheetId: 2, title: "Conversa WhatsApp", rowCount: 1000, columnCount: 26 }] };
        },
        async readGrid() {
          return grids[Math.min(reads++, grids.length - 1)]!;
        },
        async writeValues(_id: string, data: Array<{ range: string }>) {
          writes.push(...data);
        },
      },
    };
  }

  it("run: recusa planilha de outro mês, Setembro e Modelo; desligado não chama nada", async () => {
    const config = { ...loadModeloConfig({ MODELO_SHEET_ENABLED: "true", GOOGLE_APPLICATION_CREDENTIALS: "/x" }), rootFolderId: "root" };
    const target = { spreadsheetId: "s", mode: "append_only" as const };
    for (const title of ["TFA - Setembro 2026", "Modelo", "TFA - Outubro 2026 (Hermes)"]) {
      const f = fakeApi(title, [outubroGrid()]);
      await assert.rejects(runAppendExisting({ state: setembroManoelState(), competencia: "2026-10", config, target, drive: fakeDrive().client, sheets: f.api }), /nada escrito/);
      assert.equal(f.writes.length, 0);
    }
    const off = fakeApi("TFA - Outubro 2026", [outubroGrid()]);
    const res = await runAppendExisting({ state: setembroManoelState(), competencia: "2026-10", config: loadModeloConfig({}), target, drive: fakeDrive().client, sheets: off.api });
    assert.equal(res.status, "disabled");
    assert.equal(off.reads, 0);
  });

  it("run: dry-run lê e não escreve; escrita relê antes e respeita o que foi preenchido no meio", async () => {
    const config = { ...loadModeloConfig({ MODELO_SHEET_ENABLED: "true", GOOGLE_APPLICATION_CREDENTIALS: "/x" }), rootFolderId: "root" };
    const target = { spreadsheetId: "s", mode: "append_only" as const };
    const state = setembroManoelState();
    const dry = fakeApi("TFA - Setembro 2026".replace("Setembro", "Outubro"), [outubroGrid()]);
    const d = await runAppendExisting({ state, competencia: "2026-10", config, target, dryRun: true, drive: fakeDrive().client, sheets: dry.api, today: "2026-10-19" });
    assert.equal(d.status, "dry_run");
    assert.equal(dry.writes.length, 0);
    const changed = outubroGrid();
    for (let r = 23; r <= 29; r += 1) changed[r - 1]![0] = "46315"; // Arnaldo preencheu as viagens no meio
    for (let r = 40; r <= 41; r += 1) changed[r - 1] = ["46315", "P", "", "", "1", "", "x"];
    for (let r = 55; r <= 58; r += 1) changed[r - 1] = ["46315", "D", "1", "x"];
    const live = fakeApi("TFA - Outubro 2026", [outubroGrid(), changed]);
    const w = await runAppendExisting({ state, competencia: "2026-10", config, target, drive: fakeDrive().client, sheets: live.api, today: "2026-10-19" });
    assert.equal(w.status, "written");
    assert.equal(live.writes.length, 0);
    assert.equal(live.reads, 2); // releu a planilha logo antes de escrever
  });
});
