import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideSend, isAdminPrivateChat, isGroupLikeJid } from "../src/runtime/sendGate.ts";
import { createOpenWaSender } from "../src/adapters/hermes/openwaSend.ts";
import type { RuntimeConfig } from "../src/runtime/config.ts";

const ADMIN = "5500000006176@c.us";
const DESTS = ["grupo@g.us", "120363000000000000@g.us", "lista@broadcast", "status@broadcast", "canal@newsletter", "outro@c.us", ADMIN];
const conversations = DESTS.map((conversationId) => ({ conversationId, role: "motorista" as const }));
function rt(p: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return { liveSend: true, sessionId: "s", testGroupJid: "grupo@g.us", adminAlertJid: ADMIN,
    channel: { sessionId: "s", testGroupJid: "grupo@g.us", adminIds: [], botIds: [], conversations }, ...p } as RuntimeConfig;
}
const proc = { duplicate: false, replies: [{ text: "oi" }] } as never;

describe("2g send gate", () => {
  it("blocks groups, broadcast lists, status and channels; only private == ADMIN_ALERT_JID passes", () => {
    for (const d of DESTS) {
      const r = decideSend({ runtime: rt(), conversationId: d, sessionId: "s", process: proc } as never);
      if (d === ADMIN) assert.equal(r.allowed, true, d);
      else assert.equal(r.allowed, false, d);
    }
    for (const g of ["grupo@g.us", "lista@broadcast", "status@broadcast", "canal@newsletter"]) assert.equal(isGroupLikeJid(g), true);
  });
  it("blocks everything when ADMIN_ALERT_JID is empty or is itself a group", () => {
    assert.equal(decideSend({ runtime: rt({ adminAlertJid: "" }), conversationId: ADMIN, sessionId: "s", process: proc } as never).allowed, false);
    assert.equal(isAdminPrivateChat("grupo@g.us", "grupo@g.us"), false);
  });
  it("blocks when LIVE_SEND=false", () => {
    assert.equal(decideSend({ runtime: rt({ liveSend: false }), conversationId: ADMIN, sessionId: "s", process: proc } as never).allowed, false);
  });
  it("sender itself refuses group-like JIDs without calling fetch", async () => {
    let calls = 0;
    const s = createOpenWaSender({ baseUrl: "http://x", sendPath: "/p/{sessionId}", apiKey: "", apiKeyHeader: "x", fetchImpl: (async () => { calls++; return new Response("{}"); }) as never } as never);
    for (const g of ["grupo@g.us", "lista@broadcast", "status@broadcast", "canal@newsletter"]) {
      const r = await s.sendText({ sessionId: "s", chatId: g, text: "t" });
      assert.equal(r.ok, false);
    }
    assert.equal(calls, 0);
  });
});
