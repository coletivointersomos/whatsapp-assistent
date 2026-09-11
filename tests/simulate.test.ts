import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runFixtureData } from "../src/cli/simulate.ts";

describe("simulate", () => {
  it("processes each message with clock.now() equal to that message sentAt", () => {
    const report = runFixtureData(
      {
        now: "2026-09-09T18:00:00.000Z",
        messages: [
          {
            externalId: "a1",
            conversationId: "conv-joao",
            authorId: "alana",
            authorRole: "alana",
            sentAt: "2026-09-09T12:00:00.000Z",
            type: "texto",
            text: "já vi aqui",
          },
          {
            externalId: "d1",
            conversationId: "conv-joao",
            authorId: "motorista-joao",
            authorRole: "motorista",
            sentAt: "2026-09-09T12:05:00.000Z",
            type: "texto",
            text: "abasteci 150 litros, deu 980, assinada",
          },
        ],
      },
      "sentAt-clock",
    );

    const steps = report.steps as Array<{ clockNow?: string; pause?: { silenceUntil: string }; replies: unknown[] }>;
    assert.equal(steps[0].clockNow, "2026-09-09T12:00:00.000Z");
    assert.equal(steps[0].pause?.silenceUntil, "2026-09-09T12:15:00.000Z");
    assert.equal(steps[1].clockNow, "2026-09-09T12:05:00.000Z");
    assert.equal(steps[1].replies.length, 0);
  });
});
