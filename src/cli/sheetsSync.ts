import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { MemorySheetSink } from "../sheets/fakeSink.ts";
import { loadSheetsLocalState } from "../sheets/localStore.ts";
import { applySheetSync, isSheetsSyncEnabled } from "../sheets/sink.ts";
import { formatSyncPlan, planSheetSyncFromSink } from "../sheets/sync.ts";

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
  if (args.includes("--apply")) {
    try {
      applySheetSync(new MemorySheetSink(), []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const enabled = isSheetsSyncEnabled(env);
      return {
        stdout: `Apply blocked: ${message}\nSHEETS_SYNC_ENABLED=${enabled ? "true" : "false"}\n`,
        exitCode: 1,
      };
    }
  }

  const forceDemo = args.includes("--demo");
  const file = flagValue(args, "--file") ?? env.STORE_PATH ?? defaultStore;
  const { state, source } = loadSheetsLocalState(forceDemo, file);
  const sink = new MemorySheetSink();
  const plan = await planSheetSyncFromSink(state, sink);
  const note = "Aba remota não lida (adapter Google ausente). Plano assume aba vazia.\n";
  return {
    stdout: `${note}${formatSyncPlan(plan, { source, mode: "dry-run" })}`,
    exitCode: 0,
  };
}

if (isCliEntry()) {
  const result = await runSheetsSyncCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
