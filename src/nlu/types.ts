export const NLU_INTENTS = [
  "record_event",
  "complete_record",
  "admin_question",
  "sheet_summary_request",
  "sheet_change_request",
  "broadcast_request",
  "ask_driver_followup",
  "driver_status_update",
  "trip_status_question",
  "bot_identity_question",
  "operational_summary_request",
  "smalltalk",
  "unknown",
] as const;

export type NluIntentName = (typeof NLU_INTENTS)[number];

export const NLU_ACTIONS = [
  "none",
  "reply",
  "create_record",
  "update_record",
  "complete_record",
  "store_status_update",
  "answer_question",
  "sheet_summary",
  "sheet_change_request",
  "broadcast_request",
  "ask_driver_followup",
  "request_confirmation",
  "block",
  "block_sheets",
  "block_broadcast",
  "unknown",
] as const;

export type NluActionName = (typeof NLU_ACTIONS)[number];

export type NluFields = Record<string, string | number>;

export type NluRecordType = "abastecimento" | "despesa" | "viagem";

export type NluResult = {
  intent: NluIntentName;
  action: NluActionName;
  confidence: number;
  reasoning_summary: string;
  fields?: NluFields;
  recordType?: NluRecordType;
  target?: string;
  targetRecordId?: string;
  reply?: string;
  missingFields?: string[];
  isComplete?: boolean;
  planCorrection?: string;
  requiresConfirmation?: boolean;
  unsafeReason?: string;
};

export type NluAuthorRole = "alana" | "motorista" | "bot" | "desconhecido";

export type ConversationTripContext = {
  recordId: string;
  status: string;
  origin?: string;
  destination?: string;
  material?: string;
  quantity?: number;
  unit?: string;
  date?: string;
};

export type ConversationStatusContext = {
  text: string;
  sentAt: string;
  driverName?: string;
};

export type ConversationContext = {
  conversationMasked: string;
  authorRole: NluAuthorRole;
  isAdmin: boolean;
  paused: boolean;
  message: string;
  driverName?: string;
  driverId?: string;
  vehicle?: string;
  lastBotQuestion?: string;
  /** Pendências ativas (< 30 min). Não usar como alvo automático se vazia. */
  openPendings: string[];
  /** Pendências velhas, só resumo — não são o foco da mensagem atual. */
  openRecordsSummary?: string[];
  recentMessages: string[];
  recentRecords: string[];
  recentExpenses: string[];
  currentTrip?: ConversationTripContext;
  lastStatusUpdate?: ConversationStatusContext;
  permissions: {
    canWriteRecords: boolean;
    canWriteSheets: boolean;
    canBroadcast: boolean;
  };
  totals: {
    asOfDate: string;
    fuelBrlToday: number;
    expenseBrlToday: number;
    pendingCount: number;
  };
};

/** Alias estável para o provider. */
export type NluContext = ConversationContext;

export const SENSITIVE_INTENTS: ReadonlySet<NluIntentName> = new Set([
  "sheet_change_request",
  "broadcast_request",
  "ask_driver_followup",
]);

export type NluProvider = {
  name: string;
  interpret(context: NluContext): NluResult | Promise<NluResult>;
};

export function defaultActionForIntent(intent: NluIntentName): NluActionName {
  if (intent === "record_event") return "create_record";
  if (intent === "complete_record") return "update_record";
  if (intent === "driver_status_update") return "store_status_update";
  if (intent === "sheet_summary_request") return "sheet_summary";
  if (intent === "sheet_change_request") return "block_sheets";
  if (intent === "broadcast_request") return "block_broadcast";
  if (intent === "ask_driver_followup") return "request_confirmation";
  if (intent === "smalltalk") return "reply";
  if (
    intent === "admin_question" ||
    intent === "trip_status_question" ||
    intent === "bot_identity_question" ||
    intent === "operational_summary_request"
  ) {
    return "answer_question";
  }
  if (intent === "unknown") return "none";
  return "reply";
}

export function isUsableLlmResult(result: NluResult): boolean {
  if (result.unsafeReason === "sensitive_not_admin") return false;
  if (result.intent === "unknown" && (result.action === "none" || result.action === "unknown")) return false;
  if (result.action === "unknown" || result.action === "none") return false;
  if (result.confidence < 0.45) return false;
  return true;
}

export function unknownNlu(reason = "invalid_or_empty"): NluResult {
  return {
    intent: "unknown",
    action: "none",
    confidence: 0,
    reasoning_summary: reason,
  };
}
