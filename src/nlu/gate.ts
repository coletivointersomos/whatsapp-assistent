import { SENSITIVE_INTENTS, defaultActionForIntent, type NluResult } from "./types.ts";

export function gateSensitiveIntent(result: NluResult, isAdmin: boolean): NluResult {
  if (!SENSITIVE_INTENTS.has(result.intent)) return result;
  if (!isAdmin) {
    return {
      ...result,
      intent: "unknown",
      action: "none",
      confidence: Math.min(result.confidence, 0.2),
      requiresConfirmation: false,
      unsafeReason: "sensitive_not_admin",
      reply: undefined,
    };
  }
  const action =
    result.intent === "sheet_change_request"
      ? "block_sheets"
      : result.intent === "broadcast_request"
        ? "block_broadcast"
        : "request_confirmation";
  return {
    ...result,
    action: result.action === "none" ? defaultActionForIntent(result.intent) : action,
    requiresConfirmation: true,
  };
}
