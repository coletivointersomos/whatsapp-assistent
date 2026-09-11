import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCentralCommand } from "../src/extraction/command.ts";

describe("parseCentralCommand", () => {
  it("parses an explicit suspension", () => {
    const parsed = parseCentralCommand(
      "suspender motorista João de 2026-09-10 até 2026-09-15",
    );
    assert.equal(parsed.ambiguous, false);
    if (parsed.ambiguous || parsed.type !== "suspend") throw new Error("expected suspend");
    assert.equal(parsed.driverName, "João");
    assert.equal(parsed.start, "2026-09-10");
    assert.equal(parsed.end, "2026-09-15");
  });

  it("asks for clarification when suspender is incomplete", () => {
    const parsed = parseCentralCommand("suspender João");
    assert.equal(parsed.ambiguous, true);
    assert.equal(parsed.type, "ambiguous");
  });

  it("ignores ordinary chat that is not a command", () => {
    for (const text of ["oi", "obrigada", "beleza"]) {
      const parsed = parseCentralCommand(text);
      assert.equal(parsed.type, "none");
      assert.equal(parsed.ambiguous, false);
    }
  });
});
