import type { AlibabaAsrConfig } from "./alibabaAsr.ts";

export type AsrRuntimeConfig = AlibabaAsrConfig & { enabled: boolean };

/**
 * ASR (Qwen/Alibaba). Só a string exata `true` em ASR_ENABLED liga.
 * A chave é a mesma do NLU (LLM_NLU_API_KEY); aqui só entram endpoint e modelo, que não são segredo.
 */
export function loadAsrConfig(env: NodeJS.Dict<string> = process.env): AsrRuntimeConfig {
  return {
    enabled: env.ASR_ENABLED === "true",
    baseUrl: env.ASR_BASE_URL?.trim() ?? "",
    model: env.ASR_MODEL?.trim() ?? "",
    apiKey: env.LLM_NLU_API_KEY?.trim() ?? "",
  };
}
