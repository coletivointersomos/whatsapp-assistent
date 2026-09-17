export type NluRuntimeConfig = {
  enabled: boolean;
  provider: "fake" | "rules" | "llm";
  model: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
};

export function loadNluConfig(env: NodeJS.Dict<string> = process.env): NluRuntimeConfig {
  const providerRaw = (env.LLM_NLU_PROVIDER ?? "fake").trim().toLowerCase();
  const provider: NluRuntimeConfig["provider"] =
    providerRaw === "llm" ? "llm" : providerRaw === "rules" ? "rules" : "fake";
  const timeout = Number(env.LLM_NLU_TIMEOUT_MS ?? 8000);
  return {
    enabled: env.LLM_NLU_ENABLED === "true",
    provider,
    model: env.LLM_NLU_MODEL?.trim() ?? "",
    apiKey: env.LLM_NLU_API_KEY ?? "",
    baseUrl: env.LLM_NLU_BASE_URL?.trim() ?? "",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 8000,
  };
}

export function canCallRemoteLlm(config: NluRuntimeConfig): boolean {
  return config.enabled && config.provider === "llm" && Boolean(config.apiKey?.trim() && config.baseUrl);
}
