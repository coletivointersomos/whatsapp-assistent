import type { AppState, StoredMessage } from "../domain/types.ts";
import {
  buildRascunhoFromState,
  isOperationalStoreMessage,
  isManoelTfaRow,
  rascunhoKey,
  type RascunhoRow,
} from "./rascunho.ts";

export type RascunhoIssue = {
  kind: "esquecido" | "duplicado" | "incompleto";
  messageId: string;
  recordId: string;
  detail: string;
};

export type RascunhoValidation = {
  issues: RascunhoIssue[];
  forgotten: RascunhoIssue[];
  duplicates: RascunhoIssue[];
  incomplete: RascunhoIssue[];
  promotable: RascunhoRow[];
  clean: boolean;
};

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
      for (const row of list) {
        issues.push({
          kind: "duplicado",
          messageId: row.message_id,
          recordId: row.record_id,
          detail: "mesma impressão digital com ids diferentes",
        });
      }
    }
  }

  const duplicateKeys = new Set(
    issues.filter((item) => item.kind === "duplicado").map((item) => item.recordId || item.messageId),
  );
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

  const blocked = new Set(
    input.rows
      .filter((row) => {
        const key = rascunhoKey(row);
        if (row.status === "duplicado" || row.status === "incompleto" || row.status === "ignorado") return true;
        if (duplicateKeys.has(key) || duplicateKeys.has(row.record_id) || duplicateKeys.has(row.message_id)) return true;
        return Boolean(requiredMissing(row));
      })
      .map(rascunhoKey),
  );

  const promotable = input.rows.filter((row) => isManoelTfaRow(row) && !blocked.has(rascunhoKey(row)));
  const forgotten = issues.filter((item) => item.kind === "esquecido");
  const duplicates = issues.filter((item) => item.kind === "duplicado");
  const incomplete = issues.filter((item) => item.kind === "incompleto");
  return {
    issues,
    forgotten,
    duplicates,
    incomplete,
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
