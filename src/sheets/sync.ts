import type { AppState } from "../domain/types.ts";
import { isSyncEligible, recordToRow, type SheetRow } from "./mapper.ts";
import type { SheetSink, SyncDecision } from "./sink.ts";

function rowFingerprint(row: SheetRow): string {
  return JSON.stringify(row);
}

export function planSheetSync(state: AppState, existingIds: Iterable<string>, existingRows?: Map<string, SheetRow>): SyncDecision[] {
  const known = new Set([...existingIds].filter((id) => id.trim()));
  const decisions: SyncDecision[] = [];

  for (const record of state.records) {
    if (!isSyncEligible(record)) {
      decisions.push({
        action: "skip",
        recordId: "",
        reason: "missing_record_id",
      });
      continue;
    }
    const row = recordToRow(state, record);
    if (!isSyncEligible(row)) {
      decisions.push({ action: "skip", recordId: "", reason: "missing_record_id" });
      continue;
    }
    if (!known.has(row.record_id)) {
      decisions.push({ action: "insert", recordId: row.record_id, row });
      continue;
    }
    const previous = existingRows?.get(row.record_id);
    if (previous && rowFingerprint(previous) === rowFingerprint(row)) {
      decisions.push({ action: "noop", recordId: row.record_id, row, reason: "unchanged" });
      continue;
    }
    decisions.push({ action: "update", recordId: row.record_id, row });
  }

  return decisions;
}

export async function planSheetSyncFromSink(state: AppState, sink: SheetSink): Promise<SyncDecision[]> {
  const ids = [...(await sink.existingRecordIds())];
  const rows = new Map<string, SheetRow>();
  const maybeGet = sink as SheetSink & { get?: (id: string) => SheetRow | undefined };
  if (typeof maybeGet.get === "function") {
    for (const id of ids) {
      const row = maybeGet.get(id);
      if (row) rows.set(id, row);
    }
  }
  return planSheetSync(state, ids, rows.size ? rows : undefined);
}

export function summarizePlan(plan: SyncDecision[]): { insert: number; update: number; noop: number; skip: number } {
  return {
    insert: plan.filter((item) => item.action === "insert").length,
    update: plan.filter((item) => item.action === "update").length,
    noop: plan.filter((item) => item.action === "noop").length,
    skip: plan.filter((item) => item.action === "skip").length,
  };
}

export function formatSyncPlan(
  plan: SyncDecision[],
  meta: { source: string; mode: string },
): string {
  const counts = summarizePlan(plan);
  const lines = [
    `Modo: ${meta.mode}`,
    `Fonte: ${meta.source}`,
    `Insert: ${counts.insert}`,
    `Update: ${counts.update}`,
    `Noop: ${counts.noop}`,
    `Skip: ${counts.skip}`,
    "",
  ];
  if (plan.length === 0) {
    return `${lines.join("\n")}Nenhum registro para sincronizar.\n`;
  }
  const body = plan.map((item, index) => {
    const kind = item.row?.tipo ?? "";
    const status = item.row?.status ?? "";
    const id = item.recordId || "(sem record_id)";
    const reason = item.reason ? ` (${item.reason})` : "";
    return `${index + 1}. ${item.action} ${id} ${kind} ${status}${reason}`.trimEnd();
  });
  return `${lines.join("\n")}${body.join("\n")}\n`;
}
