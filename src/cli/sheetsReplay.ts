import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadState } from "../persistence/store.ts";
import { planPagamento } from "../sheets/pagamento.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultStore = join(root, "data/store.json");

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

type ExpectedTotals = { freight?: number; diesel?: number; expenses?: number; net?: number };

/**
 * Replay da folha a partir de um store (nada é escrito).
 *   tsx src/cli/sheetsReplay.ts [--file data/store.json] [--expect totais.json]
 * --expect: JSON {freight, diesel, expenses, net} para comparar (sai 1 se divergir).
 */
export function runSheetsReplay(args: string[]): { stdout: string; exitCode: number } {
  const file = flagValue(args, "--file") ?? defaultStore;
  const expectFile = flagValue(args, "--expect");
  const state = loadState(file);
  const print: ExpectedTotals | undefined = expectFile ? (JSON.parse(readFileSync(expectFile, "utf8")) as ExpectedTotals) : undefined;
  const plan = planPagamento({ state, commissionRate: 0.11 });
  const lines = [
    `Rascunho: ${plan.merged.length} linhas (insert ${plan.toInsert.length})`,
    `Oficial pronta: ${plan.oficialReady ? "sim" : "não"}`,
    `Esquecido: ${plan.validation.forgotten.length}`,
    `Duplicado: ${plan.validation.duplicates.length}`,
    `Incompleto: ${plan.validation.incomplete.length}`,
    `Abas: ${plan.oficial.map((item) => item.tabName).join(", ") || "(nenhuma)"}`,
  ];
  const ref = (value: number | undefined) => (value === undefined ? "" : ` (esperado ${value})`);
  for (const oficial of plan.oficial) {
    lines.push(
      `[${oficial.tabName}] Viagens: ${oficial.totals.tripCount}`,
      `Frete: ${oficial.totals.freight}${ref(print?.freight)}`,
      `Diesel: ${oficial.totals.diesel}${ref(print?.diesel)}`,
      `Despesas: ${oficial.totals.expenses}${ref(print?.expenses)}`,
      `Depósitos: ${oficial.totals.deposits}`,
      `Líquido: ${oficial.totals.net}${ref(print?.net)}`,
    );
  }
  if (plan.alerts.length) {
    lines.push("Alertas admin:");
    for (const text of plan.alerts) lines.push(`- ${text}`);
  }
  const oficial = plan.oficial[0];
  const differs = (got: number, want?: number) => want !== undefined && got !== want;
  const mismatch = Boolean(
    print &&
      oficial &&
      (differs(oficial.totals.freight, print.freight) ||
        differs(oficial.totals.diesel, print.diesel) ||
        differs(oficial.totals.expenses, print.expenses) ||
        differs(oficial.totals.net, print.net)),
  );
  return { stdout: `${lines.join("\n")}\n`, exitCode: mismatch ? 1 : 0 };
}

if (isCliEntry()) {
  const result = runSheetsReplay(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
