import type { AppState, StoredMessage } from "../domain/types.ts";
import {
  buildRascunhoFromState,
  checkSameValor,
  isOperationalStoreMessage,
  isManoelTfaRow,
  messageToRascunho,
  rascunhoKey,
  rascunhoValorNumber,
  recordToRascunho,
  type RascunhoRow,
} from "./rascunho.ts";

export type RascunhoIssue = {
  kind: "esquecido" | "duplicado" | "incompleto" | "valor_repetido";
  messageId: string;
  recordId: string;
  detail: string;
};

export type RascunhoValidation = {
  issues: RascunhoIssue[];
  forgotten: RascunhoIssue[];
  duplicates: RascunhoIssue[];
  incomplete: RascunhoIssue[];
  sameValue: RascunhoIssue[];
  promotable: RascunhoRow[];
  clean: boolean;
};

function brl(value: number): string {
  const [int, cents] = value.toFixed(2).split(".");
  return `R$ ${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${cents}`;
}

function dayMonth(row: RascunhoRow): string {
  const date = row.data_doc || row.enviado_em.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? `${date.slice(8, 10)}/${date.slice(5, 7)}` : "sem data";
}

function sameValueDetail(row: RascunhoRow, earlier: RascunhoRow[]): string {
  const valor = rascunhoValorNumber(row.valor);
  const money = valor !== undefined ? brl(valor) : row.valor;
  const check = checkSameValor(row, earlier);
  if (!check.peer || !check.verdict) return `${row.tipo} ${dayMonth(row)} com valor ${money} repetido no mês; confirmar antes de registrar`;
  return `${row.tipo} ${dayMonth(row)} com mesmo valor ${money} que ${check.peer.tipo} ${dayMonth(check.peer)} (${check.verdict.reason}); confirmar antes de registrar`;
}

function requiredMissing(row: RascunhoRow): string | undefined {
  if (row.tipo === "outro") return "tipo incerto";
  if (!row.competencia) return "mês ambíguo";
  if (row.tipo === "viagem") {
    if (!row.data_doc) return "foto sem data";
    if (!row.origem || !row.destino) return "origem/destino vazios";
    if (!row.valor && !row.toneladas) return "foto sem valor";
    return undefined;
  }
  if (!row.valor) return "foto sem valor";
  return undefined;
}

