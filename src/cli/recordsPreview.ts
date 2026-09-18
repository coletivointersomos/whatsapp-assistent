import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { loadState } from "../persistence/store.ts";
import { formatRecordsPreview, previewRecords } from "../inspect/records.ts";
import type { RecordKind } from "../domain/types.ts";

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

function parseSince(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T00:00:00.000Z`);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--since inválido: ${raw}`);
  }
  return date;
}

function defaultSinceHours(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

if (isCliEntry()) {
  const args = process.argv.slice(2);
  const file = flagValue(args, "--file") ?? process.env.STORE_PATH ?? defaultStore;
  const allTime = args.includes("--all-time");
  const allConversations = args.includes("--all-conversations");
  const conversation =
    flagValue(args, "--conversation") ??
    (allConversations ? undefined : process.env.TEST_GROUP_JID?.trim() || undefined);
  const since = allTime ? undefined : parseSince(flagValue(args, "--since")) ?? defaultSinceHours(48);
  const kindRaw = flagValue(args, "--kind");
  const kind = kindRaw as RecordKind | undefined;
  if (kindRaw && !["abastecimento", "despesa", "viagem"].includes(kindRaw)) {
    throw new Error(`--kind inválido: ${kindRaw}`);
  }

  if (!existsSync(file)) {
    process.stdout.write(`Arquivo não encontrado: ${file}\nNada foi apagado. O store vivo não é limpo por este comando.\n`);
    process.exit(0);
  }

  const state = loadState(file);
  const lines = previewRecords(state, { conversationId: conversation, since, kind });
  process.stdout.write(
    formatRecordsPreview(lines, {
      source: file,
      conversation,
      since: since?.toISOString(),
    }),
  );
}
