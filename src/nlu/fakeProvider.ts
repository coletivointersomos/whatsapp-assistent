import { interpretFromContext } from "./interpret.ts";
import { validateNluResult } from "./schema.ts";
import type { NluContext, NluProvider, NluResult } from "./types.ts";

/** Provider local: JSON de teste, senão interpreta a partir do contexto. Sem rede. */
export function createFakeProvider(preset?: unknown): NluProvider {
  return {
    name: "fake",
    interpret(context: NluContext): NluResult {
      if (preset !== undefined) return validateNluResult(preset);
      const text = context.message.trim();
      if (text.startsWith("{")) return validateNluResult(text);
      return interpretFromContext(context);
    },
  };
}
