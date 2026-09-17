import { SENSITIVE_INTENTS, type NluResult } from "./types.ts";

export function gateSensitiveIntent(result: NluResult, isAdmin: boolean): NluResult {
  if (!SENSITIVE_INTENTS.has(result.intent)) return result;
  if (!isAdmin) {
    return {
      ...result,
      intent: "unknown",
      confidence: Math.min(result.confidence, 0.2),
      requiresConfirmation: false,
      unsafeReason: "sensitive_not_admin",
      reply: undefined,
    };
  }
  return {
    ...result,
    requiresConfirmation: true,
  };
}
