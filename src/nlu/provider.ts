import { createFakeProvider } from "./fakeProvider.ts";
import { createLlmProvider, type LlmProviderHooks } from "./llmProvider.ts";
import { canCallRemoteLlm, loadNluConfig, type NluRuntimeConfig } from "./config.ts";
import type { NluProvider } from "./types.ts";

export type { NluProvider } from "./types.ts";
export type { NluRuntimeConfig } from "./config.ts";
export { canCallRemoteLlm, loadNluConfig };

export function createNluProvider(
  config: NluRuntimeConfig = loadNluConfig(),
  hooks: LlmProviderHooks = {},
): NluProvider | undefined {
  if (!config.enabled) return undefined;
  if (config.provider === "llm") return createLlmProvider(config, fetch, hooks);
  return createFakeProvider();
}
