import { existsSync } from "node:fs";

export type SheetsWriteConfig = {
  enabled: boolean;
  credentialsPath: string;
  spreadsheetId: string;
  tabName: string;
  sessionStartedAt?: string;
};

export function loadSheetsWriteConfig(env: NodeJS.Dict<string> = process.env): SheetsWriteConfig {
  return {
    enabled: env.SHEETS_SYNC_ENABLED === "true",
    credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? "",
    spreadsheetId: env.SHEETS_SPREADSHEET_ID?.trim() ?? "",
    tabName: env.SHEETS_TAB_NAME?.trim() || "registros",
    sessionStartedAt: env.ASSISTANT_V2_SESSION_STARTED_AT?.trim() || undefined,
  };
}

export function canWriteGoogleSheets(config: SheetsWriteConfig = loadSheetsWriteConfig()): boolean {
  return sheetsWriteSkipReason(config) === undefined;
}

/** Why Thursday write will not run. Undefined = ready. */
export function sheetsWriteSkipReason(config: SheetsWriteConfig = loadSheetsWriteConfig()): string | undefined {
  if (!config.enabled) return "sheets_sync_disabled";
  if (!config.spreadsheetId) return "missing_spreadsheet_id";
  if (!config.credentialsPath) return "missing_credentials_path";
  if (!existsSync(config.credentialsPath)) return "credentials_file_missing";
  return undefined;
}
