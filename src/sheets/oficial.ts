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

export function tripUnitPrice(row: RascunhoRow): number {
  const given = asNumber(row.valor_unitario);
  if (given > 0) return given;
  if (parseSacosFreight(row.descricao)) return 0;
  const tons = asNumber(row.toneladas);
  const valor = asNumber(row.valor);
  if (tons > 0 && valor > 0) return Math.round((valor / tons) * 100) / 100;
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
  const aPagar = money(commission);

  const values: Array<Array<string | number>> = [];
  const pushes = (row: Array<string | number>) => {
    values.push(row);
  };

  pushes(["MOTORISTA TFA", monthLabel(input.competencia), motorista, placa]);
  pushes([]);
  pushes(["Comissão", "INSS+IRRF", "Vale", "Adiantamento", "A PAGAR"]);
  pushes([`${Math.round(rate * 100)}%`, 0, 0, 0, aPagar]);
  pushes([]);
  pushes(["Depositou em conta", depositTotal]);
  pushes([]);
  pushes(["RECEBEU DE FRETE", "ABASTECEU", "DESPESAS", "LÍQUIDO", "ainda com o Sr. Manoel"]);
  pushes([freight, diesel, expenseTotal, net, money(net - depositTotal)]);
  pushes([]);
  pushes(["VIAGENS"]);
  pushes(["DATA", "ORIGEM", "DESTINO", "MATERIAL", "TONELADAS", "t", "VALOR", "TOTAL", "%", "COMISSÃO", "OBS"]);

  const tripHeaderRow = values.length; // 1-based later
  for (const row of trips) {
    const sheetRow = values.length + 1;
    const rateN = tripUnitPrice(row);
    const sack = parseSacosFreight(row.descricao);
    const tons = asNumber(row.toneladas) || "";
    const tCell = sack ? "" : rateN || "";
    const valorPaper = asNumber(row.valor) || (sack ? sack.total : "");
    pushes([
      row.data_doc,
      row.origem,
      row.destino,
      row.material,
      tons,
      tCell,
      valorPaper,
      `=IF(F${sheetRow}="",N(G${sheetRow}),ROUND(N(E${sheetRow})*N(F${sheetRow}),2))`,
      `${Math.round(rate * 100)}%`,
      `=ROUND(H${sheetRow}*${rate},2)`,
      sack
        ? `${sack.sacos} sacos × R$ ${sack.unitPrice} = ${sack.total}${asNumber(row.valor) && asNumber(row.valor) !== sack.total ? ` (papel ${row.valor})` : ""}`
        : row.descricao,
    ]);
  }
  const tripStart = tripHeaderRow + 2;
  const tripEnd = values.length;
  const freightFormula = tripEnd >= tripStart ? `=SUM(H${tripStart}:H${tripEnd})` : 0;

  pushes([]);
  pushes(["ABASTECIMENTO À VISTA"]);
  pushes(["DATA", "POSTO", "LITROS", "VALOR", "PAGAMENTO"]);
  const vistaStart = values.length + 1;
  for (const row of vista) {
    pushes([row.data_doc, row.posto || row.descricao, "", asNumber(row.valor), row.pagamento || "à vista"]);
  }
  const vistaEnd = values.length;
  if (vista.length === 0) pushes(["", "", "", 0, ""]);

  pushes([]);
  pushes(["ABASTECIMENTO A PRAZO"]);
  pushes(["DATA", "POSTO", "LITROS", "VALOR", "PAGAMENTO"]);
  const prazoStart = values.length + 1;
  for (const row of prazo) {
    pushes([row.data_doc, row.posto || row.descricao, "", asNumber(row.valor), row.pagamento || "a prazo"]);
  }
  const prazoEnd = values.length;
  if (prazo.length === 0) pushes(["", "", "", 0, ""]);

  pushes([]);
  pushes(["DESPESAS"]);
  pushes(["DATA", "DESCRIÇÃO", "VALOR"]);
  const despStart = values.length + 1;
  for (const row of despesas) {
    pushes([row.data_doc, row.descricao, asNumber(row.valor)]);
  }
  const despEnd = values.length;
  if (despesas.length === 0) pushes(["", "", 0]);

  const dieselFormula = `=SUM(D${vistaStart}:D${vistaEnd})+SUM(D${prazoStart}:D${prazoEnd})`;
  const expenseFormula = `=SUM(C${despStart}:C${despEnd})`;
  values[8] = [freightFormula, dieselFormula, expenseFormula, "=A9-B9-C9", "=D9-B6"];
  values[3][4] = tripEnd >= tripStart ? `=ROUND(SUM(J${tripStart}:J${tripEnd}),2)` : aPagar;

  const fills: CellFill[] = [
    fill(0, 1, 0, 4, HEADER),
    fill(2, 4, 4, 5, YELLOW),
    fill(7, 9, 0, 5, BLUE),
    fill(10, 12, 0, 11, GREEN),
  ];
  if (vistaEnd >= vistaStart) fills.push(fill(vistaStart - 2, vistaEnd, 0, 5, RED));
  if (prazoEnd >= prazoStart) fills.push(fill(prazoStart - 2, prazoEnd, 0, 5, RED));
  if (despEnd >= despStart) fills.push(fill(despStart - 2, despEnd, 0, 3, RED));

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
