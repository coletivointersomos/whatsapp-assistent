import { monitoredVehicle } from "../config/monitored.ts";
import { parseSacosFreight } from "./mapper.ts";
import { asNumber, tripUnitPrice } from "./oficial.ts";
import type { RascunhoRow } from "./rascunho.ts";

/**
 * Parte 2e: preenchimento da aba do motorista ("MANOEL ") numa CÓPIA do Modelo
 * (SKILL §7). Só monta as células; quem escreve é o modeloWriter (atrás de flag).
 * Layout do Modelo (lido em 19/10/2026): VIAGENS 22–29 (total 30), À VISTA 33–41 (total 42,
 * tabela Tabela613), A PRAZO 45 (total 46), DESPESAS 49–58 (total 59). Faltando linha,
 * insere dentro do bloco e as posições abaixo descem.
 * Planilha em en_US: fórmulas com vírgula.
 */
export type CellWrite = { range: string; values: Array<Array<string | number>> };
export type RowInsert = { /** 1-based: insere ANTES desta linha (dentro do bloco). */ beforeRow: number; count: number };

export type ModeloFill = {
  tabTitle: string;
  inserts: RowInsert[];
  writes: CellWrite[];
  summary: {
    viagens: number;
    vista: number;
    prazo: number;
    despesas: number;
    depositos: number;
    adiantamentos: number;
    aConfirmar: number;
    semLink: number;
    totals: { frete: number; diesel: number; despesas: number; depositos: number; adiantamento: number };
  };
};

export const MODELO_LAYOUT = {
  viagens: { first: 22, cap: 8 },
  vista: { first: 33, cap: 9 },
  prazo: { first: 45, cap: 1 },
  despesas: { first: 49, cap: 10 },
} as const;

