import { basename, dirname, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedState } from "../config/seed.ts";
import type { AppState, InboundMessage } from "../domain/types.ts";
import { considerResume, processMessage } from "../engine/process.ts";
import { saveState } from "../persistence/store.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Fixture = {
  now?: string;
  resumeAfterMs?: number;
  messages: InboundMessage[];
};

function fixturePaths(file?: string): string[] {
  const dir = join(root, "fixtures");
  if (file) return [file.startsWith("/") ? file : join(root, file)];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

function runFixture(path: string) {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  const state: AppState = seedState();
  const baseNow = fixture.now ? new Date(fixture.now) : new Date("2026-09-09T12:00:00.000Z");
  let current = baseNow;
  const clock = { now: () => current };
  const steps: unknown[] = [];

  for (const message of fixture.messages) {
    const result = processMessage(state, message, clock);
    steps.push({
      input: {
        externalId: message.externalId,
        conversationId: message.conversationId,
        authorRole: message.authorRole,
        type: message.type,
        text: message.text,
      },
      decision: result.decision,
      duplicate: result.duplicate,
      record: result.record
        ? {
            kind: result.record.kind,
            status: result.record.status,
            missing: result.record.missing,
            abastecimento: result.record.abastecimento,
            despesa: result.record.despesa,
            viagem: result.record.viagem,
          }
        : undefined,
      replies: result.replies,
      pause: result.pause,
      suspension: result.suspension,
      command: result.command?.status,
      rejected: result.rejected?.reason,
    });
  }

  if (fixture.resumeAfterMs) {
    current = new Date(baseNow.getTime() + fixture.resumeAfterMs);
    for (const conv of state.conversations.filter((c) => c.role === "motorista")) {
      const replies = considerResume(state, conv.id, clock);
      if (replies.length) steps.push({ silentResume: conv.id, replies });
    }
  }

  return { fixture: basename(path), steps, final: summarize(state), state };
}

function summarize(state: AppState) {
  return {
    messageCount: state.messages.length,
    records: state.records.map((r) => ({ kind: r.kind, status: r.status, missing: r.missing })),
    pauses: state.pauses,
    suspensions: state.suspensions.map((s) => ({
      driverId: s.driverId,
      start: s.start,
      end: s.end,
      status: s.status,
    })),
    commands: state.commands.map((c) => c.status),
    rejected: state.rejected.length,
    botReplies: state.botReplies,
  };
}

const args = process.argv.slice(2);
const fileFlagIdx = args.indexOf("--file");
const fileArg = fileFlagIdx >= 0 ? args[fileFlagIdx + 1] : undefined;
const persist = args.includes("--persist");
const reports = fixturePaths(fileArg).map(runFixture);

console.log(
  JSON.stringify(
    reports.map(({ state: _s, ...rest }) => rest),
    null,
    2,
  ),
);

if (persist) {
  const last = reports.at(-1);
  if (last) saveState(join(root, "data/store.json"), last.state);
}
