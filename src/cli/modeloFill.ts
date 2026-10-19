import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadState } from "../persistence/store.ts";
import { loadModeloConfig, runModeloFill } from "../sheets/modeloWriter.ts";

/**
 * Parte 2e — cópia do Modelo preenchida (só aba do motorista).
 *   tsx src/cli/modeloFill.ts --competencia 2026-10 [--file /data/store.json] [--dry-run]
 * Sem MODELO_SHEET_ENABLED=true nada é escrito (mostra só o resumo). Saída sem PII.
 */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(args: string[]): Promise<number> {
  const competencia = flag(args, "--competencia") ?? "";
  if (!/^\d{4}-\d{2}$/.test(competencia)) {
    process.stderr.write("uso: --competencia AAAA-MM [--file store.json] [--dry-run]\n");
    return 2;
  }
  const state = loadState(flag(args, "--file") ?? process.env.STORE_PATH ?? "data/store.json");
  const result = await runModeloFill({
    state,
    competencia,
    config: loadModeloConfig(process.env),
    dryRun: args.includes("--dry-run"),
    log: (event, fields) => process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`),
  });
  process.stdout.write(
    `${JSON.stringify({ status: result.status, copia: result.copyName, copiou: result.copied ?? false, inserts: result.fill.inserts, ranges: result.fill.writes.length, resumo: result.fill.summary })}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`erro: ${error instanceof Error ? error.message : "desconhecido"}\n`);
      process.exit(1);
    },
  );
}
