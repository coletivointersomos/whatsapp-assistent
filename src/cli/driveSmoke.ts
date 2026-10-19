import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DRIVE_TEST_FOLDER, loadDriveConfig } from "../drive/config.ts";
import { driveTokenProvider } from "../drive/auth.ts";
import { createDriveClient, DriveError, FOLDER_MIME } from "../drive/googleDrive.ts";

/**
 * Teste do Drive: arquivos de teste vão SÓ para <raiz>/_teste-hermes (só criar).
 *   tsx src/cli/driveSmoke.ts [--dry-run]
 * Em storageQuotaExceeded: para e avisa (não tenta outro caminho).
 */
export async function main(args: string[]): Promise<number> {
  const config = loadDriveConfig(process.env);
  if (config.auth !== "oauth_user" && !config.credentialsPath) {
    process.stderr.write("erro: GOOGLE_APPLICATION_CREDENTIALS vazio\n");
    return 2;
  }
  const drive = createDriveClient({ token: driveTokenProvider(config) });
  try {
    const found = await drive.listChildren(config.rootFolderId, { name: DRIVE_TEST_FOLDER, foldersOnly: true });
    if (args.includes("--dry-run")) {
      process.stdout.write(`${JSON.stringify({ status: "dry_run", raizLegivel: true, pastaTeste: found.length ? "existe" : "seria criada" })}\n`);
      return 0;
    }
    const folder = found[0] ?? (await drive.createFolder(config.rootFolderId, DRIVE_TEST_FOLDER));
    if (folder.mimeType !== FOLDER_MIME) throw new Error("pasta de teste inválida");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = await drive.uploadFile(folder.id, `hermes-smoke-${stamp}.txt`, "text/plain", Buffer.from(`teste do Hermes (Drive) ${stamp}\n`));
    process.stdout.write(`${JSON.stringify({ status: "ok", pastaCriada: !found.length, arquivo: file.name, link: file.webViewLink ?? "" })}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "desconhecido";
    if (error instanceof DriveError && /storageQuotaExceeded/.test(message)) {
      process.stdout.write(`${JSON.stringify({ status: "PARAR", motivo: "storageQuotaExceeded" })}\n`);
      return 3;
    }
    process.stderr.write(`erro: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
