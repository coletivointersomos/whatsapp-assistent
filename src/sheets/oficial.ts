import type { CellFill } from "./googleSheets.ts";
import { parseSacosFreight } from "./mapper.ts";
import type { RascunhoRow } from "./rascunho.ts";

export const ALANA_SETEMBRO_PRINT = {
  competencia: "2026-09",
  freight: 54148,
  diesel: 25619.6,
  expenses: 4974,
  net: 23554.4,
  commissionRate: 0.11,
};

const YELLOW = { red: 1, green: 0.95, blue: 0.55 };
const GREEN = { red: 0.78, green: 0.9, blue: 0.78 };
const RED = { red: 0.96, green: 0.8, blue: 0.8 };
const HEADER = { red: 0.9, green: 0.9, blue: 0.9 };
const BLUE = { red: 0.82, green: 0.88, blue: 0.96 };

export type OficialSheet = {
  tabName: string;
  values: Array<Array<string | number>>;
  fills: CellFill[];
  totals: {
    freight: number;
    diesel: number;
    expenses: number;
    deposits: number;
    net: number;
    commission: number;
    tripCount: number;
  };
};

const MONTHS_PT = [
  "JANEIRO",
  "FEVEREIRO",
  "MARÇO",
  "ABRIL",
  "MAIO",
  "JUNHO",
  "JULHO",
  "AGOSTO",
  "SETEMBRO",
  "OUTUBRO",
  "NOVEMBRO",
  "DEZEMBRO",
];

export function oficialTabName(competencia: string, motorista = "MANOEL"): string {
  const slug = motorista
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .toUpperCase()
    .slice(0, 16) || "MANOEL";
  return `TFA-${slug}-${competencia}`;
}

export function monthLabel(competencia: string): string {
  const month = Number(competencia.slice(5, 7));
  const year = competencia.slice(2, 4);
  const name = MONTHS_PT[month - 1] ?? competencia;
  return `${name} ${year}`;
}

export function asNumber(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === undefined || value === "") return 0;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Formula so pt-BR Sheets does not turn 47.7 / 5724 into a date. */
export function sheetNum(value: string | number | undefined): string | "" {
  if (value === undefined || value === "") return "";
  const n = typeof value === "number" ? value : asNumber(value);
  if (!Number.isFinite(n)) return "";
  return `=${n}`;
}

export function tripUnitPrice(row: RascunhoRow): number {
  const given = asNumber(row.valor_unitario);
  if (given > 0) return given;
  if (parseSacosFreight(row.descricao)) return 0;
  const tons = asNumber(row.toneladas);
  const valor = asNumber(row.valor);
  if (tons > 0 && valor > 0 && valor >= 50) return Math.round((valor / tons) * 100) / 100;
  if (tons > 0 && valor > 0 && valor < 50) return valor;
  const dest = `${row.destino} ${row.origem} ${row.material}`.toLowerCase();
  if (/luis eduardo|luís eduardo/.test(dest)) return 200;
  if (/sorgo|natividade|concei/.test(dest)) return 300;
  if (/feira|santana/.test(dest)) return 120;
  return 0;
}

