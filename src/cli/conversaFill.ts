import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { driveTokenProvider } from "../drive/auth.ts";
import { loadDriveConfig } from "../drive/config.ts";
import { createDriveClient } from "../drive/googleDrive.ts";
import { loadState } from "../persistence/store.ts";
import { createAppendSheetsApi, loadAppendTarget } from "../sheets/appendExisting.ts";
import { loadConversaConfig, runConversaFill } from "../sheets/conversaSheet.ts";
import { fetchGoogleAccessToken, type ServiceAccountFile } from "../sheets/googleJwt.ts";

/** Aba "Conversa WhatsApp": tsx src/cli/conversaFill.ts [--dry-run] [--file /data/store.json] */
export function serviceAccountSheetsToken(path: string): () => Promise<string> {
  let cached: { t: string; until: number } | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.t;
    const account = JSON.parse(readFileSync(path, "utf8")) as ServiceAccountFile;
    const t = await fetchGoogleAccessToken(account, fetch, "https://www.googleapis.com/auth/spreadsheets");
    cached = { t, until: Date.now() + 50 * 60_000 };
    return t;
  };
}

export async function main(args: string[]): Promise<number> {
  const target = loadAppendTarget(process.env);
  if (!target) {
    process.stderr.write("erro: MODELO_TARGET_SPREADSHEET_ID vazio\n");
    return 2;
  }
  const i = args.indexOf("--file");
  const state = loadState(i >= 0 ? args[i + 1]! : process.env.STORE_PATH ?? "data/store.json");
  const drive = loadDriveConfig(process.env);
  const res = await runConversaFill({
    state,
    spreadsheetId: target.spreadsheetId,
    config: loadConversaConfig(process.env),
    sheets: createAppendSheetsApi(serviceAccountSheetsToken(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "")),
    drive: createDriveClient({ token: driveTokenProvider(drive) }),
    rootFolderId: drive.rootFolderId,
    dryRun: args.includes("--dry-run"),
    log: (event, fields) => process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`),
  });
  const p = res.plan;
  process.stdout.write(`${JSON.stringify({ status: res.status, planilha: res.title, aba: p?.tab, gid: p?.gid, primeiraLinhaLivre: p?.firstFreeRow, linhas: p?.rows.length ?? 0, links: p?.links ?? [], puladas: p?.skipped ?? [] })}\n`);
  for (const r of p?.rows ?? []) process.stdout.write(`${JSON.stringify({ linha: r.linha, valores: r.valores })}\n`);
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
