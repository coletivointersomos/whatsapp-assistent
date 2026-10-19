import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAutoFill, factCompetencia, loadAutoFillConfig } from "../src/sheets/autoFill.ts";

const G = "123@g.us";
const ENV = { MODELO_AUTO_FILL_ENABLED: "true", MODELO_SHEET_ENABLED: "true", MODELO_TARGET_SPREADSHEET_ID: "x", MODELO_AUTO_FILL_CHAT_IDS: G };
function fakeTimers() {
  const q: Array<() => void> = [];
  return { q, timers: { set: (fn: () => void) => (q.push(fn), q.length), clear: () => undefined } };
}

describe("gatilho automático da planilha", () => {
  it("config: precisa das 3 flags; vazio = ninguém dispara", () => {
    assert.equal(loadAutoFillConfig({}).enabled, false);
    assert.equal(loadAutoFillConfig({ ...ENV, MODELO_SHEET_ENABLED: "false" }).enabled, false);
    assert.equal(loadAutoFillConfig({ ...ENV, MODELO_AUTO_FILL_ENABLED: "false" }).enabled, false);
    assert.equal(loadAutoFillConfig({ ...ENV, MODELO_TARGET_SPREADSHEET_ID: "" }).enabled, false);
    const c = loadAutoFillConfig(ENV);
    assert.deepEqual([c.enabled, c.chatIds, c.debounceMs], [true, [G], 60000]);
  });

  it("só o grupo listado dispara; desligado não agenda nada", () => {
    const t = fakeTimers();
    const runs: string[] = [];
    const on = createAutoFill({ config: loadAutoFillConfig(ENV), run: async (c) => void runs.push(c), log: () => undefined, timers: t.timers });
    assert.equal(on.trigger("outro@g.us", "2026-10"), false);
    assert.equal(on.trigger(undefined, "2026-10"), false);
    assert.equal(t.q.length, 0);
    const off = createAutoFill({ config: loadAutoFillConfig({ ...ENV, MODELO_AUTO_FILL_ENABLED: "false" }), run: async (c) => void runs.push(c), log: () => undefined, timers: t.timers });
    assert.equal(off.trigger(G, "2026-10"), false);
    assert.equal(t.q.length, 0);
  });

  it("agrupa rajada em 1 execução; durante a execução enfileira e não roda em paralelo", async () => {
    const t = fakeTimers();
    let active = 0;
    let maxActive = 0;
    const runs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const af = createAutoFill({
      config: loadAutoFillConfig(ENV),
      run: async (c) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        runs.push(c);
        if (runs.length === 1) await gate;
        active -= 1;
      },
      log: () => undefined,
      timers: t.timers,
    });
    for (let i = 0; i < 5; i += 1) af.trigger(G, "2026-10");
    assert.equal(t.q.length, 1); // um timer só
    const first = t.q[0]!();
    assert.equal(af.state.running, true);
    af.trigger(G, "2026-10"); // chega durante a execução
    release();
    await new Promise((r) => setTimeout(r, 10));
    void first;
    assert.deepEqual(runs, ["2026-10", "2026-10"]);
    assert.equal(maxActive, 1);
    assert.equal(af.state.running, false);
  });

  it("falha só loga e a fila continua", async () => {
    const logs: string[] = [];
    const t = fakeTimers();
    let n = 0;
    const af = createAutoFill({
      config: loadAutoFillConfig(ENV),
      run: async () => {
        n += 1;
        if (n === 1) throw new Error("sheets http 429");
      },
      log: (e) => logs.push(e),
      timers: t.timers,
    });
    af.trigger(G, "2026-10");
    af.trigger(G, "2026-09");
    await af.flush();
    assert.deepEqual(logs, ["auto_fill_failed", "auto_fill_done"]);
  });

  it("competência = mês do fato; sem fato, hoje (Brasília)", () => {
    const state = { records: [{ sourceMessageIds: ["m1"], despesa: { date: "2026-09-29" } }, { sourceMessageIds: ["m2"] }] } as never;
    assert.equal(factCompetencia(state, "m1"), "2026-09");
    assert.equal(factCompetencia(state, "m2", new Date("2026-11-01T01:00:00Z")), "2026-10");
    assert.equal(factCompetencia(state, undefined, new Date("2026-10-19T15:00:00Z")), "2026-10");
  });
});