export function tripTotal(row: RascunhoRow): number {
  const sack = parseSacosFreight(row.descricao);
  if (sack) return sack.total;
  const rate = tripUnitPrice(row);
  const tons = asNumber(row.toneladas);
  if (rate > 0 && tons > 0) return Math.round(tons * rate * 100) / 100;
  return asNumber(row.valor);
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

function fill(startRow: number, endRow: number, startCol: number, endCol: number, color: CellFill["color"]): CellFill {
  return { startRow, endRow, startCol, endCol, color };
}

export function buildOficialSheet(input: {
  competencia: string;
  rows: RascunhoRow[];
  commissionRate?: number;
  motorista?: string;
  placa?: string;
}): OficialSheet {
  const rate = input.commissionRate ?? 0.11;
  const trips = input.rows.filter((row) => row.tipo === "viagem").sort((a, b) => a.data_doc.localeCompare(b.data_doc));
  const vista = input.rows.filter((row) => row.tipo === "abastecimento_vista");
  const prazo = input.rows.filter((row) => row.tipo === "abastecimento_prazo");
  const despesas = input.rows.filter((row) => row.tipo === "despesa");
  const deposits = input.rows.filter((row) => row.tipo === "deposito");
  const motorista = input.motorista ?? trips[0]?.motorista ?? "Manoel";
  const placa = input.placa ?? trips[0]?.placa ?? "TFA7A94";

  const freight = money(trips.reduce((sum, row) => sum + tripTotal(row), 0));
  const diesel = money(
    [...vista, ...prazo].reduce((sum, row) => sum + asNumber(row.valor), 0),
  );
  const expenseTotal = money(despesas.reduce((sum, row) => sum + asNumber(row.valor), 0));
  const depositTotal = money(deposits.reduce((sum, row) => sum + asNumber(row.valor), 0));
  const net = money(freight - diesel - expenseTotal);
  const commission = money(freight * rate);

  const values: Array<Array<string | number>> = [];
  const pushes = (row: Array<string | number>) => {
    values.push(row);
  };

  // Left: pagamento. Right: depósitos + totais. Numbers as =n so locale cannot date-parse.
  pushes(["COMISSÃO", "", "", "", "", "", "DEPOSITOU EM CONTA", "", "", "RECEBEU DE FRETE", ""]);
  pushes(["INSS+IRRF", sheetNum(0), "", "", "", "", "DATA", "VALOR"]);
  pushes(["VALE", sheetNum(0)]);
  pushes(["ADIANTAMENTO", sheetNum(0)]);
  pushes([]);
  pushes(["A PAGAR", "", "", "", "", "", "", "", "", "ABASTECEU", ""]);
  pushes(["", "", "", "", "", "", "", "", "", "DESPESAS", ""]);
  pushes(["", "", "", "", "", "", "", "", "", "LÍQUIDO", ""]);
  pushes(["", "", "", "", "", "", "", "", "", "ainda com o Sr. Manoel", ""]);
  pushes([]);
  pushes([`MOTORISTA TFA — ${monthLabel(input.competencia)}`, "", "", motorista, placa]);
  pushes(["VIAGENS"]);
  pushes(["DATA", "ORIGEM", "DESTINO", "MATERIAL", "TONELADAS", "t", "VALOR", "TOTAL", "%", "COMISSÃO", "OBS"]);

  const tripHeaderRow = values.length;
  for (const row of trips) {
    const sheetRow = values.length + 1;
    const rateN = tripUnitPrice(row);
    const sack = parseSacosFreight(row.descricao);
    const tons = asNumber(row.toneladas);
    pushes([
      row.data_doc,
      row.origem,
      row.destino,
      row.material,
      tons ? sheetNum(tons) : "",
      tons ? sheetNum(tons) : "",
      sack ? sheetNum(sack.unitPrice) : rateN ? sheetNum(rateN) : "",
      sack ? sheetNum(sack.total) : `=ROUND(N(E${sheetRow})*N(G${sheetRow}),2)`,
      `${Math.round(rate * 100)}%`,
      `=ROUND(H${sheetRow}*${rate},2)`,
      sack
        ? `${sack.sacos} sacos × R$ ${sack.unitPrice} = ${sack.total}${asNumber(row.valor) && asNumber(row.valor) !== sack.total ? ` (papel ${row.valor})` : ""}`
        : row.descricao,
    ]);
  }
  const tripStart = tripHeaderRow + 1;
  const tripEnd = values.length;
  const freightFormula = tripEnd >= tripStart ? `=SUM(H${tripStart}:H${tripEnd})` : sheetNum(0);
  const commissionFormula = tripEnd >= tripStart ? `=ROUND(SUM(J${tripStart}:J${tripEnd}),2)` : sheetNum(0);

  pushes([]);
  pushes(["ABASTECIMENTO À VISTA"]);
  pushes(["DATA", "POSTO", "LITROS", "VALOR", "A VISTA", "OBS"]);
  const vistaStart = values.length + 1;
  for (const row of vista) {
    pushes([row.data_doc, row.posto || row.descricao, "", sheetNum(row.valor), "à vista", ""]);
  }
  if (vista.length === 0) pushes(["", "", "", sheetNum(0), "", ""]);
  const vistaEnd = values.length;

  pushes([]);
  pushes(["ABASTECIMENTO A PRAZO"]);
  pushes(["DATA", "POSTO", "LITROS", "VALOR", "PRAZO", "OBS"]);
  const prazoStart = values.length + 1;
  for (const row of prazo) {
    pushes([row.data_doc, row.posto || row.descricao, "", sheetNum(row.valor), "a prazo", ""]);
  }
  if (prazo.length === 0) pushes(["", "", "", sheetNum(0), "", ""]);
  const prazoEnd = values.length;

  pushes([]);
  pushes(["DESPESAS"]);
  pushes(["DATA", "DESCRIÇÃO", "VALOR", "OBSERVAÇÃO"]);
  const despStart = values.length + 1;
  for (const row of despesas) {
    pushes([row.data_doc, row.descricao, sheetNum(row.valor), ""]);
  }
  if (despesas.length === 0) pushes(["", "", sheetNum(0), ""]);
  const despEnd = values.length;

  const dieselFormula = `=SUM(D${vistaStart}:D${vistaEnd})+SUM(D${prazoStart}:D${prazoEnd})`;
  const expenseFormula = `=SUM(C${despStart}:C${despEnd})`;

  values[0][1] = commissionFormula;
  values[0][10] = freightFormula;
  values[5][1] = "=ROUND(B1-B2-B3-B4,2)";
  values[5][10] = dieselFormula;
  values[6][10] = expenseFormula;
  values[7][10] = "=ROUND(K1-K6-K7,2)";
  deposits.forEach((row, index) => {
    while (values.length <= 2 + index) values.push([]);
    values[2 + index][6] = row.data_doc;
    values[2 + index][7] = sheetNum(row.valor);
  });
  const lastDepositRow = deposits.length ? 2 + deposits.length : 0;
  values[8][10] = lastDepositRow ? `=ROUND(K8-SUM(H3:H${lastDepositRow}),2)` : "=K8";

  const fills: CellFill[] = [
    fill(0, 5, 0, 2, HEADER),
    fill(5, 6, 0, 2, YELLOW),
    fill(0, 2, 6, 8, BLUE),
    fill(0, 9, 9, 11, BLUE),
    fill(10, 13, 0, 11, GREEN),
  ];
  if (vistaEnd >= vistaStart) fills.push(fill(vistaStart - 2, vistaEnd, 0, 6, RED));
  if (prazoEnd >= prazoStart) fills.push(fill(prazoStart - 2, prazoEnd, 0, 6, RED));
  if (despEnd >= despStart) fills.push(fill(despStart - 2, despEnd, 0, 4, RED));

  return {
    tabName: oficialTabName(input.competencia, motorista),
    values,
    fills,
    totals: {
      freight,
      diesel,
      expenses: expenseTotal,
      deposits: depositTotal,
      net,
      commission,
      tripCount: trips.length,
    },
  };
}

export function groupPromotableByCompetencia(rows: RascunhoRow[]): Map<string, RascunhoRow[]> {
  const buckets = new Map<string, RascunhoRow[]>();
  for (const row of rows) {
    const key = row.competencia;
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }
  return buckets;
}
