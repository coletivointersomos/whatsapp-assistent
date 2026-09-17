import { isPauseActive } from "../domain/rules.ts";
import type { AppState, InboundMessage, OperationalRecord } from "../domain/types.ts";
import { maskJid } from "../inspect/mask.ts";
import { localTotals, type LocalTotals } from "./totals.ts";
import type { NluContext } from "./types.ts";

function lastIncomplete(
  state: AppState,
  conversationId: string,
  driverId: string | undefined,
): OperationalRecord | undefined {
  if (!driverId) return undefined;
  const matches = state.records.filter((record) => {
    if (record.status !== "incompleto" || record.driverId !== driverId) return false;
    return record.sourceMessageIds.some((id) => {
      const message = state.messages.find((item) => item.externalId === id);
      return message?.conversationId === conversationId;
    });
  });
  return matches[matches.length - 1];
}

export function buildNluContext(
  state: AppState,
  inbound: Pick<InboundMessage, "text" | "conversationId" | "authorRole">,
  opts: {
    authorRole: NluContext["authorRole"];
    isAdmin: boolean;
    now: Date;
    driverId?: string;
    pending?: OperationalRecord;
  },
): NluContext {
  const pause = state.pauses.find((p) => p.conversationId === inbound.conversationId);
  const pending =
    opts.pending ?? lastIncomplete(state, inbound.conversationId, opts.driverId);
  const totals: LocalTotals = localTotals(state, { now: opts.now });
  const recentMessages = state.messages
    .filter((m) => m.conversationId === inbound.conversationId)
    .slice(-6)
    .map((m) => `${m.authorRole}: ${(m.text ?? "").slice(0, 120)}`);
  const recentRecords = state.records.slice(-5).map((r) => {
    const date = r.abastecimento?.date ?? r.despesa?.date ?? r.viagem?.date ?? "";
    return `${r.kind} ${r.status} ${date}`.trim();
  });

  return {
    authorRole: opts.authorRole,
    isAdmin: opts.isAdmin,
    paused: Boolean(pause && isPauseActive(pause.silenceUntil, opts.now)),
    message: inbound.text ?? "",
    conversationMasked: maskJid(inbound.conversationId),
    recentMessages,
    pending: pending
      ? {
          recordId: pending.id,
          kind: pending.kind,
          status: pending.status,
          missing: [...pending.missing],
        }
      : undefined,
    recentRecords,
    totals: {
      fuelBrlToday: localTotals(state, { date: opts.now.toISOString().slice(0, 10) }).fuelBrl,
      expenseBrlToday: localTotals(state, { date: opts.now.toISOString().slice(0, 10) }).expenseBrl,
      pendingCount: totals.pendingCount,
    },
  };
}
