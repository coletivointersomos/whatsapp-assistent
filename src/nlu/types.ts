export const NLU_INTENTS = [
  "record_event",
  "complete_record",
  "admin_question",
  "sheet_summary_request",
  "sheet_change_request",
  "broadcast_request",
  "ask_driver_followup",
  "smalltalk",
  "unknown",
] as const;

export type NluIntentName = (typeof NLU_INTENTS)[number];

export type NluFields = Record<string, string | number>;

export type NluResult = {
  intent: NluIntentName;
  confidence: number;
  reasoning_summary: string;
  fields?: NluFields;
  target?: string;
  reply?: string;
  requiresConfirmation?: boolean;
  unsafeReason?: string;
};

export type NluAuthorRole = "alana" | "motorista" | "bot" | "desconhecido";

export type NluContext = {
  authorRole: NluAuthorRole;
  isAdmin: boolean;
  paused: boolean;
  message: string;
  conversationMasked: string;
  recentMessages: string[];
  pending?: {
    recordId: string;
    kind: string;
    status: string;
    missing: string[];
  };
  recentRecords: string[];
  totals: {
    fuelBrlToday: number;
    expenseBrlToday: number;
    pendingCount: number;
  };
};

export const SENSITIVE_INTENTS: ReadonlySet<NluIntentName> = new Set([
  "sheet_change_request",
  "broadcast_request",
  "ask_driver_followup",
]);

export type NluProvider = {
  name: string;
  interpret(context: NluContext): NluResult | Promise<NluResult>;
};

export function unknownNlu(reason = "invalid_or_empty"): NluResult {
  return {
    intent: "unknown",
    confidence: 0,
    reasoning_summary: reason,
  };
}
