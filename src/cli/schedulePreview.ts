import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { loadState } from "../persistence/store.ts";
import {
  SCHEDULE_DEMO_NOW,
  formatSchedulePreview,
  scheduleDecisions,
  scheduleDemoState,
} from "../schedule/preview.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const storePath = join(root, "data/store.json");

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

export function loadSchedulePreviewState(forceDemo: boolean) {
  if (!forceDemo && existsSync(storePath)) {
    return { state: loadState(storePath), source: "data/store.json" };
  }
  return { state: scheduleDemoState(), source: "demo" };
}

if (isCliEntry()) {
  const args = process.argv.slice(2);
  const nowIdx = args.indexOf("--now");
  const now = nowIdx >= 0 && args[nowIdx + 1] ? new Date(args[nowIdx + 1]) : SCHEDULE_DEMO_NOW;
  const forceDemo = args.includes("--demo");
  const { state, source } = loadSchedulePreviewState(forceDemo);
  const lines = scheduleDecisions(state, now);
  process.stdout.write(formatSchedulePreview(lines, now, source));
}
