import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import { processMessage } from "../src/engine/process.ts";
import { fingerprint, maskJid } from "../src/inspect/mask.ts";
import { previewRecords } from "../src/inspect/records.ts";
import type { InboundMessage } from "../src/domain/types.ts";

const T0 = new Date("2026-09-14T20:53:46.000Z");

function msg(partial: Partial<InboundMessage> & Pick<InboundMessage, "externalId" | "text" | "sentAt">): InboundMessage {
  return {
    conversationId: "conv-joao",
    authorId: "motorista-joao",
    authorRole: "motorista",
    type: "texto",
    ...partial,
  };
}

describe("records preview", () => {
  it("masks JIDs and fingerprints without echoing the full value", () => {
    const jid = "5551999887766@g.us";
    assert.equal(maskJid(jid), "…7766@g.us");
    assert.equal(fingerprint(jid).length, 10);
    assert.equal(maskJid(jid).includes("5551999887766"), false);
  });

  it("keeps the exclusive-group complement on one recent complete record", () => {
    const state = seedState();
    processMessage(
      state,
      msg({
        externalId: "inc-1",
        text: "abasteci 150 litros, deu 980, assinada",
        sentAt: T0.toISOString(),
      }),
      { now: () => T0 },
    );
    processMessage(
      state,
      msg({
        externalId: "cmp-place",
        text: "isso, posto jacinto",
        sentAt: "2026-09-14T20:54:32.000Z",
      }),
      { now: () => new Date("2026-09-14T20:54:32.000Z") },
    );
    processMessage(
      state,
      msg({
        externalId: "cmp-date",
        text: "hoje",
        sentAt: "2026-09-14T20:54:40.000Z",
      }),
      { now: () => new Date("2026-09-14T20:54:40.000Z") },
    );

    const recent = previewRecords(state, {
      conversationId: "conv-joao",
      since: new Date("2026-09-14T20:50:00.000Z"),
    });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].kind, "abastecimento");
    assert.equal(recent[0].status, "completo");
    assert.equal(recent[0].place, "posto jacinto");
    assert.equal(recent[0].date, "2026-09-14");
    assert.equal(recent[0].sourceCount, 3);
    assert.equal(recent[0].payment, "assinada");

    const other = previewRecords(state, { conversationId: "conv-ana" });
    assert.equal(other.length, 0);

    const tooNew = previewRecords(state, {
      conversationId: "conv-joao",
      since: new Date("2026-09-15T00:00:00.000Z"),
    });
    assert.equal(tooNew.length, 0);
  });
});
