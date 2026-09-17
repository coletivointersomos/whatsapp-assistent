import { maskJid } from "../inspect/mask.ts";
import type { AppState, Conversation, InboundMessage } from "../domain/types.ts";
import type { AssistantV2Context } from "./types.ts";
import { looksOperationalV2 } from "./fallback.ts";
import {
  activeOfKind,
  lastSessionStatus,
  parseSessionStart,
  sessionMessages,
  sessionRecords,
  toSessionView,
} from "./session.ts";

export function buildAssistantV2Context(input: {
  state: AppState;
  inbound: Pick<InboundMessage, "text" | "conversationId">;
  conversation: Conversation;
  authorRole: "admin" | "motorista" | "participante";
  sessionStartedAt?: string;
}): AssistantV2Context {
  const sessionStartedAtMs = parseSessionStart(input.sessionStartedAt);
  const records = sessionRecords(input.state, input.conversation, sessionStartedAtMs);
  const activeTrip = activeOfKind(records, "viagem");
  const activeExpense = activeOfKind(records, "despesa");
  const activeFuel = activeOfKind(records, "abastecimento");
  const hasPending = Boolean(activeTrip || activeExpense || activeFuel);
  const operational = looksOperationalV2(input.inbound.text ?? "", hasPending);
  const driver = input.state.drivers.find((item) => item.id === input.conversation.driverId);
  const recent = operational
    ? sessionMessages(input.state, input.conversation, sessionStartedAtMs)
        .slice(-8)
        .map((item) => ({
          role: item.authorRole === "alana" ? "admin" : item.authorRole,
          text: (item.text ?? "").slice(0, 240),
        }))
    : [];
  const tripIds = new Set(records.filter((item) => item.kind === "viagem").map((item) => item.id));
  const lastStatus = lastSessionStatus(input.state, input.conversation, sessionStartedAtMs, tripIds);
  let fuelBrl = 0;
  let expenseBrl = 0;
  let tripCount = 0;
  for (const record of records) {
    if (record.kind === "abastecimento") fuelBrl += Number(record.abastecimento?.totalBrl ?? 0);
    if (record.kind === "despesa") expenseBrl += Number(record.despesa?.amountBrl ?? 0);
    if (record.kind === "viagem") tripCount += 1;
  }
  return {
    conversationId: maskJid(input.conversation.id),
    authorRole: input.authorRole,
    recordOwner: operational && driver ? { id: driver.id, vehicle: driver.vehicleHint } : undefined,
    vehicle: operational ? driver?.vehicleHint : undefined,
    recentMessages: recent,
    sessionRecords: operational ? records.map(toSessionView) : [],
    activeTrip: operational && activeTrip ? toSessionView(activeTrip) : undefined,
    activeExpense: operational && activeExpense ? toSessionView(activeExpense) : undefined,
    activeFuel: operational && activeFuel ? toSessionView(activeFuel) : undefined,
    lastStatusUpdate:
      operational && lastStatus ? { text: lastStatus.text, tripRecordId: lastStatus.tripRecordId } : undefined,
    totals: operational
      ? {
          fuelBrl,
          expenseBrl,
          tripCount,
          pendingCount: records.filter((item) => item.status === "incompleto").length,
        }
      : { fuelBrl: 0, expenseBrl: 0, tripCount: 0, pendingCount: 0 },
    capabilities: [
      "conversar sobre a mensagem atual, qualquer assunto",
      "não continuar assunto antigo se a pessoa mudou de tema",
      "registrar viagem/despesa/abastecimento/status só quando a mensagem atual for operacional",
    ],
    allowedActions: ["record.create", "record.update", "status.create", "summary.query"],
    blockedActions: ["broadcast.request", "sheet.change.request", "ask_driver.request"],
    message: input.inbound.text ?? "",
    currentUserMessage: input.inbound.text ?? "",
  };
}