const MONTHS = ["JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
const MONTHS_SHORT = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

export const CONFIRMAR = "[A CONFIRMAR]";

/** Texto vindo de mensagem nunca vira fórmula na planilha. */
export function safeText(value: string | undefined): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function upper(value: string | undefined): string {
  return safeText(value).toUpperCase();
}

function q(text: string): string {
  return text.replace(/"/g, '""');
}

export function hyperlink(url: string, label: string): string {
  return `=HYPERLINK("${q(url)}","${q(label.replace(/\s+/g, " ").trim().slice(0, 180))}")`;
}

function dateCell(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `=DATE(${Number(m[1])},${Number(m[2])},${Number(m[3])})` : "";
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

export type LinkLookup = (row: RascunhoRow) => { url: string; fileLabel: string } | undefined;

export function buildModeloFill(input: {
  competencia: string;
  /** Linhas da competência já filtradas pela placa acompanhada, PII mascarada. */
  rows: RascunhoRow[];
  /** Linhas que não entram em total (status confirmar/incompleto/tipo outro). */
  pendentes?: RascunhoRow[];
  linkFor?: LinkLookup;
  commissionRate?: number;
  tabTitle?: string;
  /** Dia da geração (AAAA-MM-DD, Brasília). */
  today: string;
  /** Recuo do título no Modelo (A18). */
  titleIndent?: string;
}): ModeloFill {
  const rate = input.commissionRate ?? 0.11;
  const monitored = monitoredVehicle();
  const tab = input.tabTitle ?? "MANOEL ";
  const sheet = `'${tab.replace(/'/g, "''")}'`;
  const [year, month] = input.competencia.split("-").map(Number) as [number, number];
  const todayBr = `${input.today.slice(8, 10)}/${input.today.slice(5, 7)}/${input.today.slice(0, 4)}`;
  const byDate = (a: RascunhoRow, b: RascunhoRow) => a.data_doc.localeCompare(b.data_doc) || a.enviado_em.localeCompare(b.enviado_em);
  const rows = [...input.rows].sort(byDate);
  const viagens = rows.filter((r) => r.tipo === "viagem");
  const vista = rows.filter((r) => r.tipo === "abastecimento_vista");
  const prazo = rows.filter((r) => r.tipo === "abastecimento_prazo");
  const despesas = rows.filter((r) => r.tipo === "despesa" || r.tipo === "pedagio" || r.tipo === "balanca");
  const depositos = rows.filter((r) => r.tipo === "deposito" || r.tipo === "pagamento");
  const adiant = rows.filter((r) => r.tipo === "adiantamento");
  const pendentes = [...(input.pendentes ?? [])].sort(byDate);
  let semLink = 0;

  const obs = (row: RascunhoRow, text: string): string => {
    const link = input.linkFor?.(row);
    const noDate = !row.data_doc ? ` ${CONFIRMAR} data` : "";
    if (link) return hyperlink(link.url, `${text}${noDate} (${link.fileLabel} — link)`);
    semLink += 1;
    return safeText(`${text}${noDate}${text ? " — " : ""}sem arquivo no Drive ${CONFIRMAR}`);
  };

  const L = MODELO_LAYOUT;
  const exV = Math.max(0, viagens.length - L.viagens.cap);
  const exA = Math.max(0, vista.length - L.vista.cap);
  const exP = Math.max(0, prazo.length - L.prazo.cap);
  const exD = Math.max(0, despesas.length - L.despesas.cap);
  // Inserção de baixo para cima com as linhas originais do Modelo (a 2ª linha de cada bloco: fica dentro da tabela).
  const inserts: RowInsert[] = [];
  if (exD) inserts.push({ beforeRow: L.despesas.first + 1, count: exD });
  if (exP) inserts.push({ beforeRow: L.prazo.first, count: exP });
  if (exA) inserts.push({ beforeRow: L.vista.first + 1, count: exA });
  if (exV) inserts.push({ beforeRow: L.viagens.first + 1, count: exV });

  const vFirst = L.viagens.first;
  const vLast = vFirst + L.viagens.cap - 1 + exV;
  const vTot = vLast + 1;
  const s1 = exV;
  const aFirst = L.vista.first + s1;
  const aLast = aFirst + L.vista.cap - 1 + exA;
  const aTot = aLast + 1;
  const s2 = s1 + exA;
  const pHead = 44 + s2;
  const pFirst = L.prazo.first + s2;
  const pLast = pFirst + L.prazo.cap - 1 + exP;
  const pTot = pLast + 1;
  const s3 = s2 + exP;
  const dHead = 48 + s3;
  const dFirst = L.despesas.first + s3;
  const dLast = dFirst + L.despesas.cap - 1 + exD;
  const dTot = dLast + 1;

  const writes: CellWrite[] = [];
  const put = (range: string, values: Array<Array<string | number>>) => writes.push({ range: `${sheet}!${range}`, values });

  // Título
  put("A18:A19", [
    [`${input.titleIndent ?? "                      "}MOTORISTA ${monitored.plate.slice(0, 3)} - ${MONTHS[month - 1]} ${String(year).slice(2)}`],
    [`${monitored.plate.slice(0, 3)} ${monitored.plate.slice(3)} - ${monitored.driver.toUpperCase()}`],
  ]);

  // VIAGENS
  let freight = 0;
  const vRows: Array<Array<string | number>> = [];
  for (let i = 0; i < vLast - vFirst + 1; i += 1) {
    const r = vFirst + i;
    const row = viagens[i];
    if (!row) {
      const empty: Array<string | number> = ["", "", "", "", "", "", "", `=F${r}*G${r}`, "", `=H${r}*I${r}`, ""];
      if (i === 0 && viagens.length === 0) empty[1] = `SEM VIAGENS INFORMADAS NO GRUPO ATÉ ${todayBr} ${CONFIRMAR}`;
      vRows.push(empty);
      continue;
    }
    const tons = asNumber(row.toneladas);
    const sack = parseSacosFreight(row.descricao);
    const unit = tripUnitPrice(row);
    const valor = asNumber(row.valor);
    let g: string | number = "";
    let h: string | number = `=F${r}*G${r}`;
    let note = safeText(row.descricao);
    if (sack) {
      h = sack.total;
      note = `${sack.sacos} sacos × R$ ${sack.unitPrice} = ${sack.total}`;
      freight += sack.total;
    } else if (unit > 0 && tons > 0) {
      g = unit;
      freight += money(unit * tons);
    } else if (valor > 0) {
      h = valor;
      note = `${note} R$/t ${CONFIRMAR}`.trim();
      freight += valor;
    } else {
      h = "";
      note = `${note} valor ${CONFIRMAR}`.trim();
    }
    vRows.push([
      dateCell(row.data_doc),
      upper(row.origem),
      upper(row.destino),
      upper(row.material),
      tons ? Math.round(tons * 1000) : "",
      tons || "",
      g,
      h,
      rate,
      `=H${r}*I${r}`,
      obs(row, note),
    ]);
  }
  put(`A${vFirst}:K${vLast}`, vRows);
  put(`H${vTot}:J${vTot}`, [[`=SUBTOTAL(109,H${vFirst}:H${vLast})`, "", `=SUBTOTAL(109,J${vFirst}:J${vLast})`]]);

  // ABASTECIMENTO À VISTA / A PRAZO
  const fuelRow = (row: RascunhoRow | undefined, prazoCol: string): Array<string | number> =>
    row
      ? [dateCell(row.data_doc), upper(row.posto || row.descricao), "", "", asNumber(row.valor) || "", prazoCol, obs(row, safeText(row.descricao || row.posto))]
      : ["", "", "", "", "", "", ""];
  put(`A${aFirst}:G${aLast}`, Array.from({ length: aLast - aFirst + 1 }, (_, i) => fuelRow(vista[i], "")));
  put(`E${aTot}`, [["=SUBTOTAL(109,Tabela613[VALOR])"]]);
  put(
    `A${pFirst}:G${pLast}`,
    Array.from({ length: pLast - pFirst + 1 }, (_, i) => {
      const row = prazo[i];
      if (!row && i === 0 && prazo.length === 0) return ["", `NENHUM ABASTECIMENTO A PRAZO INFORMADO EM ${MONTHS[month - 1]}`, "", "", "", "", ""];
      return fuelRow(row, row ? (/assinad/i.test(`${row.pagamento} ${row.descricao}`) ? "ASSINADA" : CONFIRMAR) : "");
    }),
  );
  put(`E${pTot}`, [[`=SUBTOTAL(109,E${pHead}:E${pLast})`]]);
  const diesel = money([...vista, ...prazo].reduce((s, r) => s + asNumber(r.valor), 0));

  // DESPESAS (pedágio e balança incluídos)
  const despLabel = (row: RascunhoRow) => {
    const d = upper(row.descricao);
    if (row.tipo === "pedagio" && !/PED[AÁ]GIO/.test(d)) return `PEDÁGIO ${d}`.trim();
    if (row.tipo === "balanca" && !/BALAN[CÇ]A/.test(d)) return `BALANÇA ${d}`.trim();
    return d || CONFIRMAR;
  };
  put(
    `A${dFirst}:D${dLast}`,
    Array.from({ length: dLast - dFirst + 1 }, (_, i) => {
      const row = despesas[i];
      return row ? [dateCell(row.data_doc), despLabel(row), asNumber(row.valor) || "", obs(row, safeText(row.descricao))] : ["", "", "", ""];
    }),
  );
  put(`C${dTot}`, [[`=SUBTOTAL(109,C${dFirst}:C${dLast})`]]);
  const expenses = money(despesas.reduce((s, r) => s + asNumber(r.valor), 0));

  // DEPÓSITOS / PAGAMENTOS (bloco extra)
  let r = dTot + 2;
  const blockStart = r;
  const extra: Array<Array<string | number>> = [];
  const tag = `${MONTHS_SHORT[month - 1]}/${year}`;
  extra.push([`DEPÓSITOS / PAGAMENTOS — ${tag}`, "", "", ""]);
  extra.push(["DATA", "DESCRIÇÃO ", "VALOR ", "OBSERVAÇÃO"]);
  const depFirst = blockStart + 2;
  if (!depositos.length) extra.push(["", `NENHUM DEPÓSITO INFORMADO ATÉ ${todayBr}`, "", ""]);
  for (const row of depositos) {
    const label = row.tipo === "pagamento" && !/PIX/i.test(row.descricao) ? `PIX — ${upper(row.descricao)}` : upper(row.descricao);
    extra.push([dateCell(row.data_doc), label || CONFIRMAR, asNumber(row.valor) || "", obs(row, safeText(row.descricao))]);
  }
  const depLast = blockStart + extra.length - 1;
  const depTot = depLast + 1;
  extra.push(["", "", `=SUM(C${depFirst}:C${depLast})`, ""]);
  const deposits = money(depositos.reduce((s, rr) => s + asNumber(rr.valor), 0));
  extra.push(["", "", "", ""]);
  extra.push([`ITENS A CONFIRMAR / PENDÊNCIAS — ${tag} (fora dos totais)`, "", "", ""]);
  extra.push(["DATA", "DESCRIÇÃO ", "VALOR ", "OBSERVAÇÃO"]);
  if (!pendentes.length) extra.push(["", "NENHUM", "", ""]);
  for (const row of pendentes) {
    const why = row.status === "confirmar" ? "mesmo valor de outro lançamento" : row.tipo === "outro" ? "tipo incerto" : "dado incompleto";
    extra.push([dateCell(row.data_doc), upper(row.descricao) || upper(row.tipo), asNumber(row.valor) || "", obs(row, `${CONFIRMAR} ${why}`)]);
  }
  extra.push(["", "", "", ""]);
  extra.push([
    "OBS:",
    safeText(
      `Comissão ${Math.round(rate * 100)}% do frete (I). Frete por saco: H = valor recebido e a conta na observação. Pedágio/balança em DESPESAS; Pix de acerto em DEPÓSITOS. Mês pela data do fato. Gerado pelo Hermes em ${todayBr} — parcial; conferir itens ${CONFIRMAR}.`,
    ),
    "",
    "",
  ]);
  r = blockStart + extra.length - 1;
  put(`A${blockStart}:D${r}`, extra);

  // ACERTO MÊS
  const adiantTotal = money(adiant.reduce((s, rr) => s + asNumber(rr.valor), 0));
  const adiantObs = adiant[0] ? obs(adiant[0], `Adiantamento ${adiant.length > 1 ? `(${adiant.length} lançamentos)` : ""}`.trim()) : `Adiantamento não informado no grupo até ${todayBr}`;
  put("C2:D7", [
    [`=J${vTot}`, ""],
    ["", `${CONFIRMAR} acerto ainda não feito`],
    ["", ""],
    [adiantTotal || "", adiantObs],
    ["", ""],
    ["=C2-C3-C4-C5", "A PAGAR"],
  ]);
  put("G3", [[`=C${depTot}`]]);
  put("I4:I7", [[`=H${vTot}`], [`=E${aTot}+E${pTot}`], [`=C${dTot}`], ["=I4-I5-I6"]]);

  return {
    tabTitle: tab,
    inserts,
    writes,
    summary: {
      viagens: viagens.length,
      vista: vista.length,
      prazo: prazo.length,
      despesas: despesas.length,
      depositos: depositos.length,
      adiantamentos: adiant.length,
      aConfirmar: pendentes.length,
      semLink,
      totals: { frete: money(freight), diesel, despesas: expenses, depositos: deposits, adiantamento: adiantTotal },
    },
  };
}
