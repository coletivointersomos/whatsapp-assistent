import type { AppState } from "../domain/types.ts";
import type { SheetsWriteConfig } from "./config.ts";
import { readSheetValues, writeSheetGrid } from "./googleSheets.ts";
import { buildOficialSheet, groupPromotableByCompetencia, type OficialSheet } from "./oficial.ts";
import {
  buildRascunhoFromState,
  isManoelTfaRow,
  markFingerprintDuplicates,
  mergeRascunho,
  parseRascunhoGrid,
  rascunhoToValues,
  type RascunhoRow,
} from "./rascunho.ts";
import { alertsFromValidation, validateRascunho, type RascunhoValidation } from "./validate.ts";

export type PagamentoPlan = {
  merged: RascunhoRow[];
  toInsert: RascunhoRow[];
  validation: RascunhoValidation;
  oficial: OficialSheet[];
  alerts: string[];
  oficialReady: boolean;
};

export function planPagamento(input: {
  state: AppState;
  existing?: RascunhoRow[];
  sessionStartedAt?: string;
  commissionRate?: number;
}): PagamentoPlan {
  const incoming = buildRascunhoFromState(input.state, input.sessionStartedAt).filter(isManoelTfaRow);
  const existing = (input.existing ?? []).filter(isManoelTfaRow);
  const { merged: mergedRaw, toInsert } = mergeRascunho(existing, incoming);
  const merged = markFingerprintDuplicates(mergedRaw);
  const validation = validateRascunho({
    state: input.state,
    rows: merged,
    sessionStartedAt: input.sessionStartedAt,
  });
  const oficial: OficialSheet[] = [];
  for (const [competencia, rows] of groupPromotableByCompetencia(validation.promotable)) {
    oficial.push(
      buildOficialSheet({
        competencia,
        rows,
        commissionRate: input.commissionRate,
      }),
    );
  }
  const oficialReady = oficial.length > 0;
  return {
    merged,
    toInsert: toInsert.map((row) => merged.find((item) => item.record_id === row.record_id && item.message_id === row.message_id) ?? row),
    validation,
    oficial,
    alerts: alertsFromValidation(validation, merged),
    oficialReady,
  };
}

export async function writePagamentoToGoogleSheet(input: {
  state: AppState;
  config: SheetsWriteConfig;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  ok: true;
  rowCount: number;
  inserted: number;
  oficialTabs: string[];
  oficialWritten: boolean;
  alerts: string[];
  reason?: string;
}> {
  const existingValues = await readSheetValues({
    spreadsheetId: input.config.spreadsheetId,
    tabName: input.config.rascunhoTabName,
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
  });
  const existing = parseRascunhoGrid(existingValues);
  const plan = planPagamento({
    state: input.state,
    existing,
    commissionRate: input.config.commissionRate,
  });

  await writeSheetGrid({
    spreadsheetId: input.config.spreadsheetId,
    tabName: input.config.rascunhoTabName,
    accessToken: input.accessToken,
    values: rascunhoToValues(plan.merged),
    fetchImpl: input.fetchImpl,
  });

  const oficialTabs: string[] = [];
  if (plan.oficialReady) {
    for (const sheet of plan.oficial) {
      await writeSheetGrid({
        spreadsheetId: input.config.spreadsheetId,
        tabName: sheet.tabName,
        accessToken: input.accessToken,
        values: sheet.values,
        valueInputOption: "USER_ENTERED",
        cellFills: sheet.fills,
        fetchImpl: input.fetchImpl,
      });
      oficialTabs.push(sheet.tabName);
    }
  }

  return {
    ok: true,
    rowCount: plan.merged.length,
    inserted: plan.merged.length,
    oficialTabs,
    oficialWritten: plan.oficialReady,
    alerts: plan.alerts,
    reason: plan.oficialReady ? undefined : "rascunho_nao_limpo",
  };
}
