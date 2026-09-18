import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { MemorySheetSink } from "../sheets/fakeSink.ts";
import { loadSheetsLocalState } from "../sheets/localStore.ts";
import { canWriteGoogleSheets, loadSheetsWriteConfig, sheetsWriteSkipReason } from "../sheets/config.ts";
import { formatSyncPlan, planSheetSyncFromSink } from "../sheets/sync.ts";
import { formatRewritePreview, writeSessionToSheet } from "../sheets/write.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultStore = join(root, "data/store.json");

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

export async function runSheetsSyncCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{
  stdout: string;
  exitCode: number;
}> {
  const config = loadSheetsWriteConfig(env);
  const forceDemo = args.includes("--demo");
  const file = flagValue(args, "--file") ?? env.STORE_PATH ?? defaultStore;
  const { state, source } = loadSheetsLocalState(forceDemo, file);

  if (args.includes("--apply")) {
    const skip = sheetsWriteSkipReason(config);
    if (skip) {
      return {
        stdout: `Apply blocked: ${skip}\nSHEETS_SYNC_ENABLED=${config.enabled ? "true" : "false"}\n`,
        exitCode: 1,
      };
    }
    const written = await writeSessionToSheet({ state, config });
    if (!written.ok) {
      return { stdout: `Apply failed: ${written.reason}\nFonte: ${source}\n`, exitCode: 1 };
    }
    return {
      stdout: `Apply ok. Fonte: ${source}. Linhas: ${written.rowCount}. Aba: ${config.tabName}.\n`,
      exitCode: 0,
    };
  }

  const sink = new MemorySheetSink();
  const plan = await planSheetSyncFromSink(state, sink);
  const rewrite = formatRewritePreview({ state, config, source });
  const note = sheetsWriteSkipReason(config)
    ? "Plano local assume aba vazia. Rewrite: Apps Script URL+token ou service account.\n"
    : canWriteGoogleSheets(config)
      ? "Dry-run. Gravacao: sheets:sync --apply\n"
      : "Plano local assume aba vazia.\n";
  return {
    stdout: `${rewrite}${note}${formatSyncPlan(plan, { source, mode: "dry-run" })}`,
    exitCode: 0,
  };
}

if (isCliEntry()) {
  const result = await runSheetsSyncCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
