export type AssistantV2RecordType = "abastecimento" | "despesa" | "viagem";

export type AssistantV2Action =
  | {
      type: "record.create";
      recordType: AssistantV2RecordType;
      fields: Record<string, unknown>;
    }
  | {
      type: "record.update";
      recordId?: string;
      recordType?: AssistantV2RecordType;
      fields: Record<string, unknown>;
    }
  | {
      type: "status.create";
      text: string;
      tripRecordId?: string;
    }
  | {
      type: "summary.query";
      scope: "fuel" | "expenses" | "trips" | "pending" | "general";
    }
  | {
      type: "broadcast.request";
      audience: "drivers" | "all";
      text: string;
    }
  | {
      type: "sheet.change.request";
      description: string;
    }
  | {
      type: "ask_driver.request";
      driverId?: string;
      question: string;
    };

export type AssistantV2Response = {
  message: string;
  actions: AssistantV2Action[];
  confidence: number;
  needsConfirmation?: boolean;
  notes?: string;
};

export type AssistantV2SessionRecord = {
  recordId: string;
  kind: AssistantV2RecordType;
  status: string;
  origin?: string;
  destination?: string;
  material?: string;
  quantity?: number;
  unit?: string;
  description?: string;
  amountBrl?: number;
  payment?: string;
  missing: string[];
};

export type AssistantV2Context = {
  conversationId: string;
  authorRole: "admin" | "motorista" | "participante";
  /** Dono interno do registro da conversa. NÃO é quem está falando. Não cumprimentar com esse id. */
  recordOwner?: { id: string; vehicle?: string };
  vehicle?: string;
  recentMessages: Array<{ role: string; text: string }>;
  sessionRecords: AssistantV2SessionRecord[];
  activeTrip?: AssistantV2SessionRecord;
  activeExpense?: AssistantV2SessionRecord;
  activeFuel?: AssistantV2SessionRecord;
  lastStatusUpdate?: { text: string; tripRecordId?: string };
  totals: { fuelBrl: number; expenseBrl: number; tripCount: number; pendingCount: number };
  capabilities: string[];
  allowedActions: string[];
  blockedActions: string[];
  message: string;
};

export type AssistantV2Provider = {
  name: string;
  interpret(context: AssistantV2Context): AssistantV2Response | Promise<AssistantV2Response>;
};

export type AssistantV2Config = {
  enabled: boolean;
  sessionStartedAt?: string;
};

export function emptyAssistantV2(reason: string): AssistantV2Response {
  return { message: "", actions: [], confidence: 0, notes: reason };
}

export function isUsableAssistantV2(result: AssistantV2Response): boolean {
  if (result.confidence < 0.45) return false;
  if (!result.message.trim() && result.actions.length === 0) return false;
  if (result.notes === "invalid_json" || result.notes === "llm_failed" || result.notes?.startsWith("llm_http")) {
    return false;
  }
  return true;
}
