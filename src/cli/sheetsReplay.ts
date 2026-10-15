import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { loadState } from "../persistence/store.ts";
import { ALANA_SETEMBRO_PRINT } from "../sheets/oficial.ts";
import { planPagamento } from "../sheets/pagamento.ts";
import { setembroManoelState } from "../sheets/setembroManoel.ts";

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

export function runSheetsReplay(args: string[]): { stdout: string; exitCode: number } {
  const file = flagValue(args, "--file");
  const state = args.includes("--setembro") || !file ? setembroManoelState() : loadState(file ?? defaultStore);
  const plan = planPagamento({ state, commissionRate: 0.11 });
  const oficial = plan.oficial[0];
  const print = ALANA_SETEMBRO_PRINT;
  const lines = [
    `Rascunho: ${plan.merged.length} linhas (insert ${plan.toInsert.length})`,
    `Oficial pronta: ${plan.oficialReady ? "sim" : "não"}`,
    `Esquecido: ${plan.validation.forgotten.length}`,
    `Duplicado: ${plan.validation.duplicates.length}`,
    `Incompleto: ${plan.validation.incomplete.length}`,
    `Abas: ${plan.oficial.map((item) => item.tabName).join(", ") || "(nenhuma)"}`,
  ];
  if (oficial) {
    lines.push(
      `Viagens: ${oficial.totals.tripCount}`,
      `Frete: ${oficial.totals.freight} (print ${print.freight})`,
      `Diesel: ${oficial.totals.diesel} (print ${print.diesel})`,
      `Despesas: ${oficial.totals.expenses} (print ${print.expenses})`,
      `Líquido: ${oficial.totals.net} (print ${print.net})`,
    );
    const luis = oficial.values.find((row) => row.some((cell) => String(cell).includes("Luís Eduardo") || String(cell).includes("Luis Eduardo")));
    lines.push(`16/09 Luís Eduardo: ${luis ? "ok" : "faltou"}`);
    const sacos = oficial.values.find((row) => row.some((cell) => String(cell).includes("896 sacos")));
    lines.push(`896 sacos × 4: ${sacos ? "ok" : "faltou"}`);
  }
  if (plan.alerts.length) {
    lines.push("Alertas admin:");
    for (const text of plan.alerts) lines.push(`- ${text}`);
  }
  const mismatch =
    oficial &&
    (oficial.totals.freight !== print.freight ||
      oficial.totals.diesel !== print.diesel ||
      oficial.totals.expenses !== print.expenses ||
      oficial.totals.net !== print.net);
  return { stdout: `${lines.join("\n")}\n`, exitCode: mismatch ? 1 : 0 };
}

if (isCliEntry()) {
  const result = runSheetsReplay(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
