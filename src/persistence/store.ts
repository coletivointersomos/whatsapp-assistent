import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { seedState } from "../config/seed.ts";
import type { AppState } from "../domain/types.ts";

export function emptyState(): AppState {
  return seedState();
}

export function loadState(filePath: string): AppState {
  if (!existsSync(filePath)) return seedState();
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as AppState;
}

export function saveState(filePath: string, state: AppState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

export function cloneState(state: AppState): AppState {
  return structuredClone(state);
}
