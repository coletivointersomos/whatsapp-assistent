import { expenseDateFollowup, questionForMissing } from "../extraction/command.ts";
import type { OperationalRecord } from "../domain/types.ts";
import type { AssistantV2Outcome } from "./execute.ts";
import { lastSessionTrip, parseSessionStart, sessionRecords } from "./session.ts";
import type { AppState, Conversation } from "../domain/types.ts";

const BLOCKED_REPLY = "Posso preparar isso, mas preciso de confirmação antes de executar.";

function titlePlace(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function completeRecordReply(record: OperationalRecord): string {
  if (record.kind === "viagem") {
    const v = record.viagem ?? {};
    const origin = titlePlace(v.origin ?? "");
    const destination = titlePlace(v.destination ?? "");
    const qtyBit = [v.quantity !== undefined ? `${v.quantity}` : "", v.unit ?? ""].filter(Boolean).join(" ");
    return `Fechado, registrei a viagem de ${origin} para ${destination} com ${v.material ?? ""}, ${qtyBit}.`;
  }
  if (record.kind === "despesa") {
    const d = record.despesa ?? {};
    const pay =
      d.payment === "pix"
        ? " no pix"
        : d.payment === "assinada"
          ? " como assinada"
          : d.payment === "pago"
            ? " pago"
            : d.payment
              ? ` no ${d.payment}`
              : "";
    return `Fechado, registrei a despesa de R$ ${d.amountBrl ?? "?"} com ${d.description ?? "despesa"}${pay}.`;
  }
  return "Fechado, registrei esse abastecimento.";
}

function incompleteRecordReply(record: OperationalRecord): string {
  if (record.kind === "despesa" && record.missing.includes("date") && !record.missing.includes("amountBrl")) {
    return expenseDateFollowup(record.despesa?.description, record.despesa?.amountBrl, record.despesa?.payment);
  }
  const origin = record.viagem?.origin ? titlePlace(record.viagem.origin) : undefined;
  const destination = record.viagem?.destination ? titlePlace(record.viagem.destination) : undefined;
  return questionForMissing(record.kind, record.missing, {
    description: record.despesa?.description,
    amountBrl: record.despesa?.amountBrl,
    payment: record.despesa?.payment,
    origin,
    destination,
  });
}

function statusReply(state: AppState, conversation: Conversation, sessionStartedAt?: string, llmMessage?: string): string {
  const trip = lastSessionTrip(sessionRecords(state, conversation, parseSessionStart(sessionStartedAt)));
  const origin = trip?.viagem?.origin ? titlePlace(trip.viagem.origin) : undefined;
  const destination = trip?.viagem?.destination ? titlePlace(trip.viagem.destination) : undefined;
  const fallback = origin && destination
    ? `Anotei a atualização da viagem ${origin} → ${destination}.`
    : "Anotei a atualização da viagem.";
  if (llmMessage?.trim() && !/qual foi a carga|posso registrar/i.test(llmMessage)) {
    if (origin && llmMessage.toLowerCase().includes(origin.toLowerCase())) return llmMessage.trim();
  }
  return fallback;
}

export function composeV2Reply(input: {
  state: AppState;
  conversation: Conversation;
  outcome: AssistantV2Outcome;
  llmMessage: string;
  sessionStartedAt?: string;
}): string {
  const { state, conversation, outcome, llmMessage, sessionStartedAt } = input;
  const sensitiveBlocked = outcome.blocked.some(
    (item) =>
      item.type === "broadcast.request" ||
      item.type === "sheet.change.request" ||
      item.type === "ask_driver.request",
  );
  const spoken = llmMessage.trim();
  if (sensitiveBlocked) return BLOCKED_REPLY;
  if (outcome.summary?.trim()) return outcome.summary.trim();
  if (outcome.record?.status === "completo") return spoken || completeRecordReply(outcome.record);
  if (outcome.record?.status === "incompleto") return incompleteRecordReply(outcome.record);
  if (spoken) return spoken;
  if (outcome.statusCreated) return statusReply(state, conversation, sessionStartedAt, llmMessage);
  if (outcome.summary?.trim()) return outcome.summary.trim();
  return "";
}
