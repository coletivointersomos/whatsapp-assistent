import type { NluContext } from "./types.ts";

export function composeIdentityReply(context: NluContext): string {
  const who = context.driverName
    ? `nesta conversa com ${context.driverName}`
    : "nesta conversa";
  const caps = [
    "registrar abastecimento, despesa e viagem",
    "guardar atualização operacional da viagem",
    "responder com registros e totais locais",
  ];
  const limits: string[] = [];
  if (!context.permissions.canBroadcast) limits.push("não envio mensagem em massa");
  if (!context.permissions.canWriteSheets) limits.push("não altero planilha real");
  return `Sou o assistente operacional ${who}. Posso ${caps.join(", ")}. ${limits.join("; ")}.`;
}

export function composeTripStatusReply(context: NluContext): string {
  const driver = context.driverName ?? "o motorista";
  const trip = context.currentTrip;
  const update = context.lastStatusUpdate;
  if (trip && update) {
    const cargo = trip.material ? ` com ${trip.material}` : "";
    const from = trip.origin ? ` do ${trip.origin}` : "";
    const to = trip.destination ? ` para ${trip.destination}` : "";
    return `Estamos acompanhando a viagem do ${driver}${cargo}${from}${to}. A última atualização dele foi que ${update.text}`;
  }
  if (update) {
    return `Última atualização operacional de ${driver}: ${update.text}`;
  }
  if (trip) {
    const cargo = trip.material ? ` (${trip.material})` : "";
    const route = [trip.origin, trip.destination].filter(Boolean).join(" → ");
    return `Viagem atual de ${driver}${cargo}${route ? `: ${route}` : ""}. Ainda não há atualização de posição.`;
  }
  return composeOperationalSummary(context);
}

export function composeOperationalSummary(context: NluContext): string {
  const bits: string[] = [];
  if (context.driverName) bits.push(`motorista ${context.driverName}`);
  if (context.currentTrip) {
    const t = context.currentTrip;
    bits.push(`viagem ${[t.origin, t.destination].filter(Boolean).join(" → ") || "em aberto"}`);
  }
  if (context.lastStatusUpdate) bits.push(`última atualização: ${context.lastStatusUpdate.text}`);
  if (context.totals.pendingCount > 0) {
    bits.push(`${context.totals.pendingCount} pendência(s): ${context.openPendings.slice(0, 3).join("; ")}`);
  } else {
    bits.push("sem pendências abertas");
  }
  bits.push(`combustível local hoje R$ ${context.totals.fuelBrlToday}`);
  return `Situação local: ${bits.join(". ")}.`;
}

export function composeStatusAck(context: NluContext): string {
  const trip = context.currentTrip;
  if (trip?.origin && trip.destination) {
    return `Anotei sua atualização na viagem ${trip.origin} → ${trip.destination}.`;
  }
  return "Anotei sua atualização operacional da viagem.";
}
