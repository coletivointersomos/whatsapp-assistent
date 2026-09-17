import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { formatSheetTable } from "../sheets/export.ts";
import { recordsToRows } from "../sheets/mapper.ts";
import { loadSheetsLocalState } from "../sheets/localStore.ts";

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

export function loadSheetsPreviewState(forceDemo: boolean, file = defaultStore) {
  return loadSheetsLocalState(forceDemo, file);
}

if (isCliEntry()) {
  const args = process.argv.slice(2);
  const forceDemo = args.includes("--demo");
  const file = flagValue(args, "--file") ?? process.env.STORE_PATH ?? defaultStore;
  const { state, source } = loadSheetsPreviewState(forceDemo, file);
  const rows = recordsToRows(state);
  process.stdout.write(`Fonte: ${source}\n`);
  process.stdout.write(formatSheetTable(rows));
}
