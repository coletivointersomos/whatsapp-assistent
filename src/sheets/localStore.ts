import { existsSync } from "node:fs";
import { loadState } from "../persistence/store.ts";
import { sheetsDemoState } from "./demo.ts";
import type { AppState } from "../domain/types.ts";

export function loadSheetsLocalState(forceDemo: boolean, file: string): { state: AppState; source: string } {
  if (!forceDemo && existsSync(file)) {
    return { state: loadState(file), source: file };
  }
  return { state: sheetsDemoState(), source: "demo" };
}
