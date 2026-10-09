import { basename, dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { applyChannelConfig } from "../adapters/hermes/config.ts";
import { normalizeOpenWaEnvelope } from "../adapters/hermes/normalize.ts";
import type { ChannelConfig, OpenWaEnvelope } from "../adapters/hermes/types.ts";
import { seedState } from "../config/seed.ts";
import { processMessage } from "../engine/process.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

type HermesFixture = {
  channelFile?: string;
  envelopes: OpenWaEnvelope[];
};

function loadJson<T>(relOrAbs: string): T {
  const path = relOrAbs.startsWith("/") || /^[A-Za-z]:/.test(relOrAbs) ? relOrAbs : join(root, relOrAbs);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function runHermesDryRun(fixtureRel: string) {
  const fixture = loadJson<HermesFixture>(fixtureRel);
  const channelRel = fixture.channelFile ?? "config/channel.example.json";
  const channel = loadJson<ChannelConfig>(channelRel);
  const state = applyChannelConfig(seedState(), channel);
  const steps: unknown[] = [];

  for (const envelope of fixture.envelopes) {
    const normalized = normalizeOpenWaEnvelope(envelope, channel);
    if (!normalized.ok) {
      steps.push({
        skipped: true,
        reason: normalized.reason,
        chatId: envelope.data?.chatId,
        sessionId: envelope.sessionId,
        event: envelope.event,
      });
      continue;
    }
    const inbound = normalized.inbound;
    const clock = { now: () => new Date(inbound.sentAt) };
    const result = processMessage(state, inbound, clock);
    steps.push({
      skipped: false,
      inbound: {
        externalId: inbound.externalId,
        conversationId: inbound.conversationId,
        authorId: inbound.authorId,
        authorRole: inbound.authorRole,
        type: inbound.type,
        text: inbound.text,
        sentAt: inbound.sentAt,
      },
      decision: result.decision,
      duplicate: result.duplicate,
      record: result.record
        ? {
            kind: result.record.kind,
            status: result.record.status,
            missing: result.record.missing,
          }
        : undefined,
      replies: result.replies,
      rejected: result.rejected?.reason,
      outbound: "dry-run (WhatsApp send disabled)",
    });
  }

  return {
    fixture: basename(fixtureRel),
    channel: channelRel,
    sessionId: channel.sessionId,
    authorizedConversations: channel.conversations.map((c) => c.conversationId),
    steps,
    outbound: "disabled",
  };
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isCliEntry()) {
  const args = process.argv.slice(2);
  const fileFlagIdx = args.indexOf("--file");
  const files =
    fileFlagIdx >= 0 && args[fileFlagIdx + 1]
      ? [args[fileFlagIdx + 1]]
      : ["fixtures/hermes/grupo-teste.json", "fixtures/hermes/multi-conversas.json"];
  const reports = files.map(runHermesDryRun);
  console.log(JSON.stringify(reports, null, 2));
}
