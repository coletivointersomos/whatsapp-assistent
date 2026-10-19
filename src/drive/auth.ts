import type { DriveConfig } from "./config.ts";
import { serviceAccountTokenProvider } from "./googleDrive.ts";
import { userOAuthTokenProvider } from "./oauthUser.ts";

/** Token do Drive conforme DRIVE_AUTH: conta de serviço (padrão) ou usuário OAuth (refresh token em arquivo). */
export function driveTokenProvider(config: DriveConfig, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  if (config.auth === "oauth_user") {
    return userOAuthTokenProvider({ clientFile: config.oauthClientFile ?? "", tokenFile: config.oauthTokenFile ?? "", fetchImpl });
  }
  return serviceAccountTokenProvider(config.credentialsPath, fetchImpl);
}
