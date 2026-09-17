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
  "unknown",
] as const;

export type NluIntentName = (typeof NLU_INTENTS)[number];

export const NLU_ACTIONS = [
  "none",
  "reply",
  "store_status_update",
  "request_confirmation",
  "block_sheets",
  "block_broadcast",
] as const;

export type NluActionName = (typeof NLU_ACTIONS)[number];

export type NluFields = Record<string, string | number>;

export type NluResult = {
  intent: NluIntentName;
  action: NluActionName;
  confidence: number;
  reasoning_summary: string;
  fields?: NluFields;
  target?: string;
  reply?: string;
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
  openPendings: string[];
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
  if (intent === "driver_status_update") return "store_status_update";
  if (intent === "sheet_change_request") return "block_sheets";
  if (intent === "broadcast_request") return "block_broadcast";
  if (intent === "ask_driver_followup") return "request_confirmation";
  if (intent === "unknown") return "none";
  return "reply";
}

export function unknownNlu(reason = "invalid_or_empty"): NluResult {
  return {
    intent: "unknown",
    action: "none",
    confidence: 0,
    reasoning_summary: reason,
  };
}
