import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runFixture, runFixtureData } from "../src/cli/simulate.ts";

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
            text: "deixa comigo",
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

  it("runs the conversational demo fixture end to end", () => {
    const path = join(fileURLToPath(new URL(".", import.meta.url)), "../fixtures/demo-conversa-fluida.json");
    const report = runFixture(path);
    const steps = report.steps as Array<{
      decision: string;
      replies: Array<{ text: string }>;
      record?: { kind: string; status: string };
    }>;

    assert.equal(steps[0].decision, "record_incomplete");
    assert.equal(steps[0].replies[0]?.text, "Foi hoje? E qual foi o posto?");

    assert.equal(steps[1].decision, "record_created");
    assert.equal(steps[1].record?.kind, "abastecimento");
    assert.equal(steps[1].record?.status, "completo");
    assert.equal(steps[1].replies[0]?.text, "Fechado, registrei esse abastecimento.");

    assert.equal(steps[2].decision, "pause_updated");
    assert.equal(steps[2].replies.length, 0);

    assert.equal(steps[3].decision, "record_created");
    assert.equal(steps[3].record?.kind, "despesa");
    assert.equal(steps[3].record?.status, "completo");
    assert.equal(steps[3].replies.length, 0);

    assert.equal(report.final.records.length, 2);
    assert.equal(report.final.records[0].kind, "abastecimento");
    assert.equal(report.final.records[0].status, "completo");
    assert.equal(report.final.records[1].kind, "despesa");
    assert.equal(report.final.records[1].status, "completo");
  });
});
