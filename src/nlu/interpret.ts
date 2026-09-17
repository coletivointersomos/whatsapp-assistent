import { formatFuelToday, formatPendings } from "./totals.ts";
import { composeIdentityReply, composeOperationalSummary, composeStatusAck, composeTripStatusReply } from "./compose.ts";
import { defaultActionForIntent, unknownNlu, type NluContext, type NluResult } from "./types.ts";

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

function result(
  partial: Omit<NluResult, "action"> & { action?: NluResult["action"] },
): NluResult {
  return {
    ...partial,
    action: partial.action ?? defaultActionForIntent(partial.intent),
  };
}

export function looksLikeDriverStatus(text: string): boolean {
  const n = norm(text);
  if (!n) return false;
  if (/\b(abastec|gastei|despesa|gasto extra|eletricista|frete|viagem)\b/.test(n)) return false;
  return (
    /\bestou (na|no|em)\b/.test(n) ||
    /\bcheguei\b/.test(n) ||
    /\bdescarregando\b/.test(n) ||
    /\bparei no posto\b/.test(n) ||
    /\batrasou\b/.test(n) ||
    /\bbr[\s-]?\d+/.test(n) ||
    /\bainda em\b/.test(n)
  );
}

function looksLikeIdentity(n: string): boolean {
  return (
    /\bquem e voce\b/.test(n) ||
    /\bo que voce faz\b/.test(n) ||
    /\bvoce me escuta\b/.test(n) ||
    n === "oi" ||
    n === "alo"
  );
}

function looksLikeTripQuestion(n: string): boolean {
  return (
    /\bonde estamos\b/.test(n) ||
    /\besta onde\b/.test(n) ||
    /\bqual (a )?viagem\b/.test(n) ||
    /\bviagem esta em andamento\b/.test(n) ||
    /\bqual a situacao\b/.test(n)
  );
}

function looksLikePending(n: string): boolean {
  return (
    (/\bpendenc/.test(n) || /\balgo pendente\b/.test(n)) &&
    !/\bmanda\b/.test(n) &&
    !/\bmensagem para todos\b/.test(n)
  );
}

function looksLikeSpend(n: string): boolean {
  return (
    /\bcombustivel\b/.test(n) ||
    (/\bquanto (deu|gastou|gastaram)\b/.test(n) && /\bhoje\b/.test(n)) ||
    /\bquanto gastou\b/.test(n)
  );
}

/** Interpretador local a partir do contexto (stand-in testável do LLM). */
export function interpretFromContext(context: NluContext): NluResult {
  const n = norm(context.message);
  if (!n) return unknownNlu("empty");

  if (!context.isAdmin && looksLikeDriverStatus(context.message)) {
    return result({
      intent: "driver_status_update",
      confidence: 0.82,
      reasoning_summary: "driver_free_text_status",
      fields: { text: context.message.trim() },
      reply: composeStatusAck(context),
    });
  }

  if (context.isAdmin && looksLikeIdentity(n)) {
    return result({
      intent: "bot_identity_question",
      confidence: 0.86,
      reasoning_summary: "identity_from_context",
      reply: composeIdentityReply(context),
    });
  }

  if (context.isAdmin && looksLikeTripQuestion(n)) {
    return result({
      intent: "trip_status_question",
      confidence: 0.88,
      reasoning_summary: "trip_from_context",
      reply: composeTripStatusReply(context),
    });
  }

  if (context.isAdmin && looksLikeSpend(n)) {
    return result({
      intent: "sheet_summary_request",
      confidence: 0.85,
      reasoning_summary: "fuel_total_local",
      reply: formatFuelToday(
        {
          fuelBrl: context.totals.fuelBrlToday,
          expenseBrl: context.totals.expenseBrlToday,
          combinedBrl: context.totals.fuelBrlToday + context.totals.expenseBrlToday,
          tripCount: 0,
          pendingCount: context.totals.pendingCount,
          pendingLines: context.openPendings,
        },
        context.totals.asOfDate,
      ),
    });
  }

  if (context.isAdmin && looksLikePending(n)) {
    return result({
      intent: "operational_summary_request",
      confidence: 0.85,
      reasoning_summary: "pending_from_context",
      reply: formatPendings({
        fuelBrl: context.totals.fuelBrlToday,
        expenseBrl: context.totals.expenseBrlToday,
        combinedBrl: context.totals.fuelBrlToday + context.totals.expenseBrlToday,
        tripCount: 0,
        pendingCount: context.totals.pendingCount,
        pendingLines: context.openPendings,
      }),
    });
  }

  if (context.isAdmin && (/\btodos os motoristas\b/.test(n) || /\bmensagem para todos\b/.test(n) || /\bmanda mensagem\b/.test(n))) {
    return result({
      intent: "broadcast_request",
      confidence: 0.8,
      reasoning_summary: "broadcast_blocked",
      requiresConfirmation: true,
      reply:
        "Posso preparar um pedido de pendências para os motoristas, mas não envio mensagem em massa. Precisa confirmação e ativação explícita.",
    });
  }

  if (context.isAdmin && /\bcoluna\b/.test(n) && /\bobserv/.test(n)) {
    return result({
      intent: "sheet_change_request",
      confidence: 0.8,
      reasoning_summary: "sheet_schema_blocked",
      requiresConfirmation: true,
      reply:
        "Isso entra como solicitação de alteração da planilha (coluna observação). Não altero o Sheets real daqui; posso só preparar o pedido.",
    });
  }

  if (context.isAdmin && /\bmotorista\b/.test(n) && (/\bgasto\b/.test(n) || /\bmotor\b/.test(n))) {
    const found = context.recentExpenses.find((line) => /motor/i.test(line));
    return result({
      intent: "ask_driver_followup",
      confidence: 0.7,
      reasoning_summary: "local_lookup_or_ask",
      requiresConfirmation: true,
      reply: found
        ? `Encontrei despesa local: ${found}. Posso perguntar ao motorista se você confirmar.`
        : "Não encontrei confirmação local desse gasto. Posso perguntar ao motorista se você confirmar.",
    });
  }

  if (context.isAdmin && (/\bqual a situacao\b/.test(n) || n === "situacao")) {
    return result({
      intent: "operational_summary_request",
      confidence: 0.8,
      reasoning_summary: "ops_summary",
      reply: composeOperationalSummary(context),
    });
  }

  return unknownNlu("no_local_match");
}
