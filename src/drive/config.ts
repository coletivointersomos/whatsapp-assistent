/**
 * Arquivo das mídias no Drive (parte 2d). Desligado por padrão.
 *   DRIVE_ENABLED=false
 *   DRIVE_ROOT_FOLDER_ID=<pasta "monitoramento caminhão TFA">   (id não é segredo)
 *   GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/...json         (mesma conta de serviço das planilhas)
 *   DRIVE_CHAT_IDS=<jid do grupo do caminhão>[,<outro>]         (só essas conversas vão para a pasta;
 *                                                                vazio = nenhuma, mesmo com DRIVE_ENABLED=true)
 */
export type DriveConfig = {
  enabled: boolean;
  rootFolderId: string;
  credentialsPath: string;
  chatIds: string[];
};

export const DEFAULT_DRIVE_ROOT_FOLDER_ID = "1zu51FqqV0AyVm8NB1Df8U2-thPka9P7m";

export function loadDriveConfig(env: Record<string, string | undefined> = process.env): DriveConfig {
  return {
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
  if (!config.credentialsPath) return "drive_credentials_missing";
  if (!config.chatIds.length) return "drive_chats_empty";
  return undefined;
}
