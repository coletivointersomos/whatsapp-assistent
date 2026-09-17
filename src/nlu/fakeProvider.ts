import { validateNluResult } from "./schema.ts";
import type { NluContext, NluProvider, NluResult } from "./types.ts";

/** Provider de teste: devolve JSON fixo ou interpreta o texto se for JSON. */
export function createFakeProvider(preset?: unknown): NluProvider {
  return {
    name: "fake",
    interpret(context: NluContext): NluResult {
      if (preset !== undefined) return validateNluResult(preset);
      const text = context.message.trim();
      if (text.startsWith("{")) return validateNluResult(text);
      return validateNluResult({
        intent: "unknown",
        confidence: 0.2,
        reasoning_summary: "fake_default",
      });
    },
  };
}
