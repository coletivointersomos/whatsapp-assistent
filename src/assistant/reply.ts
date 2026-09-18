import { lastTripForDriver } from "../nlu/status.ts";
import { expenseDateFollowup, questionForMissing } from "../extraction/command.ts";
import type { AppState, OperationalRecord } from "../domain/types.ts";
import type { ActionOutcome } from "./execute.ts";

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
    const material = v.material ?? "";
    const qty = v.quantity !== undefined ? `${v.quantity}` : "";
    const unit = v.unit ?? "";
    const qtyBit = [qty, unit].filter(Boolean).join(" ");
    return `Fechado, registrei a viagem de ${origin} para ${destination} com ${material}, ${qtyBit}.`;
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
  return questionForMissing(record.kind, record.missing, {
    description: record.despesa?.description,
    amountBrl: record.despesa?.amountBrl,
    payment: record.despesa?.payment,
    origin: record.viagem?.origin,
    destination: record.viagem?.destination,
  });
}

function statusReply(state: AppState, conversationDriverId: string | undefined): string {
  const trip = lastTripForDriver(state, conversationDriverId);
  const origin = trip?.viagem?.origin;
  const destination = trip?.viagem?.destination;
  if (origin && destination) return `Anotei a atualização da viagem ${origin} → ${destination}.`;
  return "Anotei a atualização da viagem.";
}

export function composeFinalReplyFromOutcome(input: {
  state: AppState;
  conversationDriverId?: string;
  outcome: ActionOutcome;
  llmMessage: string;
  summaryFallback?: string;
}): string {
  const { state, conversationDriverId, outcome, llmMessage, summaryFallback } = input;
  const sensitiveBlocked = outcome.blocked.some((item) =>
    item.type === "broadcast.request" || item.type === "sheet.change.request" || item.type === "ask_driver.request",
  );

  if (outcome.record?.status === "completo") return completeRecordReply(outcome.record);
  if (outcome.record?.status === "incompleto") return incompleteRecordReply(outcome.record);
  if (outcome.statusCreated) return statusReply(state, conversationDriverId);
  if (sensitiveBlocked) return BLOCKED_REPLY;
  if (summaryFallback?.trim()) return summaryFallback.trim();
  return llmMessage.trim();
}
