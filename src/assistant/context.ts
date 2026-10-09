import { lastStatusForConversation, lastTripForDriver } from "../nlu/status.ts";
import { buildNluContext } from "../nlu/context.ts";
import type { AppState, InboundMessage } from "../domain/types.ts";
import type { NluAuthorRole } from "../nlu/types.ts";
import type { AssistantContext } from "./types.ts";

export function buildAssistantContext(
  state: AppState,
  inbound: Pick<InboundMessage, "text" | "conversationId" | "authorRole">,
  opts: {
    authorRole: NluAuthorRole;
    isAdmin: boolean;
    now: Date;
    driverId?: string;
  },
): AssistantContext {
  const base = buildNluContext(state, inbound, opts);
  let currentTrip = base.currentTrip;
  let lastStatusUpdate = base.lastStatusUpdate;
  if (opts.isAdmin && !opts.driverId) {
    const lastTrip = [...state.records].reverse().find((r) => r.kind === "viagem");
    if (lastTrip) {
      const trip = lastTripForDriver(state, lastTrip.driverId) ?? lastTrip;
      currentTrip = {
        recordId: trip.id,
        status: trip.status,
        origin: trip.viagem?.origin,
        destination: trip.viagem?.destination,
        material: trip.viagem?.material,
        quantity: trip.viagem?.quantity,
        unit: trip.viagem?.unit,
        date: trip.viagem?.date,
      };
    }
    const lastStatus = [...(state.statusUpdates ?? [])].at(-1);
    if (lastStatus) {
      lastStatusUpdate = {
        text: lastStatus.text,
        sentAt: lastStatus.sentAt,
        driverName: state.drivers.find((d) => d.id === lastStatus.driverId)?.name,
      };
    } else if (inbound.conversationId) {
      lastStatusUpdate = lastStatusForConversation(state, inbound.conversationId)
        ? base.lastStatusUpdate
        : lastStatusUpdate;
    }
  }
  return {
    ...base,
    currentTrip,
    lastStatusUpdate,
    allowedActions: opts.isAdmin
      ? ["record.create", "record.update", "status.create", "summary.query"]
      : ["record.create", "record.update", "status.create"],
    blockedActions: ["broadcast.request", "sheet.change.request", "ask_driver.request"],
    requiresConfirmationFor: ["broadcast.request", "sheet.change.request", "ask_driver.request"],
    limits: [
      "não envia broadcast",
      "não altera Google Sheets real",
      "totais vêm só de registros locais",
      "pendência antiga não é alvo automático",
    ],
  };
}
