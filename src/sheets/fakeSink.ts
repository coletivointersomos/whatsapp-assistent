import type { SheetRow } from "./mapper.ts";
import type { SheetSink, SyncDecision } from "./sink.ts";

/** Aba em memória para testes. Não fala com Google. */
export class MemorySheetSink implements SheetSink {
  private readonly byId = new Map<string, SheetRow>();

  constructor(existing: SheetRow[] = []) {
    for (const row of existing) {
      if (row.record_id.trim()) this.byId.set(row.record_id, row);
    }
  }

  existingRecordIds(): Iterable<string> {
    return this.byId.keys();
  }

  get(recordId: string): SheetRow | undefined {
    return this.byId.get(recordId);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Só testes: aplica o plano no fake. CLI/Google não usam isto. */
  apply(plan: SyncDecision[]): void {
    for (const item of plan) {
      if (!item.row) continue;
      if (item.action === "insert" || item.action === "update") {
        this.byId.set(item.recordId, item.row);
      }
    }
  }
}
