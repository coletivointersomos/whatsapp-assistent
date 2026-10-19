/**
 * Arquivo das mídias no Drive (parte 2d). Desligado por padrão.
 *   DRIVE_ENABLED=false
 *   DRIVE_ROOT_FOLDER_ID=<pasta "monitoramento caminhão TFA">   (id não é segredo)
 *   GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/...json         (mesma conta de serviço das planilhas)
 *   DRIVE_CHAT_IDS=<jid do grupo do caminhão>[,<outro>]         (só essas conversas vão para a pasta;
 *                                                                vazio = nenhuma, mesmo com DRIVE_ENABLED=true)
 *   DRIVE_AUTH=service_account|oauth_user  (+ DRIVE_OAUTH_CLIENT_FILE / DRIVE_OAUTH_TOKEN_FILE no modo oauth_user)
 * Escopo: o token do Drive pede https://www.googleapis.com/auth/drive (googleDrive.ts) e o do
 * escritor de planilha pede drive + spreadsheets (modeloWriter/appendExisting).
 */
export type DriveConfig = {
  enabled: boolean;
  rootFolderId: string;
  credentialsPath: string;
  chatIds: string[];
  /** "service_account" (padrão) ou "oauth_user" (upload em nome da conta dona da pasta; ver oauthUser.ts). */
  auth?: "service_account" | "oauth_user";
  oauthClientFile?: string;
  oauthTokenFile?: string;
};

/** Arquivos de TESTE do Drive vão só para <raiz>/_teste-hermes (cli/driveSmoke.ts). */
export const DRIVE_TEST_FOLDER = "_teste-hermes";

export const DEFAULT_DRIVE_ROOT_FOLDER_ID = "1zu51FqqV0AyVm8NB1Df8U2-thPka9P7m";

export function loadDriveConfig(env: Record<string, string | undefined> = process.env): DriveConfig {
  const auth = env.DRIVE_AUTH?.trim() || "service_account";
  if (auth !== "service_account" && auth !== "oauth_user") throw new Error("DRIVE_AUTH deve ser service_account ou oauth_user");
  return {
    auth,
    oauthClientFile: env.DRIVE_OAUTH_CLIENT_FILE?.trim() ?? "",
    oauthTokenFile: env.DRIVE_OAUTH_TOKEN_FILE?.trim() ?? "",
    enabled: env.DRIVE_ENABLED === "true",
    rootFolderId: env.DRIVE_ROOT_FOLDER_ID?.trim() || DEFAULT_DRIVE_ROOT_FOLDER_ID,
    credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? "",
    chatIds: (env.DRIVE_CHAT_IDS ?? "")
      .split(/[,;\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

export function driveSkipReason(config: DriveConfig): string | undefined {
  if (!config.enabled) return "drive_disabled";
  if (!config.rootFolderId) return "drive_root_missing";
  if (config.auth === "oauth_user") {
    if (!config.oauthClientFile || !config.oauthTokenFile) return "drive_oauth_files_missing";
  } else if (!config.credentialsPath) return "drive_credentials_missing";
  if (!config.chatIds.length) return "drive_chats_empty";
  return undefined;
}
