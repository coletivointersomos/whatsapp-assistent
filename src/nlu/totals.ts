import { dayIso } from "../domain/rules.ts";
import type { AppState, OperationalRecord } from "../domain/types.ts";

export type LocalTotals = {
  fuelBrl: number;
  expenseBrl: number;
  combinedBrl: number;
  tripCount: number;
  pendingCount: number;
  pendingLines: string[];
};

function recordDate(record: OperationalRecord): string | undefined {
  return record.abastecimento?.date ?? record.despesa?.date ?? record.viagem?.date;
}

export function localTotals(
  state: AppState,
  opts: { date?: string; now?: Date } = {},
): LocalTotals {
  const date = opts.date ?? (opts.now ? dayIso(opts.now) : undefined);
  let fuelBrl = 0;
  let expenseBrl = 0;
  let tripCount = 0;
  const pendingLines: string[] = [];

  for (const record of state.records) {
    if (record.status === "incompleto") {
      pendingLines.push(`${record.kind} (${record.missing.join(", ") || "campos"})`);
    }
    if (date && recordDate(record) !== date) continue;
    if (record.kind === "abastecimento") fuelBrl += Number(record.abastecimento?.totalBrl ?? 0);
    if (record.kind === "despesa") expenseBrl += Number(record.despesa?.amountBrl ?? 0);
    if (record.kind === "viagem") tripCount += 1;
  }

  return {
    fuelBrl,
    expenseBrl,
    combinedBrl: fuelBrl + expenseBrl,
    tripCount,
    pendingCount: state.records.filter((r) => r.status === "incompleto").length,
    pendingLines,
  };
}

export function formatFuelToday(totals: LocalTotals, date: string): string {
  if (totals.fuelBrl <= 0) return `Não encontrei abastecimento com data ${date} nos registros locais.`;
  return `Combustível em ${date}: R$ ${totals.fuelBrl} (só registros locais, sem Google).`;
}

export function formatPendings(totals: LocalTotals): string {
  if (totals.pendingCount === 0) return "Não há pendências abertas nos registros locais.";
  return `Há ${totals.pendingCount} pendência(s): ${totals.pendingLines.slice(0, 5).join("; ")}.`;
}

function daysAgo(now: Date, days: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return dayIso(d);
}

export function findLocalExpense(
  state: AppState,
  opts: { driverHint?: string; text: string; now: Date },
): string {
  const needle = opts.text.toLowerCase();
  const wantMotor = /\bmotor\b/.test(needle);
  const since = daysAgo(opts.now, 21);
  const until = daysAgo(opts.now, 7);
  const driver = state.drivers.find((d, i) => {
    if (opts.driverHint && d.name.toLowerCase().includes(opts.driverHint.toLowerCase())) return true;
    if (/\bmotorista\s*1\b/.test(needle) && i === 0) return true;
    return false;
  });

  const matches = state.records.filter((r) => {
    if (r.kind !== "despesa") return false;
    if (driver && r.driverId !== driver.id) return false;
    const desc = (r.despesa?.description ?? "").toLowerCase();
    if (wantMotor && !desc.includes("motor")) return false;
    const date = r.despesa?.date;
    if (date && (date < since || date > until)) return false;
    return true;
  });

  if (matches.length === 0) {
    return "Não encontrei confirmação local desse gasto. Posso perguntar ao motorista se você confirmar.";
  }
  const first = matches[0];
  return `Encontrei despesa local: ${first.despesa?.description ?? "sem descrição"} em ${first.despesa?.date ?? "data não informada"} (R$ ${first.despesa?.amountBrl ?? "?"}).`;
}
