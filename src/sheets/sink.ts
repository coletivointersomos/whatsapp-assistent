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
  constructor(message = "Google Sheets adapter is not implemented; --apply is blocked.") {
    super(message);
    this.name = "ApplyBlockedError";
  }
}

/** Qualquer tentativa de escrita real nesta etapa. */
export function applySheetSync(_sink: SheetSink, _plan: SyncDecision[]): never {
  throw new ApplyBlockedError();
}

export function isSheetsSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SHEETS_SYNC_ENABLED === "true";
}
