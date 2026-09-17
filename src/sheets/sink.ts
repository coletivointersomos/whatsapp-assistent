import type { SheetRow } from "./mapper.ts";

export type SyncAction = "insert" | "update" | "noop" | "skip";

export type SyncDecision = {
  action: SyncAction;
  recordId: string;
  row?: SheetRow;
  reason?: string;
};

/** Destino da planilha. A aba existente informa quais `record_id` já estão lá. */
export type SheetSink = {
  existingRecordIds(): Iterable<string> | Promise<Iterable<string>>;
};

export class ApplyBlockedError extends Error {
  constructor(message = "Google Sheets write not configured.") {
    super(message);
    this.name = "ApplyBlockedError";
  }
}

/** MemorySheetSink não grava no Google. Apply real: writeStateToGoogleSheet. */
export function applySheetSync(_sink: SheetSink, _plan: SyncDecision[]): never {
  throw new ApplyBlockedError("Use writeStateToGoogleSheet for Google apply.");
}

export function isSheetsSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SHEETS_SYNC_ENABLED === "true";
}
