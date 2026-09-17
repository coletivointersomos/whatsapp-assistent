import { dayIso, isPauseActive } from "../domain/rules.ts";
import type { AppState, InboundMessage } from "../domain/types.ts";
import { maskJid } from "../inspect/mask.ts";
import { lastBotText, lastStatusForConversation, lastTripForDriver } from "./status.ts";
import { localTotals } from "./totals.ts";
import type { ConversationContext, NluContext } from "./types.ts";

function driverName(state: AppState, driverId: string | undefined): string | undefined {
  if (!driverId) return undefined;
  return state.drivers.find((d) => d.id === driverId)?.name;
}

export function buildNluContext(
  state: AppState,
  inbound: Pick<InboundMessage, "text" | "conversationId" | "authorRole">,
  opts: {
    authorRole: NluContext["authorRole"];
    isAdmin: boolean;
    now: Date;
    driverId?: string;
  },
): ConversationContext {
  const pause = state.pauses.find((p) => p.conversationId === inbound.conversationId);
  const today = dayIso(opts.now);
  const todayTotals = localTotals(state, { date: today });
  const allTotals = localTotals(state, { now: opts.now });
  const driver = state.drivers.find((d) => d.id === opts.driverId);
  const trip = lastTripForDriver(state, opts.driverId);
  const status = lastStatusForConversation(state, inbound.conversationId);
  const openPendings = state.records
    .filter((r) => r.status === "incompleto" && (!opts.driverId || r.driverId === opts.driverId))
    .map((r) => `${r.id} ${r.kind} (${r.missing.join(", ") || "campos"})`);

  const recentMessages = state.messages
    .filter((m) => m.conversationId === inbound.conversationId)
    .slice(-8)
    .map((m) => `${m.authorRole}: ${(m.text ?? "").slice(0, 160)}`);
  const recentRecords = state.records.slice(-6).map((r) => {
    const date = r.abastecimento?.date ?? r.despesa?.date ?? r.viagem?.date ?? "";
    const extra =
      r.kind === "viagem"
        ? [r.viagem?.origin, r.viagem?.destination, r.viagem?.material].filter(Boolean).join(" ")
        : r.kind === "despesa"
          ? r.despesa?.description ?? ""
          : r.abastecimento?.place ?? "";
    return `${r.kind} ${r.status} ${date} ${extra}`.trim();
  });
  const recentExpenses = state.records
    .filter((r) => r.kind === "despesa")
    .slice(-6)
    .map((r) => {
      const name = driverName(state, r.driverId) ?? r.driverId;
      return `${name}: ${r.despesa?.description ?? "despesa"} ${r.despesa?.date ?? ""} R$ ${r.despesa?.amountBrl ?? "?"}`;
    });

  return {
    conversationMasked: maskJid(inbound.conversationId),
    authorRole: opts.authorRole,
    isAdmin: opts.isAdmin,
    paused: Boolean(pause && isPauseActive(pause.silenceUntil, opts.now)),
    message: inbound.text ?? "",
    driverName: driver?.name,
    driverId: opts.driverId,
    vehicle: driver?.vehicleHint,
    lastBotQuestion: lastBotText(state, inbound.conversationId),
    openPendings,
    recentMessages,
    recentRecords,
    recentExpenses,
    currentTrip: trip
      ? {
          recordId: trip.id,
          status: trip.status,
          origin: trip.viagem?.origin,
          destination: trip.viagem?.destination,
          material: trip.viagem?.material,
          quantity: trip.viagem?.quantity,
          unit: trip.viagem?.unit,
          date: trip.viagem?.date,
        }
      : undefined,
    lastStatusUpdate: status
      ? {
          text: status.text,
          sentAt: status.sentAt,
          driverName: driverName(state, status.driverId) ?? driver?.name,
        }
      : undefined,
    permissions: {
      canWriteRecords: true,
      canWriteSheets: false,
      canBroadcast: false,
    },
    totals: {
      asOfDate: today,
      fuelBrlToday: todayTotals.fuelBrl,
      expenseBrlToday: todayTotals.expenseBrl,
      pendingCount: allTotals.pendingCount,
    },
  };
}
