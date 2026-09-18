import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSheetsSyncCli } from "../src/cli/sheetsSync.ts";
import { seedState } from "../src/config/seed.ts";
import type { OperationalRecord } from "../src/domain/types.ts";
import { processMessage } from "../src/engine/process.ts";
import { MemorySheetSink } from "../src/sheets/fakeSink.ts";
import { SHEET_COLUMNS, isSyncEligible, recordToRow } from "../src/sheets/mapper.ts";
import { ApplyBlockedError, applySheetSync, isSheetsSyncEnabled } from "../src/sheets/sink.ts";
import { planSheetSync, planSheetSyncFromSink, summarizePlan } from "../src/sheets/sync.ts";
import { sheetsDemoState } from "../src/sheets/demo.ts";

const T0 = new Date("2026-09-14T20:53:46.000Z");

function fuelIncomplete() {
  const state = seedState();
  processMessage(
    state,
    {
      externalId: "inc-1",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista",
      sentAt: T0.toISOString(),
      type: "texto",
      text: "abasteci 150 litros, deu 980, assinada",
    },
    { now: () => T0 },
  );
  return state;
}

describe("sheets sync", () => {
  it("puts record_id first in the sheet contract from OperationalRecord.id", () => {
    const state = sheetsDemoState();
    assert.equal(SHEET_COLUMNS[0], "record_id");
    for (const record of state.records) {
      const row = recordToRow(state, record);
      assert.equal(row.record_id, record.id);
      assert.ok(row.record_id.startsWith("reg-"));
      assert.equal(isSyncEligible(row), true);
    }
  });

  it("does not sync a record without id", () => {
    const state = seedState();
    const record: OperationalRecord = {
      id: "",
      kind: "despesa",
      driverId: "motorista-joao",
      status: "incompleto",
      sourceMessageIds: ["x"],
      missing: ["date"],
    };
    state.records.push(record);
    const plan = planSheetSync(state, []);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "skip");
    assert.equal(plan[0].reason, "missing_record_id");
    assert.equal(isSyncEligible(record), false);
  });

  it("inserts on the first sync and updates or noops on the second, never a second insert", () => {
    const state = fuelIncomplete();
    const sink = new MemorySheetSink();
    const first = planSheetSync(state, sink.existingRecordIds());
    assert.equal(summarizePlan(first).insert, 1);
    assert.equal(summarizePlan(first).update, 0);
    sink.apply(first);
    assert.equal(sink.size, 1);

    const second = planSheetSync(state, sink.existingRecordIds(), new Map([[state.records[0].id, sink.get(state.records[0].id)!]]));
    assert.equal(summarizePlan(second).insert, 0);
    assert.ok(summarizePlan(second).update + summarizePlan(second).noop === 1);
    sink.apply(second);
    assert.equal(sink.size, 1);
  });

  it("updates the same row when an incomplete record becomes complete", async () => {
    const state = fuelIncomplete();
    const sink = new MemorySheetSink();
    sink.apply(await planSheetSyncFromSink(state, sink));
    assert.equal(sink.get(state.records[0].id)?.status, "incompleto");

    processMessage(
      state,
      {
        externalId: "cmp-1",
        conversationId: "conv-joao",
        authorId: "motorista-joao",
        authorRole: "motorista",
        sentAt: "2026-09-14T20:54:40.000Z",
        type: "texto",
        text: "foi hoje no posto jacinto",
      },
      { now: () => new Date("2026-09-14T20:54:40.000Z") },
    );
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].status, "completo");

    const next = await planSheetSyncFromSink(state, sink);
    assert.equal(summarizePlan(next).insert, 0);
    assert.equal(summarizePlan(next).update, 1);
    sink.apply(next);
    assert.equal(sink.size, 1);
    assert.equal(sink.get(state.records[0].id)?.status, "completo");
    assert.equal(sink.get(state.records[0].id)?.posto_local, "posto jacinto");
  });

  it("runs sheets:sync dry-run without credentials", async () => {
    const result = await runSheetsSyncCli(["--demo"], { SHEETS_SYNC_ENABLED: "false" });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Modo: dry-run/);
    assert.match(result.stdout, /rewrite da aba/);
    assert.match(result.stdout, /Insert: /);
    assert.equal(result.stdout.includes("googleapis"), false);
  });

  it("blocks --apply until spreadsheet id and credentials file exist", async () => {
    assert.equal(isSheetsSyncEnabled({ SHEETS_SYNC_ENABLED: "true" }), true);
    assert.throws(() => applySheetSync(new MemorySheetSink(), []), ApplyBlockedError);
    const result = await runSheetsSyncCli(["--apply"], { SHEETS_SYNC_ENABLED: "true" });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /Apply blocked/);
    assert.match(result.stdout, /missing_spreadsheet_id/);
    assert.equal(result.stdout.includes("not implemented"), false);
  });
});
