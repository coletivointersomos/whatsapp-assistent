import type { ConversationContext } from "../nlu/types.ts";

export type AssistantRecordType = "abastecimento" | "despesa" | "viagem";

export type AssistantAction =
  | {
      type: "record.create";
      recordType: AssistantRecordType;
      fields: Record<string, unknown>;
      missingFields: string[];
    }
  | {
      type: "record.update";
      recordId: string;
      fields: Record<string, unknown>;
      missingFields?: string[];
    }
  | {
      type: "status.create";
      driverId?: string;
      tripRecordId?: string;
      text: string;
    }
  | {
      type: "summary.query";
      scope: "fuel" | "expenses" | "trips" | "pending" | "general";
      period?: string;
    }
  | {
      type: "sheet.change.request";
      description: string;
    }
  | {
      type: "broadcast.request";
      audience: "drivers" | "all";
      text: string;
    }
  | {
      type: "ask_driver.request";
      driverId?: string;
      question: string;
    };

export type AssistantResponse = {
  message: string;
  actions: AssistantAction[];
  needsConfirmation?: boolean;
  confidence: number;
  notes?: string;
};

export type AssistantContext = ConversationContext & {
  allowedActions: string[];
  blockedActions: string[];
  requiresConfirmationFor: string[];
  limits: string[];
};

export type AssistantProvider = {
  name: string;
  interpret(context: AssistantContext): AssistantResponse | Promise<AssistantResponse>;
};

export function emptyAssistant(reason: string): AssistantResponse {
  return {
    message: "",
    actions: [],
    confidence: 0,
    notes: reason,
  };
}

export function isUsableAssistantResponse(result: AssistantResponse): boolean {
  if (result.confidence < 0.45) return false;
  if (!result.message.trim() && result.actions.length === 0) return false;
  if (result.notes === "invalid_json" || result.notes === "llm_failed" || result.notes?.startsWith("llm_http")) {
    return false;
  }
  return true;
}