export function validateRascunho(input: {
  state: AppState;
  rows: RascunhoRow[];
  sessionStartedAt?: string;
}): RascunhoValidation {
  const issues: RascunhoIssue[] = [];
  const byMessage = new Map<string, RascunhoRow[]>();
  const byFingerprint = new Map<string, RascunhoRow[]>();
  for (const row of input.rows) {
    if (row.message_id) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push(row);
      byMessage.set(row.message_id, list);
    }
    const prints = byFingerprint.get(row.fingerprint) ?? [];
    prints.push(row);
    byFingerprint.set(row.fingerprint, prints);
  }

  const covered = new Set(input.rows.map((row) => row.message_id).filter(Boolean));
  const sessionMs = input.sessionStartedAt ? Date.parse(input.sessionStartedAt) : 0;
  const messages = input.state.messages.filter((item) => !sessionMs || Date.parse(item.sentAt) >= sessionMs);
  for (const message of messages) {
    if (!isOperationalStoreMessage(message, input.state.botIds)) continue;
    if (covered.has(message.externalId)) continue;
    const related = input.state.records.filter((record) => record.sourceMessageIds.includes(message.externalId));
    const manoelFromRecords = related.some((record) => {
      const row = recordToRascunho(input.state, record);
      return Boolean(row && isManoelTfaRow(row));
    });
    const orphan = related.length === 0 && isManoelTfaRow(messageToRascunho(input.state, message));
    if (!manoelFromRecords && !orphan) continue;
    issues.push({
      kind: "esquecido",
      messageId: message.externalId,
      recordId: "",
      detail: "mensagem operacional no store sem linha no rascunho",
    });
  }

  for (const [messageId, list] of byMessage) {
    const uniqueRecords = new Set(list.map((row) => row.record_id).filter(Boolean));
    if (list.length > 1 && uniqueRecords.size <= 1 && list.every((row) => !row.record_id)) {
      issues.push({
        kind: "duplicado",
        messageId,
        recordId: list[0]?.record_id ?? "",
        detail: "mesmo message_id duas vezes",
      });
    }
  }
  for (const [, list] of byFingerprint) {
    const ids = new Set(list.map((row) => row.message_id || row.record_id));
    if (list.length > 1 && ids.size > 1) {
      for (const row of list.filter((item) => item.status === "duplicado")) {
        issues.push({
          kind: "duplicado",
          messageId: row.message_id,
          recordId: row.record_id,
          detail: "mesma impressão digital com ids diferentes",
        });
      }
    }
  }

  for (const row of input.rows) {
    const missing = requiredMissing(row);
    if (row.status === "incompleto" || missing) {
      issues.push({
        kind: "incompleto",
        messageId: row.message_id,
        recordId: row.record_id,
        detail: missing || "campos obrigatórios vazios",
      });
    }
  }

  input.rows.forEach((row, index) => {
    if (row.status !== "confirmar") return;
    issues.push({
      kind: "valor_repetido",
      messageId: row.message_id,
      recordId: row.record_id,
      detail: sameValueDetail(row, input.rows.slice(0, index)),
    });
  });

  const blocked = new Set(
    input.rows
      .filter((row) => {
        if (row.status === "duplicado" || row.status === "incompleto" || row.status === "ignorado" || row.status === "confirmar") {
          return true;
        }
        return Boolean(requiredMissing(row));
      })
      .map(rascunhoKey),
  );

  const promotable = input.rows.filter((row) => isManoelTfaRow(row) && !blocked.has(rascunhoKey(row)));
  const forgotten = issues.filter((item) => item.kind === "esquecido");
  const duplicates = issues.filter((item) => item.kind === "duplicado");
  const incomplete = issues.filter((item) => item.kind === "incompleto");
  const sameValue = issues.filter((item) => item.kind === "valor_repetido");
  return {
    issues,
    forgotten,
    duplicates,
    incomplete,
    sameValue,
    promotable,
    clean: forgotten.length === 0,
  };
}

export function adminAlertText(issue: RascunhoIssue, competencia?: string): string {
  const month = competencia || "mês";
  const when = issue.detail.includes("sem valor") ? issue.detail : issue.detail;
  return `TFA ${month}: ${when} — conferir`.replace(/\s+/g, " ").trim();
}

export function alertsFromValidation(validation: RascunhoValidation, rows: RascunhoRow[]): string[] {
  const texts: string[] = [];
  const seen = new Set<string>();
  for (const issue of validation.issues) {
    if (issue.kind === "duplicado") continue;
    const row = rows.find((item) => item.message_id === issue.messageId || item.record_id === issue.recordId);
    const competencia = row?.competencia?.slice(5) || row?.competencia || "";
    const monthLabel = competencia
      ? ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"][
          Number(competencia.slice(-2)) - 1
        ] ?? competencia
      : "mês";
    let detail = issue.detail;
    if (issue.kind === "esquecido") detail = "mensagem operacional sem linha no rascunho";
    if (row?.source === "foto" && !row.valor) {
      const day = row.data_doc.slice(8, 10) || row.enviado_em.slice(8, 10);
      detail = `foto ${day}/${row.competencia.slice(5) || "??"} sem valor`;
    }
    const text = adminAlertText({ ...issue, detail }, monthLabel);
    if (seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return texts;
}

export function ensureRascunhoCoversStore(state: AppState, existing: RascunhoRow[], sessionStartedAt?: string) {
  return validateRascunho({
    state,
    rows: [...existing, ...buildRascunhoFromState(state, sessionStartedAt).filter((row) => !existing.some((item) => rascunhoKey(item) === rascunhoKey(row)))],
    sessionStartedAt,
  });
}

export function operationalMessages(state: AppState, sessionStartedAt?: string): StoredMessage[] {
  const sessionMs = sessionStartedAt ? Date.parse(sessionStartedAt) : 0;
  return state.messages.filter((item) => {
    if (sessionMs && Date.parse(item.sentAt) < sessionMs) return false;
    return isOperationalStoreMessage(item, state.botIds);
  });
}
