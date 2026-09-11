import { basename, dirname, join, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { seedState } from "../config/seed.ts";
import type { AppState, InboundMessage } from "../domain/types.ts";
import { considerResume, processMessage } from "../engine/process.ts";
import { saveState } from "../persistence/store.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export type Fixture = {
  now?: string;
  resumeAfterMs?: number;
  messages: InboundMessage[];
};

export type FixtureReport = {
  fixture: string;
  steps: unknown[];
  final: ReturnType<typeof summarize>;
  state: AppState;
};

function fixturePaths(file?: string): string[] {
  const dir = join(root, "fixtures");
  if (file) return [file.startsWith("/") ? file : join(root, file)];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

export function runFixtureData(fixture: Fixture, name = "inline"): FixtureReport {
  const state: AppState = seedState();
  let current = fixture.now
    ? new Date(fixture.now)
    : new Date(fixture.messages[0]?.sentAt ?? "2026-09-09T12:00:00.000Z");
  const clock = { now: () => current };
  const steps: unknown[] = [];

  for (const message of fixture.messages) {
    current = new Date(message.sentAt);
    const result = processMessage(state, message, clock);
    steps.push({
      input: {
        externalId: message.externalId,
        conversationId: message.conversationId,
        authorRole: message.authorRole,
        type: message.type,
        text: message.text,
        sentAt: message.sentAt,
      },
      clockNow: current.toISOString(),
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
    const lastSent = fixture.messages.at(-1)?.sentAt;
    const origin = lastSent ? new Date(lastSent) : current;
    current = new Date(origin.getTime() + fixture.resumeAfterMs);
    for (const conv of state.conversations.filter((c) => c.role === "motorista")) {
      const replies = considerResume(state, conv.id, clock);
      if (replies.length) steps.push({ silentResume: conv.id, replies, clockNow: current.toISOString() });
    }
  }

  return { fixture: name, steps, final: summarize(state), state };
}

export function runFixture(path: string): FixtureReport {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  return runFixtureData(fixture, basename(path));
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

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isCliEntry()) {
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
}
