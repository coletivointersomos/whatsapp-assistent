import type { MessageSender } from "../adapters/hermes/openwaSend.ts";
import type { AppState } from "../domain/types.ts";
import type { RuntimeConfig } from "../runtime/config.ts";
import { dispatchAdminAlerts } from "./adminAlert.ts";
import type { SheetsWriteConfig } from "./config.ts";
import { planPagamento } from "./pagamento.ts";
import type { RascunhoRow } from "./rascunho.ts";

export function planGroupSweep(input: {
  state: AppState;
  existing?: RascunhoRow[];
  sessionStartedAt?: string;
  commissionRate?: number;
}) {
  return planPagamento(input);
}

export async function runGroupSweep(input: {
  runtime: RuntimeConfig;
  state: AppState;
  sheets: SheetsWriteConfig;
  sender: MessageSender;
  existing?: RascunhoRow[];
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<{ alerts: string[]; pending: number; sent: number; incomplete: number }> {
  const plan = planGroupSweep({
    state: input.state,
    existing: input.existing,
    sessionStartedAt: input.sheets.sessionStartedAt,
    commissionRate: input.sheets.commissionRate,
  });
  input.log?.("sheets_sweep", {
    incomplete: plan.validation.incomplete.length,
    forgotten: plan.validation.forgotten.length,
    duplicates: plan.validation.duplicates.length,
    alerts: plan.alerts.length,
  });
  const dispatch = await dispatchAdminAlerts({
    runtime: input.runtime,
    adminJid: input.sheets.adminAlertJid || input.runtime.adminAlertJid,
    texts: plan.alerts,
    sender: input.sender,
    log: input.log,
  });
  return {
    alerts: plan.alerts,
    pending: dispatch.pending,
    sent: dispatch.sent,
    incomplete: plan.validation.incomplete.length,
  };
}
