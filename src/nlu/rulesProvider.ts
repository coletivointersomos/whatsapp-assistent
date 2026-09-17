import { formatFuelToday, formatPendings, findLocalExpense, localTotals } from "./totals.ts";
import { dayIso } from "../domain/rules.ts";
import type { AppState } from "../domain/types.ts";
import type { NluContext, NluResult } from "./types.ts";

function norm(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[?!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchAdminOperational(
  text: string,
  state: AppState,
  now: Date,
): NluResult | undefined {
  const n = norm(text);
  if (!n) return undefined;

  if (
    n === "oi" ||
    n === "alo" ||
    n === "oi voce me escuta" ||
    n === "voce me escuta" ||
    n.includes("voce me escuta")
  ) {
    return {
      intent: "smalltalk",
      confidence: 0.9,
      reasoning_summary: "admin_hello",
      reply: "Estou aqui e te escuto. Pode perguntar totais, pendências ou o que falta nos registros.",
    };
  }

  if (n === "onde estamos" || n === "ajuda") {
    return {
      intent: "admin_question",
      confidence: 0.9,
      reasoning_summary: "admin_status",
      reply:
        "Estou acompanhando este grupo. Posso registrar abastecimentos, despesas e viagens, e pedir o que faltar.",
    };
  }

  if (n.includes("combustivel") || (n.includes("quanto deu") && n.includes("hoje"))) {
    const date = dayIso(now);
    const totals = localTotals(state, { date });
    return {
      intent: "sheet_summary_request",
      confidence: 0.85,
      reasoning_summary: "fuel_total_local",
      reply: formatFuelToday(totals, date),
    };
  }

  if (n.includes("pendencia") && !n.includes("manda") && !n.includes("mensagem para todos")) {
    return {
      intent: "admin_question",
      confidence: 0.85,
      reasoning_summary: "pending_list",
      reply: formatPendings(localTotals(state, { now })),
    };
  }

  if (
    n.includes("todos os motoristas") ||
    n.includes("mensagem para todos") ||
    n.includes("manda mensagem")
  ) {
    return {
      intent: "broadcast_request",
      confidence: 0.8,
      reasoning_summary: "broadcast_blocked",
      requiresConfirmation: true,
      reply:
        "Posso preparar um pedido de pendências para os motoristas, mas não envio mensagem em massa. Precisa confirmação e ativação explícita.",
    };
  }

  if (n.includes("coluna") && n.includes("observ")) {
    return {
      intent: "sheet_change_request",
      confidence: 0.8,
      reasoning_summary: "sheet_schema_blocked",
      requiresConfirmation: true,
      reply:
        "Isso entra como solicitação de alteração da planilha (coluna observação). Não altero o Sheets real daqui; posso só preparar o pedido.",
    };
  }

  if (/\bmotorista\b/.test(n) && (/\bgasto\b/.test(n) || /\bmotor\b/.test(n))) {
    return {
      intent: "ask_driver_followup",
      confidence: 0.7,
      reasoning_summary: "local_lookup_or_ask",
      requiresConfirmation: true,
      reply: findLocalExpense(state, { text, now, driverHint: "joão" }),
    };
  }

  return undefined;
}

export function matchDriverOperational(context: NluContext): NluResult | undefined {
  const n = norm(context.message);
  if (context.pending && n.length > 0 && n.length < 40) {
    return {
      intent: "complete_record",
      confidence: 0.55,
      reasoning_summary: "short_pending_reply",
      fields: {},
    };
  }
  return undefined;
}
