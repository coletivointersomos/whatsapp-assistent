import { maskJid } from "../inspect/mask.ts";
import type { AppState, Conversation, InboundMessage } from "../domain/types.ts";
import type { AssistantV2Context } from "./types.ts";
import {
  activeOfKind,
  lastSessionStatus,
  lastSessionTrip,
  parseSessionStart,
  sessionMessages,
  sessionRecords,
  toSessionView,
} from "./session.ts";

export function buildAssistantV2Context(input: {
  state: AppState;
  inbound: Pick<InboundMessage, "text" | "conversationId">;
  conversation: Conversation;
  authorRole: "admin" | "motorista";
  sessionStartedAt?: string;
}): AssistantV2Context {
  const sessionStartedAtMs = parseSessionStart(input.sessionStartedAt);
  const records = sessionRecords(input.state, input.conversation, sessionStartedAtMs);
  const activeTrip = activeOfKind(records, "viagem") ?? lastSessionTrip(records);
  const activeExpense = activeOfKind(records, "despesa");
  const activeFuel = activeOfKind(records, "abastecimento");
  const driver = input.state.drivers.find((item) => item.id === input.conversation.driverId);
  const recent = sessionMessages(input.state, input.conversation, sessionStartedAtMs)
    .slice(-8)
    .map((item) => ({
      role: item.authorRole === "alana" ? "admin" : item.authorRole,
      text: (item.text ?? "").slice(0, 240),
    }));
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
    driver: driver ? { id: driver.id, name: driver.name } : undefined,
    vehicle: driver?.vehicleHint,
    recentMessages: recent,
    sessionRecords: records.map(toSessionView),
    activeTrip: activeTrip ? toSessionView(activeTrip) : undefined,
    activeExpense: activeExpense ? toSessionView(activeExpense) : undefined,
    activeFuel: activeFuel ? toSessionView(activeFuel) : undefined,
    lastStatusUpdate: lastStatus
      ? { text: lastStatus.text, tripRecordId: lastStatus.tripRecordId }
      : undefined,
    totals: {
      fuelBrl,
      expenseBrl,
      tripCount,
      pendingCount: records.filter((item) => item.status === "incompleto").length,
    },
    capabilities: [
      "registrar abastecimento, despesa, viagem e status",
      "resumo local da sessão atual",
      "não envia broadcast sem confirmação",
      "não altera Google Sheets real",
    ],
    allowedActions: ["record.create", "record.update", "status.create", "summary.query"],
    blockedActions: ["broadcast.request", "sheet.change.request", "ask_driver.request"],
    message: input.inbound.text ?? "",
  };
}
