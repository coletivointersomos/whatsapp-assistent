import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { loadState } from "../persistence/store.ts";
import { formatSheetTable, recordsToRows, sheetsDemoState } from "../sheets/preview.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const storePath = join(root, "data/store.json");

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

export function loadSheetsPreviewState(forceDemo: boolean) {
  if (!forceDemo && existsSync(storePath)) {
    return { state: loadState(storePath), source: "data/store.json" };
  }
  return { state: sheetsDemoState(), source: "demo" };
}

if (isCliEntry()) {
  const forceDemo = process.argv.includes("--demo");
  const { state, source } = loadSheetsPreviewState(forceDemo);
  const rows = recordsToRows(state);
  process.stdout.write(`Fonte: ${source}\n`);
  process.stdout.write(formatSheetTable(rows));
}
